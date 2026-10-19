import os
import secrets
import json
import getpass
import base64
import sqlite3
from pathlib import Path
from io import BytesIO
import click
from datetime import datetime, timezone
from functools import wraps
from urllib.parse import urljoin, urlparse

from flask import (Flask, abort, flash, jsonify, redirect, render_template,
                   request, send_from_directory, session, url_for)
from flask_login import (LoginManager, UserMixin, current_user, login_required,
                         login_user, logout_user)
from flask_sqlalchemy import SQLAlchemy
from flask_wtf.csrf import CSRFError, CSRFProtect
from sqlalchemy import func, inspect, text
from sqlalchemy.orm import joinedload, selectinload
from sqlalchemy.exc import IntegrityError
from markupsafe import Markup, escape
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
import pyotp
import qrcode
from cryptography.fernet import Fernet, InvalidToken

load_dotenv()

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
app = Flask(__name__)
if os.environ.get('APP_ENV', 'development').lower() == 'production':
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

_secret = os.environ.get('SECRET_KEY')
if not _secret or _secret.startswith('replace-with-'):
    raise RuntimeError('Set a unique SECRET_KEY in your private .env file before starting Plato.')

app.config.update(
    SECRET_KEY=_secret,
    SQLALCHEMY_DATABASE_URI=os.environ.get('DATABASE_URL', 'sqlite:///plato.db'),
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=os.environ.get('COOKIE_SECURE') == '1',  # set on HTTPS
    WTF_CSRF_TIME_LIMIT=None,  # token lasts as long as the session
)

# Instructors need an invite code, set INSTRUCTOR_INVITE_CODE to enable signup.
INSTRUCTOR_INVITE_CODE = os.environ.get('INSTRUCTOR_INVITE_CODE', '')
if INSTRUCTOR_INVITE_CODE.startswith('replace-with-'):
    INSTRUCTOR_INVITE_CODE = ''
PEPPER = os.environ.get('PASSWORD_PEPPER', '')
if not PEPPER or PEPPER.startswith('replace-with-'):
    raise RuntimeError('Set a unique PASSWORD_PEPPER in your private .env file before starting Plato.')

_totp_key = os.environ.get('TOTP_ENCRYPTION_KEY', '')
if not _totp_key:
    raise RuntimeError('Set TOTP_ENCRYPTION_KEY in your private .env file before starting Plato.')
try:
    TOTP_CIPHER = Fernet(_totp_key.encode('ascii'))
except (ValueError, UnicodeEncodeError):
    raise RuntimeError('TOTP_ENCRYPTION_KEY must be a valid Fernet key.')
_backup_key = os.environ.get('BACKUP_ENCRYPTION_KEY', '')
try:
    BACKUP_CIPHER = Fernet(_backup_key.encode('ascii'))
except (ValueError, UnicodeEncodeError):
    raise RuntimeError('Set BACKUP_ENCRYPTION_KEY to a valid Fernet key in your private .env file.')

db = SQLAlchemy(app)
csrf = CSRFProtect(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.session_protection = 'strong'

TITLE_MAX = 200
DESCRIPTION_MAX = 2000
PASSWORD_MIN = 12


def utcnow():
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    role = db.Column(db.String(20), default='student')
    is_deleted = db.Column(db.Boolean, default=False)
    deleted_at = db.Column(db.DateTime)
    totp_secret = db.Column(db.String(512))
    totp_enabled = db.Column(db.Boolean, nullable=False, default=False)
    auth_version = db.Column(db.Integer, nullable=False, default=1)

    @property
    def is_active(self):
        return not self.is_deleted

    def set_password(self, password):
        self.password_hash = generate_password_hash(password + PEPPER)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password + PEPPER)


class Course(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text)
    instructor_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    instructor = db.relationship('User', backref='courses')
    lessons = db.relationship('Lesson', backref='course', lazy=True,
                              cascade='all, delete-orphan', order_by='Lesson.id')
    enrollments = db.relationship('Enrollment', backref='course', lazy=True,
                                  cascade='all, delete-orphan')


class Lesson(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    content = db.Column(db.Text)
    course_id = db.Column(db.Integer, db.ForeignKey('course.id'), nullable=False)
    progress = db.relationship('LessonProgress', backref='lesson', lazy=True,
                               cascade='all, delete-orphan')


class Enrollment(db.Model):
    __table_args__ = (db.UniqueConstraint('student_id', 'course_id'),)
    id = db.Column(db.Integer, primary_key=True)
    student_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    course_id = db.Column(db.Integer, db.ForeignKey('course.id'), nullable=False)


class LessonProgress(db.Model):
    __table_args__ = (db.UniqueConstraint('student_id', 'lesson_id'),)
    id = db.Column(db.Integer, primary_key=True)
    student_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    lesson_id = db.Column(db.Integer, db.ForeignKey('lesson.id'), nullable=False)
    completed_at = db.Column(db.DateTime, default=utcnow)


class AppSetting(db.Model):
    key = db.Column(db.String(80), primary_key=True)
    value = db.Column(db.String(20), nullable=False)


class ConfigBackup(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    snapshot = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)


DEFAULT_SETTINGS = {
    'registration_enabled': 'true',
    'instructor_signup_enabled': 'true',
}


def get_setting(key):
    row = db.session.get(AppSetting, key)
    return row.value if row else DEFAULT_SETTINGS[key]


def save_setting(key, value):
    row = db.session.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key)
        db.session.add(row)
    row.value = 'true' if value else 'false'


def current_app_settings():
    return {key: get_setting(key) == 'true' for key in DEFAULT_SETTINGS}


@login_manager.user_loader
def load_user(user_id):
    try:
        user = db.session.get(User, int(user_id))
        if (user and user.is_active and
                session.get('auth_version') == user.auth_version):
            return user
        return None
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def wants_json():
    best = request.accept_mimetypes.best_match(['application/json', 'text/html'])
    return best == 'application/json' or request.is_json


def respond(message, redirect_to, ok=True, status=200, **extra):
    """Redirect with a flash for normal requests, JSON for fetch() calls."""
    if wants_json():
        return jsonify({('message' if ok else 'error'): message, **extra}), status
    flash(message, 'success' if ok else 'error')
    return redirect(redirect_to)


def is_safe_url(target):
    if not target:
        return False
    ref = urlparse(request.host_url)
    test = urlparse(urljoin(request.host_url, target))
    return test.scheme in ('http', 'https') and ref.netloc == test.netloc


def clean_title(value):
    value = (value or '').strip()
    return value if 0 < len(value) <= TITLE_MAX else None


def clean_description(value):
    value = (value or '').strip()
    return value if len(value) <= DESCRIPTION_MAX else None


def instructor_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if current_user.role != 'instructor':
            flash('Only instructors can do that', 'error')
            return redirect(url_for('dashboard'))
        return view(*args, **kwargs)
    return login_required(wrapper)


