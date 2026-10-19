# Plato LMS

A small Flask learning platform with student, instructor and administrator roles. It includes a responsive course catalogue, learner progress, instructor course tools, and an administrator dashboard.

## Run locally on Windows PowerShell

```powershell
cd 'C:\Users\APC\Plato-LMS'
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Edit `.env` and replace `SECRET_KEY`, `PASSWORD_PEPPER`, and `INSTRUCTOR_INVITE_CODE` with different random values. For example, generate a value with:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Save the first generated value as `SECRET_KEY`, the second as `PASSWORD_PEPPER`, and another as `INSTRUCTOR_INVITE_CODE`. Keep `.env` private and keep the password pepper unchanged; changing it prevents existing password hashes from verifying. The `.env` file is excluded from Git.

Generate a separate TOTP encryption key and save it as `TOTP_ENCRYPTION_KEY` in `.env`:

```powershell
.\.venv\Scripts\python.exe -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Never change this key after users enroll MFA unless you have a planned MFA reset for every account; the database stores encrypted TOTP secrets.

Generate a different key the same way and save it as `BACKUP_ENCRYPTION_KEY`. Local SQLite backups are encrypted with it. Store both keys securely; losing the backup key makes encrypted local backup files unreadable.

Create the first administrator. The password is entered only in the terminal and is not included in a command or source file:

```powershell
.\.venv\Scripts\python.exe -m flask --app app create-admin
```

Start the local development server:

```powershell
.\.venv\Scripts\python.exe app.py
```

Open `http://127.0.0.1:5000`. The app uses SQLite by default, stored under `instance/`. Set `DATABASE_URL` in `.env` to use another SQLAlchemy-compatible database.

## Two-factor sign-in

Every account must set up TOTP two-factor authentication on its first sign-in. Scan the on-screen QR code with an authenticator app, then enter the live code to finish setup. On later sign-ins, the password is checked first and the authenticator code second. The TOTP secret is encrypted in the database using `TOTP_ENCRYPTION_KEY`. If a user loses their device, another administrator can use the Admin dashboard's Authenticator enrollment section to reset it; the user must scan a fresh QR code at next sign-in.

Passwords are hashed with Werkzeug's scrypt password hashing and a unique random salt per hash. The environment-only `PASSWORD_PEPPER` is appended before hashing. The original password and pepper are never stored in the user table.

## Add sample learning content

Run this command once you have configured `.env`. It adds four sample courses and sixteen lessons without replacing existing records. The lessons include guided explanations, worked examples, practice tasks, and checks. If exactly one active instructor exists, the courses are assigned to them. You can specify an instructor explicitly:

```powershell
.\.venv\Scripts\python.exe -m flask --app app seed-demo-courses
# Optional:
.\.venv\Scripts\python.exe -m flask --app app seed-demo-courses --instructor instructor_username
```

The default command is safe to rerun: existing sample courses and lessons with matching titles are left in place. To refresh the lesson text for those exact demo course and lesson titles, add `--update-existing`; course records, enrollments, and completion progress are preserved. Course lesson text supports `##` headings, fenced code blocks, paragraphs, and `-` bullet lists. Instructors can also add or edit lessons from the course page.

Lesson pages use keyboard-accessible expandable sections. Students can mark a lesson complete or incomplete; progress is saved to the database and reflected in the course progress bar and dashboard. Repeated completion requests are idempotent, so a retry will not accidentally toggle a lesson back off.

## Features

- Student accounts can browse courses, enroll and track lesson completion.
- Instructors can create courses and manage their lessons. Instructor signup requires the invite code.
- Administrators can add members, change roles, deactivate accounts (records remain), restore accounts, and control signup settings.
- The user table stores one row per account, including role, active/deactivated status, and MFA enrollment status. Deactivation is a soft delete; user, course, and progress rows remain available to the administrator.
- Passwords use Werkzeug scrypt with a unique random salt. `PASSWORD_PEPPER` is applied server-side before hashing; it is not stored in the database.
- Every POST form uses CSRF protection. Session cookies are HTTP-only and use SameSite=Lax; set `COOKIE_SECURE=1` behind HTTPS.
- Configuration snapshots save only student-registration and instructor-signup switches. Restoring changes those settings and leaves members, courses, lessons and progress unchanged.

## Backup note

Configuration snapshots are stored in the app database and contain only workspace settings. Restore changes those settings only; it never rewrites users, courses or progress. For a local full-database backup, run:

```powershell
.\.venv\Scripts\python.exe -m flask --app app backup-db
```

This writes an encrypted, consistent SQLite backup under `instance/backups/`. Schedule the command daily with Windows Task Scheduler and copy the encrypted files to a different disk or account. Do not treat a backup stored beside the live database as disaster recovery. Test restores periodically using a separate copy.

To register a daily 2:00 AM task for the current Windows user, run this once in PowerShell from the project folder:

```powershell
.\schedule-backup.ps1
```

## Mobile and desktop

The project includes an Expo mobile app for Android and iOS in [`mobile/`](mobile/). It displays the responsive Flask LMS and shares the same sign-in, MFA, role permissions, courses, and progress data. Follow [`mobile/README.md`](mobile/README.md) to configure the Flask server URL and run it. For an internet-accessible shared backend, follow [`BACKEND_DEPLOYMENT.md`](BACKEND_DEPLOYMENT.md).

The responsive web app can also be installed as a Progressive Web App (PWA) from a supported mobile or desktop browser. It caches only public interface assets; it never caches signed-in pages or user data.

## Backend deployment

The Flask backend can run locally or in a container. The web client and Expo app both use the same HTTPS backend and database. A `/healthz` readiness endpoint checks that the backend can reach its database. AWS setup and deployment instructions are in [`BACKEND_DEPLOYMENT.md`](BACKEND_DEPLOYMENT.md).

The existing local database currently contains five user rows across administrator, instructor, and student roles. For a separate local demo dataset, `flask --app app seed-demo-users` creates four additional development-only accounts with one-time random passwords printed to the terminal; it refuses to run when `APP_ENV=production`. Do not run it against a public database.

RDS point-in-time recovery creates a separate restored database; it does not overwrite the running database. The application's configuration restore is separate and changes only the saved signup switches. Do not use Flask's built-in development server for public deployment.