def owned_course_or_403(course_id):
    course = db.get_or_404(Course, course_id)
    if course.instructor_id != current_user.id:
        abort(403)
    return course


def is_enrolled(user, course_id):
    return (user.is_authenticated and user.role == 'student' and
            Enrollment.query.filter_by(student_id=user.id,
                                       course_id=course_id).first() is not None)


def progress_for(user_id, course_ids):
    """{course_id: {done, total, percent}} using two grouped queries."""
    course_ids = list(course_ids)
    if not course_ids:
        return {}
    totals = dict(db.session.query(Lesson.course_id, func.count(Lesson.id))
                  .filter(Lesson.course_id.in_(course_ids))
                  .group_by(Lesson.course_id).all())
    done = dict(db.session.query(Lesson.course_id, func.count(LessonProgress.id))
                .join(LessonProgress, LessonProgress.lesson_id == Lesson.id)
                .filter(LessonProgress.student_id == user_id,
                        Lesson.course_id.in_(course_ids))
                .group_by(Lesson.course_id).all())
    result = {}
    for cid in course_ids:
        total, finished = totals.get(cid, 0), done.get(cid, 0)
        result[cid] = {'done': finished, 'total': total,
                       'percent': round(100 * finished / total) if total else 0}
    return result


def lesson_markup(text):
    """Render a small safe Markdown subset used by lesson content."""
    lines = (text or '').splitlines()
    output, paragraph, list_items, code_lines = [], [], [], []
    in_code = False

    def flush_paragraph():
        if paragraph:
            output.append('<p>' + ' '.join(str(escape(x)) for x in paragraph) + '</p>')
            paragraph.clear()

    def flush_list():
        if list_items:
            output.append('<ul>' + ''.join('<li>' + str(escape(x)) + '</li>' for x in list_items) + '</ul>')
            list_items.clear()

    for line in lines:
        if line.strip().startswith('```'):
            flush_paragraph()
            flush_list()
            if in_code:
                output.append('<pre><code>' + str(escape('\n'.join(code_lines))) + '</code></pre>')
                code_lines.clear()
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_lines.append(line)
        elif not line.strip():
            flush_paragraph()
            flush_list()
        elif line.startswith('# '):
            flush_paragraph(); flush_list()
            output.append('<h3>' + str(escape(line[2:].strip())) + '</h3>')
        elif line.startswith('## '):
            flush_paragraph(); flush_list()
            output.append('<h4>' + str(escape(line[3:].strip())) + '</h4>')
        elif line.startswith('- '):
            flush_paragraph()
            list_items.append(line[2:].strip())
        else:
            flush_list()
            paragraph.append(line.strip())
    if in_code:
        output.append('<pre><code>' + str(escape('\n'.join(code_lines))) + '</code></pre>')
    flush_paragraph()
    flush_list()
    return Markup(''.join(output))


app.jinja_env.filters['lesson_markup'] = lesson_markup


# --------------------------------------------------------------------------
# Error handling and headers
# --------------------------------------------------------------------------
@login_manager.unauthorized_handler
def unauthorized():
    if wants_json():
        return jsonify(error='Please log in to continue'), 401
    flash('Please log in to continue', 'error')
    return redirect(url_for('login', next=request.path))


@app.errorhandler(403)
def forbidden(_):
    if wants_json():
        return jsonify(error='You are not allowed to do that'), 403
    flash('You are not allowed to do that', 'error')
    return redirect(url_for('dashboard') if current_user.is_authenticated
                    else url_for('index'))


@app.errorhandler(CSRFError)
def csrf_error(_):
    msg = 'Your session expired. Reload the page and try again.'
    if wants_json():
        return jsonify(error=msg), 400
    flash(msg, 'error')
    back = request.referrer if is_safe_url(request.referrer) else url_for('index')
    return redirect(back)


@app.after_request
def security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if request.is_secure:
        response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    return response


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
@app.route('/')
def index():
    courses = (Course.query.options(selectinload(Course.lessons),
                                    joinedload(Course.instructor))
               .order_by(Course.id.desc()).all())
    return render_template('index.html', courses=courses)


@app.get('/healthz')
def health_check():
    """Container readiness check; do not expose database or secret details."""
    try:
        db.session.execute(text('SELECT 1'))
        return jsonify(status='ok'), 200
    except Exception:
        db.session.rollback()
        app.logger.exception('Health check could not reach the configured database')
        return jsonify(status='unavailable'), 503


@app.route('/service-worker.js')
def service_worker():
    response = send_from_directory(app.static_folder, 'service-worker.js',
                                   mimetype='application/javascript')
    response.headers['Service-Worker-Allowed'] = '/'
    response.headers['Cache-Control'] = 'no-cache'
    return response


def totp_secret_for(user):
    if not user.totp_secret:
        return None
    try:
        return TOTP_CIPHER.decrypt(user.totp_secret.encode()).decode('ascii')
    except (InvalidToken, UnicodeDecodeError):
        app.logger.exception('Could not decrypt authenticator secret for account %s', user.id)
        return None


def set_totp_secret(user, secret):
    user.totp_secret = TOTP_CIPHER.encrypt(secret.encode('ascii')).decode('ascii')


def totp_qr_data(secret, username):
    uri = pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name='Plato LMS')
    image = qrcode.make(uri)
    buffer = BytesIO()
    image.save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        role = request.form.get('role', 'student')
        invite = request.form.get('invite_code', '')

        error = None
        if get_setting('registration_enabled') != 'true':
            error = 'Registration is currently closed. Please contact the administrator.'
        elif not 3 <= len(username) <= 80:
            error = 'Username must be 3 to 80 characters'
        elif '@' not in email or len(email) > 120:
            error = 'Enter a valid email address'
        elif len(password) < PASSWORD_MIN:
            error = f'Password must be at least {PASSWORD_MIN} characters'
        elif role not in ('student', 'instructor'):
            error = 'Choose a valid account type'
        elif role == 'instructor' and get_setting('instructor_signup_enabled') != 'true':
            error = 'Instructor registration is currently closed'
        elif role == 'instructor' and not (
                INSTRUCTOR_INVITE_CODE and
                secrets.compare_digest(invite, INSTRUCTOR_INVITE_CODE)):
            error = 'A valid invite code is required to register as an instructor'
        elif User.query.filter_by(username=username).first():
            error = 'Username already exists'
        elif User.query.filter_by(email=email).first():
            error = 'An account with that email already exists'

        if error:
            flash(error, 'error')
            return render_template('register.html', form=request.form,
                                   registration_enabled=get_setting('registration_enabled') == 'true',
                                   instructor_signup_enabled=get_setting('instructor_signup_enabled') == 'true',
                                   instructor_signup_available=(get_setting('instructor_signup_enabled') == 'true' and bool(INSTRUCTOR_INVITE_CODE)),
                                   password_min=PASSWORD_MIN), 400

        user = User(username=username, email=email,
                    role='instructor' if role == 'instructor' else 'student')
        user.set_password(password)
        db.session.add(user)
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            flash('Username or email already exists', 'error')
            return render_template('register.html', form=request.form,
                                   registration_enabled=get_setting('registration_enabled') == 'true',
                                   instructor_signup_enabled=get_setting('instructor_signup_enabled') == 'true',
                                   instructor_signup_available=(get_setting('instructor_signup_enabled') == 'true' and bool(INSTRUCTOR_INVITE_CODE)),
                                   password_min=PASSWORD_MIN), 400
        flash('Registration successful, please log in', 'success')
        return redirect(url_for('login'))
    return render_template('register.html',
                           registration_enabled=get_setting('registration_enabled') == 'true',
                           instructor_signup_enabled=get_setting('instructor_signup_enabled') == 'true',
                           instructor_signup_available=(get_setting('instructor_signup_enabled') == 'true' and bool(INSTRUCTOR_INVITE_CODE)),
                           password_min=PASSWORD_MIN)


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        user = User.query.filter_by(username=username).first()
        if user and user.is_active and user.check_password(password):
            target = request.values.get('next')
            session_target = target if is_safe_url(target) else url_for('dashboard')
            session.clear()
            session['mfa_pending_user_id'] = user.id
            session['mfa_next'] = session_target
            session['mfa_attempts'] = 0
            if user.totp_enabled:
                return redirect(url_for('mfa_verify'))
            secret = totp_secret_for(user) or pyotp.random_base32()
            set_totp_secret(user, secret)
            db.session.commit()
            return redirect(url_for('mfa_setup'))
        flash('Invalid credentials', 'error')
    return render_template('login.html')


@app.route('/mfa/setup', methods=['GET', 'POST'])
def mfa_setup():
    user_id = session.get('mfa_pending_user_id')
    user = db.session.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        session.pop('mfa_pending_user_id', None)
        flash('Sign in with your password before setting up two-factor authentication.', 'error')
        return redirect(url_for('login'))
    if user.totp_enabled:
        return redirect(url_for('mfa_verify'))
    secret = totp_secret_for(user)
    if not secret:
        secret = pyotp.random_base32()
        set_totp_secret(user, secret)
        db.session.commit()
    if request.method == 'POST':
        code = ''.join(c for c in request.form.get('code', '') if c.isdigit())
        if pyotp.TOTP(secret).verify(code, valid_window=1):
            user.totp_enabled = True
            db.session.commit()
            next_url = session.pop('mfa_next', url_for('dashboard'))
            session.pop('mfa_pending_user_id', None)
            session.pop('mfa_attempts', None)
            session['auth_version'] = user.auth_version
            login_user(user, fresh=True)
            flash('Two-factor authentication is enabled for your account.', 'success')
            return redirect(next_url if is_safe_url(next_url) else url_for('dashboard'))
        flash('That code is invalid or expired. Enter the current code from your authenticator app.', 'error')
    return render_template('mfa_setup.html', secret=secret,
                           qr_data=totp_qr_data(secret, user.username))


@app.route('/mfa/verify', methods=['GET', 'POST'])
def mfa_verify():
    user_id = session.get('mfa_pending_user_id')
    user = db.session.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        session.pop('mfa_pending_user_id', None)
        flash('Your sign-in session expired. Please sign in again.', 'error')
        return redirect(url_for('login'))
    if not user.totp_enabled:
        return redirect(url_for('mfa_setup'))
    if request.method == 'POST':
        attempts = int(session.get('mfa_attempts', 0))
        if attempts >= 5:
            session.pop('mfa_pending_user_id', None)
            session.pop('mfa_next', None)
            flash('Too many verification attempts. Sign in again.', 'error')
            return redirect(url_for('login'))
        code = ''.join(c for c in request.form.get('code', '') if c.isdigit())
        secret = totp_secret_for(user)
        if secret and pyotp.TOTP(secret).verify(code, valid_window=1):
            next_url = session.pop('mfa_next', url_for('dashboard'))
            session.pop('mfa_pending_user_id', None)
            session.pop('mfa_attempts', None)
            session['auth_version'] = user.auth_version
            login_user(user, fresh=True)
            return redirect(next_url if is_safe_url(next_url) else url_for('dashboard'))
        session['mfa_attempts'] = attempts + 1
        flash('Invalid or expired authenticator code.', 'error')
    return render_template('mfa_verify.html')


@app.route('/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return redirect(url_for('index'))


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------
@app.route('/dashboard')
@login_required
def dashboard():
    if current_user.role == 'admin':
        return redirect(url_for('admin_panel'))
    progress, student_counts = {}, {}
    if current_user.role == 'instructor':
        courses = (Course.query.filter_by(instructor_id=current_user.id)
                   .options(selectinload(Course.lessons))
                   .order_by(Course.id.desc()).all())
        if courses:
            student_counts = dict(
                db.session.query(Enrollment.course_id, func.count(Enrollment.id))
                .filter(Enrollment.course_id.in_([c.id for c in courses]))
                .group_by(Enrollment.course_id).all())
    else:
        courses = (Course.query.join(Enrollment, Enrollment.course_id == Course.id)
                   .filter(Enrollment.student_id == current_user.id)
                   .options(selectinload(Course.lessons), joinedload(Course.instructor))
                   .order_by(Course.id.desc()).all())
        progress = progress_for(current_user.id, [c.id for c in courses])
    all_courses = (Course.query.options(selectinload(Course.lessons),
                                        joinedload(Course.instructor))
                   .order_by(Course.id.desc()).all()) if current_user.role == 'student' else []
    return render_template('dashboard.html', courses=courses,
                           all_courses=all_courses, progress=progress,
                           student_counts=student_counts)


# --------------------------------------------------------------------------
# Courses
# --------------------------------------------------------------------------
@app.route('/course/create', methods=['GET', 'POST'])
@instructor_required
def create_course():
    if request.method == 'POST':
        title = clean_title(request.form.get('title'))
        description = clean_description(request.form.get('description'))
        if not title or description is None:
            flash(f'Enter a course title of {TITLE_MAX} characters and a description of {DESCRIPTION_MAX} characters or fewer', 'error')
            return render_template('create_course.html', course=None,
                                   editing=False, form=request.form)
        course = Course(title=title,
                        description=description,
                        instructor_id=current_user.id)
        db.session.add(course)
        db.session.commit()
        flash('Course created. Add your first lesson.', 'success')
        return redirect(url_for('course_detail', course_id=course.id))
    return render_template('create_course.html', course=None, editing=False)


@app.route('/course/<int:course_id>')
def course_detail(course_id):
    course = (Course.query.options(selectinload(Course.lessons),
                                   joinedload(Course.instructor))
              .filter_by(id=course_id).first_or_404())
    is_owner = (current_user.is_authenticated and
                course.instructor_id == current_user.id)
    enrolled = is_enrolled(current_user, course_id)
    completed_ids, progress = set(), None
    if enrolled:
        rows = (db.session.query(LessonProgress.lesson_id)
                .join(Lesson, Lesson.id == LessonProgress.lesson_id)
                .filter(LessonProgress.student_id == current_user.id,
                        Lesson.course_id == course_id).all())
        completed_ids = {r[0] for r in rows}
        progress = progress_for(current_user.id, [course_id])[course_id]
    return render_template('course_detail.html', course=course,
                           enrolled=enrolled, is_owner=is_owner,
                           can_view_lessons=is_owner or enrolled,
                           completed_ids=completed_ids, progress=progress)


@app.route('/course/<int:course_id>/edit', methods=['GET', 'POST'])
@instructor_required
def edit_course(course_id):
    course = owned_course_or_403(course_id)
    if request.method == 'POST':
        title = clean_title(request.form.get('title'))
        description = clean_description(request.form.get('description'))
        if not title or description is None:
            flash(f'Enter a course title of {TITLE_MAX} characters and a description of {DESCRIPTION_MAX} characters or fewer', 'error')
            return render_template('create_course.html', course=course,
                                   editing=True, form=request.form)
        course.title = title
        course.description = description
        db.session.commit()
        flash('Course updated', 'success')
        return redirect(url_for('course_detail', course_id=course.id))
    return render_template('create_course.html', course=course, editing=True)


@app.route('/course/<int:course_id>/delete', methods=['POST'])
@instructor_required
def delete_course(course_id):
    course = owned_course_or_403(course_id)
    db.session.delete(course)  # cascades to lessons, enrollments, progress
    db.session.commit()
    flash('Course deleted', 'success')
    return redirect(url_for('dashboard'))


@app.route('/course/<int:course_id>/enroll', methods=['POST'])
@login_required
def enroll(course_id):
    course = db.get_or_404(Course, course_id)
    back = url_for('course_detail', course_id=course.id)
    if current_user.role != 'student':
        return respond('Only students can enroll', back, ok=False, status=403)
    if is_enrolled(current_user, course.id):
        return respond('You are already enrolled', back)
    db.session.add(Enrollment(student_id=current_user.id, course_id=course.id))
    try:
        db.session.commit()
    except IntegrityError:  # double click / race
        db.session.rollback()
        return respond('You are already enrolled', back)
    return respond('Enrolled successfully', back)


@app.route('/course/<int:course_id>/unenroll', methods=['POST'])
@login_required
def unenroll(course_id):
    course = db.get_or_404(Course, course_id)
    back = url_for('course_detail', course_id=course.id)
    enrollment = Enrollment.query.filter_by(student_id=current_user.id,
                                            course_id=course.id).first()
    if not enrollment:
        return respond('You are not enrolled in this course', back, ok=False,
                       status=400)
    lesson_ids = [lesson.id for lesson in course.lessons]
    if lesson_ids:
        LessonProgress.query.filter(
            LessonProgress.student_id == current_user.id,
            LessonProgress.lesson_id.in_(lesson_ids)
        ).delete(synchronize_session=False)
    db.session.delete(enrollment)
    db.session.commit()
    return respond('You have left the course', url_for('dashboard'))


# --------------------------------------------------------------------------
# Lessons
# --------------------------------------------------------------------------
@app.route('/course/<int:course_id>/lesson/add', methods=['GET', 'POST'])
@instructor_required
def add_lesson(course_id):
    course = owned_course_or_403(course_id)
    if request.method == 'POST':
        title = clean_title(request.form.get('title'))
        if not title:
            flash(f'Enter a lesson title of {TITLE_MAX} characters or fewer', 'error')
            return render_template('add_lesson.html', course=course, lesson=None,
                                   editing=False, form=request.form)
        lesson = Lesson(title=title, content=request.form.get('content', ''),
                        course_id=course.id)
        db.session.add(lesson)
        db.session.commit()
        flash('Lesson added', 'success')
        return redirect(url_for('course_detail', course_id=course.id))
    return render_template('add_lesson.html', course=course, lesson=None,
                           editing=False)


@app.route('/lesson/<int:lesson_id>/edit', methods=['GET', 'POST'])
@instructor_required
def edit_lesson(lesson_id):
    lesson = db.get_or_404(Lesson, lesson_id)
    course = owned_course_or_403(lesson.course_id)
    if request.method == 'POST':
        title = clean_title(request.form.get('title'))
        if not title:
            flash(f'Enter a lesson title of {TITLE_MAX} characters or fewer', 'error')
            return render_template('add_lesson.html', course=course, lesson=lesson,
                                   editing=True, form=request.form)
        lesson.title = title
        lesson.content = request.form.get('content', '')
        db.session.commit()
        flash('Lesson updated', 'success')
        return redirect(url_for('course_detail', course_id=course.id))
    return render_template('add_lesson.html', course=course, lesson=lesson,
                           editing=True)


@app.route('/lesson/<int:lesson_id>/delete', methods=['POST'])
@instructor_required
def delete_lesson(lesson_id):
    lesson = db.get_or_404(Lesson, lesson_id)
    course = owned_course_or_403(lesson.course_id)
    db.session.delete(lesson)
    db.session.commit()
    flash('Lesson deleted', 'success')
    return redirect(url_for('course_detail', course_id=course.id))


@app.route('/lesson/<int:lesson_id>/complete', methods=['POST'])
@login_required
def toggle_lesson_complete(lesson_id):
    lesson = db.get_or_404(Lesson, lesson_id)
    back = url_for('course_detail', course_id=lesson.course_id)
    if not is_enrolled(current_user, lesson.course_id):
        return respond('Enroll in this course to track progress', back,
                       ok=False, status=403)
    existing = LessonProgress.query.filter_by(student_id=current_user.id,
                                              lesson_id=lesson.id).first()
    desired = request.form.get('completed')
    if request.is_json:
        payload = request.get_json(silent=True) or {}
        desired = payload.get('completed', desired)
    desired = (str(desired).lower() in ('true', '1', 'yes')) if desired is not None else not bool(existing)
    if desired and not existing:
        db.session.add(LessonProgress(student_id=current_user.id,
                                      lesson_id=lesson.id))
    elif not desired and existing:
        db.session.delete(existing)
    completed = desired
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        completed = LessonProgress.query.filter_by(
            student_id=current_user.id, lesson_id=lesson.id).first() is not None
    stats = progress_for(current_user.id, [lesson.course_id])[lesson.course_id]
    return respond('Lesson marked complete' if completed else 'Lesson marked incomplete',
                   back, completed=completed, **stats)





def admin_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not current_user.is_authenticated or current_user.role != 'admin':
            abort(403)
        return view(*args, **kwargs)
    return wrapper



@app.route('/admin')
@admin_required
def admin_panel():
    users = User.query.filter_by(is_deleted=False).all()
    deleted = User.query.filter_by(is_deleted=True).all()
    backups = ConfigBackup.query.order_by(ConfigBackup.created_at.desc()).limit(10).all()
    return render_template('admin.html', users=users, deleted=deleted,
                           settings=current_app_settings(), backups=backups,
                           student_count=User.query.filter_by(role='student', is_deleted=False).count(),
                           instructor_count=User.query.filter_by(role='instructor', is_deleted=False).count(),
                           admin_count=User.query.filter_by(role='admin', is_deleted=False).count(),
                           course_count=Course.query.count(), password_min=PASSWORD_MIN,
                           instructor_invite_configured=bool(INSTRUCTOR_INVITE_CODE))


@app.route('/admin/user/add', methods=['POST'])
@admin_required
def admin_add_user():
    username = request.form.get('username', '').strip()
    email = request.form.get('email', '').strip().lower()
    password = request.form.get('password', '')
    role = request.form.get('role', 'student')
    if not 3 <= len(username) <= 80 or '@' not in email or len(email) > 120 or len(password) < PASSWORD_MIN or role not in ('student', 'instructor', 'admin'):
        flash('Invalid input', 'error')
        return redirect(url_for('admin_panel'))
    u = User(username=username, email=email, role=role)
    u.set_password(password)
    db.session.add(u)
    try:
        db.session.commit()
        flash('User added', 'success')
    except IntegrityError:
        db.session.rollback()
        flash('Username or email exists', 'error')
    return redirect(url_for('admin_panel'))


@app.route('/admin/user/<int:user_id>/delete', methods=['POST'])
@admin_required
def admin_delete_user(user_id):
    u = db.get_or_404(User, user_id)
    if u.id == current_user.id:
        flash('You cannot deactivate your own administrator account.', 'error')
        return redirect(url_for('admin_panel'))
    if u.role == 'admin' and not u.is_deleted and User.query.filter_by(role='admin', is_deleted=False).count() <= 1:
        flash('The last active administrator cannot be deactivated.', 'error')
        return redirect(url_for('admin_panel'))
    u.is_deleted = True
    u.deleted_at = datetime.now(timezone.utc)
    db.session.commit()
    flash('User soft-deleted (retained in system)', 'success')
    return redirect(url_for('admin_panel'))


@app.route('/admin/user/<int:user_id>/restore', methods=['POST'])
@admin_required
def admin_restore_user(user_id):
    user = db.get_or_404(User, user_id)
    user.is_deleted = False
    user.deleted_at = None
    db.session.commit()
    flash('Account restored. The user can sign in again.', 'success')
    return redirect(url_for('admin_panel'))


@app.route('/admin/user/<int:user_id>/reset-mfa', methods=['POST'])
@admin_required
def admin_reset_mfa(user_id):
    user = db.get_or_404(User, user_id)
    user.totp_secret = None
    user.totp_enabled = False
    user.auth_version += 1
    db.session.commit()
    flash(f'Authenticator reset for {user.username}. They must enroll a new QR code at next sign-in.', 'success')
    return redirect(url_for('admin_panel'))


@app.route('/admin/user/<int:user_id>/role', methods=['POST'])
@admin_required
def admin_change_role(user_id):
    user = db.get_or_404(User, user_id)
    role = request.form.get('role', '')
    if role not in ('student', 'instructor', 'admin'):
        flash('Choose a valid role.', 'error')
    elif user.id == current_user.id and role != 'admin':
        flash('You cannot remove your own administrator role.', 'error')
    elif user.role == 'admin' and role != 'admin' and not user.is_deleted and User.query.filter_by(role='admin', is_deleted=False).count() <= 1:
        flash('The last active administrator role cannot be removed.', 'error')
    else:
        user.role = role
        db.session.commit()
        flash(f'{user.username}’s role was updated.', 'success')
    return redirect(url_for('admin_panel'))


@app.route('/admin/settings', methods=['POST'])
@admin_required
def admin_settings():
    save_setting('registration_enabled', request.form.get('registration_enabled') == 'on')
    save_setting('instructor_signup_enabled', request.form.get('instructor_signup_enabled') == 'on')
    db.session.commit()
    flash('Workspace settings saved.', 'success')
    return redirect(url_for('admin_panel'))


@app.route('/admin/backup', methods=['POST'])
@admin_required
def admin_backup():
    snapshot = current_app_settings()
    db.session.add(ConfigBackup(snapshot=json.dumps(snapshot, sort_keys=True)))
    db.session.commit()
    flash('Configuration snapshot saved. User and course records were not copied.', 'success')
    return redirect(url_for('admin_panel'))


@app.route('/admin/restore', methods=['POST'])
@admin_required
def admin_restore():
    backup = ConfigBackup.query.order_by(ConfigBackup.created_at.desc()).first()
    if backup is None:
        flash('No configuration snapshot is available.', 'error')
        return redirect(url_for('admin_panel'))
    try:
        snapshot = json.loads(backup.snapshot)
        if set(snapshot) != set(DEFAULT_SETTINGS) or any(type(value) is not bool for value in snapshot.values()):
            raise ValueError('Invalid snapshot format')
    except (json.JSONDecodeError, ValueError):
        flash('The latest configuration snapshot is invalid; settings were not changed.', 'error')
        return redirect(url_for('admin_panel'))
    for key, value in snapshot.items():
        save_setting(key, value)
    db.session.commit()
    flash('Latest configuration restored. User and course data was not changed.', 'success')
    return redirect(url_for('admin_panel'))


@app.cli.command('create-admin')
def create_admin():
    """Create the first administrator without a built-in default password."""
    username = input('Administrator username: ').strip()
    email = input('Administrator email: ').strip().lower()
    password = getpass.getpass('Administrator password (at least 12 characters): ')
    if not 3 <= len(username) <= 80 or '@' not in email or len(email) > 120 or len(password) < PASSWORD_MIN:
        raise SystemExit('Invalid username, email, or password length.')
    if User.query.filter((User.username == username) | (User.email == email)).first():
        raise SystemExit('That username or email is already registered.')
    user = User(username=username, email=email, role='admin')
    user.set_password(password)
    db.session.add(user)
    db.session.commit()
    print(f'Administrator {username} created.')


@app.cli.command('backup-db')
@click.option('--directory', default=None, help='Destination folder (default: instance/backups).')
def backup_db(directory):
    """Create an encrypted, consistent local SQLite backup."""
    if db.engine.dialect.name != 'sqlite':
        raise click.ClickException('This command backs up SQLite only. Use your managed database backup service for PostgreSQL.')
    source = db.engine.url.database
    if not source or source == ':memory:' or not Path(source).is_file():
        raise click.ClickException('Could not locate the on-disk SQLite database.')
    target_dir = Path(directory) if directory else Path(app.instance_path) / 'backups'
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f"plato-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.sqlite3"
    target = target_dir / (filename + '.fernet')
    temporary = target_dir / (filename + '.tmp')
    try:
        source_db = sqlite3.connect(source)
        target_db = sqlite3.connect(temporary)
        try:
            source_db.backup(target_db)
        finally:
            target_db.close()
            source_db.close()
        target.write_bytes(BACKUP_CIPHER.encrypt(temporary.read_bytes()))
    finally:
        temporary.unlink(missing_ok=True)
    print(f'Consistent database backup created: {target.resolve()}')


@app.cli.command('seed-demo-users')
def seed_demo_users():
    """Create four local demo accounts; credentials are randomly generated and shown once."""
    if os.environ.get('APP_ENV', 'development').lower() == 'production':
        raise click.ClickException('Demo users are disabled when APP_ENV=production.')
    sample_users = [
        ('demo_admin', 'demo_admin@example.invalid', 'admin'),
        ('demo_instructor', 'demo_instructor@example.invalid', 'instructor'),
        ('demo_student_1', 'demo_student_1@example.invalid', 'student'),
        ('demo_student_2', 'demo_student_2@example.invalid', 'student'),
    ]
    created = []
    for username, email, role in sample_users:
        user = User.query.filter((User.username == username) | (User.email == email)).first()
        if user:
            continue
        password = secrets.token_urlsafe(20)
        user = User(username=username, email=email, role=role)
        user.set_password(password)
        db.session.add(user)
        created.append((username, role, password))
    db.session.commit()
    for username, role, password in created:
        print(f'{username} ({role}) temporary password: {password}')
    print(f'Created {len(created)} demo users. Credentials are printed once; change or remove demo accounts before deployment.')


DEMO_LESSON_DETAILS = {
    'Your first Python program': """## Learn
Python runs your instructions from top to bottom. `print()` displays information in the terminal. A comment starts with `#` and explains the intention to another reader.

## Worked example
```python
# Save this as hello.py
name = "Ama"
print(f"Welcome to Python, {name}!")
```
Run `python hello.py` (or `py hello.py` on Windows). You should see: `Welcome to Python, Ama!`. The assignment stores text in `name`; the f-string inserts its value inside the braces.

## Your turn
Change the name, run the file, and add two more print statements to make a three-line introduction. If Python reports a syntax error, check that quotes and parentheses are paired.

## Check your work
The program displays three lines. Python distinguishes uppercase from lowercase, so `Print` is not the same as `print`.""",
    'Values, variables and input': """## Learn
Variables give names to values. `input()` always returns text, including when the user enters digits. Convert numeric text with `int()` for whole numbers or `float()` for decimals before calculating.

## Worked example
```python
name = input("Your name: ")
minutes = int(input("Study minutes today: "))
weekly_total = minutes * 5
print(f"{name}, five similar days is {weekly_total} minutes.")
```
With inputs `Kojo` and `30`, the output reports 150 minutes. The f-string inserts values; multiplication works because `minutes` is an integer.

## Your turn
Ask for the price of one notebook and the quantity. Convert the price with `float()`, the quantity with `int()`, multiply them, and display the total to two decimal places using `{total:.2f}`.

## Check your work
A price of 2.50 and quantity of 4 gives 10.00. Try a decimal price. Later, add `try/except ValueError` to explain when someone types letters instead of a number.""",
    'Make decisions with conditions': """## Learn
An `if` statement runs a block when its condition is true. `elif` checks another case and `else` handles what remains. Use `==` to compare; a single `=` assigns a value. Indentation defines each block.

## Worked example
```python
score = int(input("Score from 0 to 100: "))
if score < 0 or score > 100:
    print("Score is outside the valid range.")
elif score >= 80:
    print("Excellent")
elif score >= 50:
    print("Pass")
else:
    print("Keep practising")
```
For 72, the first two checks are false and the pass branch runs. For 110, the range check runs first. Python stops after the first true branch.

## Your turn
Run the program with 110, 80, 50 and 49. Add a check for exactly 100 if you want a special message, placing it before the 80 check.

## Check your work
The four inputs produce invalid, Excellent, Pass, and Keep practising. Always test boundary values; they reveal mistakes in comparison operators.""",
    'Repeat work with loops': """## Learn
A `for` loop repeats over a sequence. `range(1, 4)` yields 1, 2, 3; its endpoint is excluded. A `while` loop repeats while a condition stays true, so update the condition on each pass to ensure it can stop.

## Worked example
```python
total = 0
for day in range(1, 4):
    amount = float(input(f"Expense for day {day}: "))
    total += amount
print(f"Three-day total: {total:.2f}")
```
For 10, 4.5 and 2, the running total becomes 16.5. The summary is outside the loop, so it prints only once.

## Your turn
Collect five expenses and calculate the average. Use `range(1, 6)` and divide the total by 5. Then write a while-loop that asks for text until the user types `done`.

## Check your work
The example displays 16.50. A while-loop must change its input or counter, or its condition may never become false.""",
    'From topic to research question': """## Learn
A topic names an area; a research question specifies what you will investigate. A strong question is focused, clear, open to evidence, and small enough for the assignment. Identify the population, setting, period, and outcome.

## Worked example
Broad topic: social media and students. Narrow it to first-year university students, study-related social media, and weekly study habits. A focused question is: “How do first-year students at College X describe the effect of study-related social media use on their weekly study habits?” It asks for descriptions without assuming the effect is positive or negative.

## Your turn
Narrow “technology in education.” Name one learner group, one technology and one outcome. Write one sentence describing what evidence could answer your question.

## Check your work
A reader can identify who or what you study and what you want to learn. Replace vague words such as “good” with something observable. Keep the wording neutral so evidence can challenge your expectation.""",
    'Finding and evaluating sources': """## Learn
Evaluate a source's author, evidence, purpose, date, and relevance. Peer-reviewed studies are useful for research findings; government reports and reputable organizations can provide current statistics. A source can be trustworthy yet irrelevant to your exact question.

## Worked example
For the claim that retrieval quizzes support recall, compare a peer-reviewed study, a university teaching guide, and an anonymous blog. Record author expertise, date, research method, evidence, and limitations. The study may provide direct evidence; the guide may translate findings into practice; the blog may offer an idea but needs verification.

## Your turn
Create a source log with columns for citation, main claim, method or evidence, useful page, limitation, and how it helps your question. Find two sources and compare their strengths.

## Check your work
Explain why each source belongs in your paper. Prefer original research when a summary makes a factual claim. Do not treat one small study as proof of a universal rule.""",
    'Build a strong paragraph': """## Learn
A focused academic paragraph makes one point, supplies evidence, explains what that evidence means, and links back to the argument. Evidence does not explain itself. Each sentence should have a clear purpose.

## Worked example
Point: Weekly practice quizzes can help learners notice gaps in understanding. Evidence: cite a learning-science source you have actually read. Reasoning: feedback lets learners revisit a specific idea before a major assessment. Link: quizzes are most useful when paired with timely explanations. The evidence placeholder must be replaced with a real source.

## Your turn
Write a paragraph about one benefit or limitation of your research topic. Label each sentence P (point), E (evidence), R (reasoning), or L (link). Revise sentences with no clear job.

## Check your work
The paragraph makes one claim, cites traceable evidence, and explains its relevance. If evidence conflicts with your claim, qualify or revise the claim rather than hiding that result.""",
    'Citations and academic integrity': """## Learn
Citations credit ideas and help readers locate sources. A citation usually has an in-text reference and a complete reference-list entry. The required style (APA, Harvard, MLA, or another) depends on your assignment. A paraphrase still needs a citation; exact words also need quotation marks.

## Worked example
Source idea: spaced practice supports later recall. Paraphrase: “Reviewing material across several sessions can support later recall (Author, year).” This remains the source's idea, so cite it. If copying the source's exact sentence, use quotation marks and a page number when required by the style.

## Your turn
Label each sentence in a paragraph as your analysis, a paraphrase, or a quotation. Add citations to borrowed ideas and check each in-text citation against the reference list.

## Check your work
Every source can be found and verified. Never invent a citation or cite a source you have not read. Consult your institution's current guide for exact punctuation and formatting.""",
    'Ask a question of your data': """## Learn
A dataset contains observations (rows) and variables (columns). Define the question before calculating. Record units, the population, time period, and what the data cannot tell you. A convenience sample may not represent everyone.

## Worked example
Question: “What was the typical quiz score in this class this week?” Each row is a student's result; the variable is `score_percent`, from 0 to 100. Scores 60, 70, 70, 80, 90 describe those submissions. They cannot explain why scores differed or predict every future class.

## Your turn
Choose an attendance question. Specify what one row represents, two required variables and their units. Name one conclusion the data could not support.

## Check your work
The data fields actually answer your question. Scores alone cannot prove that study time caused a result. Say “in this dataset” when describing only the records you observed.""",
    'Clean and organize a table': """## Learn
Inspect column names, missing values, duplicates, units, and inconsistent labels before analysis. Preserve the original file, work on a copy, and document every cleaning rule. Missing does not mean zero: zero is a measured value.

## Worked example
Attendance labels are `Present`, `present`, blank, and `PRESENT`. If case differences mean the same category, standardize them to `Present` and log the change. Keep the blank as missing until you learn what it means; do not assume it means absent. Check for duplicate student-and-date rows.

## Your turn
Inspect a five-row table with names, dates and scores. Find a duplicate, inconsistent label and missing score. Explain what you would verify before correcting each one. Log the rule, affected rows and reason.

## Check your work
The cleaned table has consistent documented formats, and can be compared with the untouched original. Missing values have not silently become zero.""",
    'Summarize patterns responsibly': """## Learn
Mean is sum divided by count. Median is the middle sorted value (or the average of the two middle values). Extreme values can pull the mean; the median often better represents a skewed group. State units and sample size.

## Worked example
Scores 60, 70, 70, 80, 90 sum to 370, so mean = 370 / 5 = 74; median = 70. Add an erroneous score of 200: the mean becomes 95, while the median is 75. Investigate unusual values; do not remove them only because they affect the result.

## Your turn
For 4, 5, 5, 6, 20 calculate mean, median and range. Range is maximum minus minimum. Explain which typical-value measure better represents most entries.

## Check your work
Mean = 8, median = 5, range = 16. The high value pulls the mean up. Describe the pattern without claiming a cause the numbers do not establish.""",
    'Choose a clear visualization': """## Learn
Use bars to compare categories, lines to show change over time, and scatterplots to explore relationships between two numeric variables. A clear chart has a descriptive title, labelled axes, units and a sensible scale. Avoid 3D effects and misleading truncated axes.

## Worked example
Weekly library visits: 20, 25, 23, 31. Plot week on the horizontal axis and visits on the vertical axis using a line chart. The pattern rises overall, with a small dip in week 3. It does not prove why visits changed.

## Your turn
Create a bar chart for course enrollments 12, 18, 9, 15. Label the vertical axis “Students,” add a precise title, and write one cautious comparison.

## Check your work
A reader understands what is compared, how much, and over which period. Your claim matches the plotted values; a chart alone does not show causation.""",
    'Structure a page with HTML': """## Learn
HTML describes content; CSS controls appearance. Semantic elements communicate purpose. Use a main heading, ordered subheadings, `<nav>` for navigation, `<main>` for primary content, links to navigate and buttons to perform actions.

## Worked example
```html
<header><h1>Community Garden</h1></header>
<nav aria-label="Main navigation">
  <a href="/about">About</a>
  <a href="/events">Events</a>
</nav>
<main>
  <h2>Upcoming workday</h2>
  <p>Join us Saturday to prepare the beds.</p>
  <a href="/events">View event details</a>
</main>
```
The heading order describes the page. The link text explains where it goes. The navigation label helps distinguish it when a page has multiple navigation regions.

## Your turn
Build a study-group page with a title, two sections, a three-item resource list and a descriptive link. Open it in a browser and check for unclosed or incorrectly nested tags.

## Check your work
The page makes sense without styling. Use headings to structure content, not just to make text large.""",
    'Style with CSS fundamentals': """## Learn
A CSS rule has a selector and declarations. Reusable class selectors begin with a dot. The box model includes content, padding, border and margin. Setting `box-sizing: border-box` makes declared width include padding and border.

## Worked example
```css
* { box-sizing: border-box; }
.card {
  max-width: 32rem;
  padding: 1.25rem;
  border: 1px solid #cbd5d1;
  border-radius: 0.75rem;
  color: #18352d;
  background: #ffffff;
}
```
Link this stylesheet in the HTML head. The maximum width lets the card shrink on small screens while limiting its size on wide screens.

## Your turn
Add a `.button-link` class with padding, readable colors and a hover state. Change the card padding and notice how the content area changes.

## Check your work
The style applies wherever the class is used. Text stays readable on a narrow viewport, and color is not the only way information is communicated.""",
    'Create layouts that adapt': """## Learn
CSS Grid works well for two-dimensional groups of cards. Flexbox arranges items along one direction. Flexible columns can adapt without fixed page widths, which avoids horizontal scrolling on phones.

## Worked example
```css
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 1rem;
}
```
The browser fits as many columns as possible, each at least 14rem wide, then grows them to fill the row. On a narrow screen this becomes one column automatically.

## Your turn
Create three resource cards and a header with a title and navigation link. Resize the browser. If the header is cramped, add a media query at the width where it needs to stack.

## Check your work
There is no horizontal page scrolling on a phone, gaps remain consistent, and HTML order stays logical when the visual layout changes.""",
    'Design for access and clarity': """## Learn
Semantic HTML improves accessibility. Every form control needs a visible label. Keyboard focus must be visible; text and controls need sufficient contrast. Link text should make sense by itself. Do not use color alone to signal errors or required fields.

## Worked example
```html
<form>
  <label for="email">Email address</label>
  <input id="email" name="email" type="email"
         autocomplete="email" required>
  <button type="submit">Join the study group</button>
</form>
```
The label's `for` matches the input's `id`, so clicking the label focuses the field and assistive technology can announce its name. Browser validation helps, but the server must still validate submitted data.

## Your turn
Use Tab to move through all controls. Zoom to 200%, check contrast, and add a required checkbox with its own label. Place clear error instructions near the affected field.

## Check your work
Keyboard users can operate every control, each field has an announced name, and enlarged text remains readable."""
};

@app.cli.command('seed-demo-courses')
@click.option('--instructor', 'instructor_username', default=None,
              help='Assign new sample courses to this existing instructor username.')
@click.option('--update-existing', is_flag=True,
              help='Refresh lesson text only for the known sample course titles.')
def seed_demo_courses(instructor_username, update_existing):
    """Add the sample catalogue, optionally refreshing its guided lesson text."""
    instructor = None
    if instructor_username:
        instructor = User.query.filter_by(username=instructor_username,
                                           role='instructor',
                                           is_deleted=False).first()
        if instructor is None:
            raise click.ClickException('That active instructor account was not found.')
    else:
        instructors = User.query.filter_by(role='instructor', is_deleted=False).limit(2).all()
        if len(instructors) == 1:
            instructor = instructors[0]

    catalogue = [
        {
            'title': 'Python Programming: A Practical Start',
            'description': 'Learn core Python by writing small, useful programs. Build confidence with variables, decisions, loops and reusable functions.',
                    'lessons': [
                ('Your first Python program', 'Meet the Python interpreter, run a short script, and use print() to display a useful message. Learn how comments help explain your code.'),
                ('Values, variables and input', 'Store text and numbers in variables. Use input() to ask a question, convert numeric text with int(), and format a friendly response.'),
                ('Make decisions with conditions', 'Use if, elif and else to make a program respond to different situations. Practice comparison operators and clear indentation.'),
                ('Repeat work with loops', 'Use for loops with ranges and while loops with clear stop conditions. Finish by building a small number guessing exercise.'),
            ],
        },
        {
            'title': 'Academic Writing and Research Skills',
            'description': 'Plan clear academic work, develop a focused argument, evaluate evidence and cite sources responsibly.',
            'lessons': [
                ('From topic to research question', 'Narrow a broad subject into a focused question. Identify the audience, purpose and scope before collecting sources.'),
                ('Finding and evaluating sources', 'Compare scholarly books, journal articles and reliable reports. Check authority, evidence, relevance and publication context.'),
                ('Build a strong paragraph', 'Use a topic sentence, evidence, explanation and a link back to your main claim. Keep quotations purposeful and concise.'),
                ('Citations and academic integrity', 'Track source details while researching, distinguish your ideas from borrowed material, and apply the citation style required for your assignment.'),
            ],
        },
        {
            'title': 'Introduction to Data Analysis',
            'description': 'Turn a small dataset into a clear, evidence-based story using tables, summary measures and thoughtful visual choices.',
            'lessons': [
                ('Ask a question of your data', 'Define the question first. Identify the observations, variables and units needed to answer it, and note what the dataset cannot tell you.'),
                ('Clean and organize a table', 'Check column names, missing values, duplicate rows and inconsistent categories. Keep a record of changes so the work is reproducible.'),
                ('Summarize patterns responsibly', 'Use counts, proportions, mean and median where appropriate. Look for spread and outliers before drawing conclusions.'),
                ('Choose a clear visualization', 'Match the chart to the comparison: bars for categories, lines for change over time, and scatterplots for relationships between two measures.'),
            ],
        },
        {
            'title': 'Web Design Foundations',
            'description': 'Understand how HTML, CSS and accessible design work together to create useful pages across screen sizes.',
            'lessons': [
                ('Structure a page with HTML', 'Use semantic landmarks, headings, links, lists and forms to describe the purpose and structure of a page.'),
                ('Style with CSS fundamentals', 'Practice selectors, the box model, spacing, color and typography. Use reusable classes to keep styles consistent.'),
                ('Create layouts that adapt', 'Use Flexbox and CSS Grid to arrange content. Add a breakpoint when the layout needs to change for a narrower screen.'),
                ('Design for access and clarity', 'Use readable contrast, visible keyboard focus, labels for form controls and meaningful link text. Check the page at mobile widths.'),
            ],
        },
    ]

    created_courses = 0
    added_lessons = 0
    refreshed_lessons = 0
    try:
        for item in catalogue:
            course = Course.query.filter_by(title=item['title']).first()
            if course is None:
                course = Course(title=item['title'], description=item['description'],
                                instructor_id=instructor.id if instructor else None)
                db.session.add(course)
                db.session.flush()
                created_courses += 1
            existing_lessons = {lesson.title: lesson for lesson in course.lessons}
            for title, content in item['lessons']:
                detailed_content = DEMO_LESSON_DETAILS.get(title, content)
                if title in existing_lessons:
                    if update_existing:
                        existing_lessons[title].content = detailed_content
                        refreshed_lessons += 1
                    continue
                db.session.add(Lesson(title=title, content=detailed_content,
                                      course_id=course.id))
                added_lessons += 1
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise

    owner = f' Instructor: {instructor.username}.' if instructor else ' Courses are unassigned.'
    print(f'Added {created_courses} courses and {added_lessons} lessons; '
          f'refreshed {refreshed_lessons} lesson texts.{owner}')


# --------------------------------------------------------------------------
# Startup
# --------------------------------------------------------------------------
with app.app_context():
    db.create_all()  # adds new tables (e.g. LessonProgress) to an existing DB
    user_columns = {column['name'] for column in inspect(db.engine).get_columns('user')}
    with db.engine.begin() as connection:
        if 'totp_secret' not in user_columns:
            connection.exec_driver_sql('ALTER TABLE "user" ADD COLUMN totp_secret VARCHAR(512)')
        if 'totp_enabled' not in user_columns:
            connection.exec_driver_sql('ALTER TABLE "user" ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE')
        if 'auth_version' not in user_columns:
            connection.exec_driver_sql('ALTER TABLE "user" ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1')

if __name__ == '__main__':
    # The Werkzeug debugger allows code execution, so it is opt-in:
    #   FLASK_DEBUG=1 python app.py
    app.run(debug=os.environ.get('FLASK_DEBUG') == '1')
