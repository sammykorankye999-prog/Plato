import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCb);
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'login.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('inputer','manager','admin','administrator')),
    totp_cipher TEXT NOT NULL,
    last_totp_step INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER REFERENCES users(id),
    event TEXT NOT NULL,
    target TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const passwordPepper = process.env.PASSWORD_PEPPER;
const encryptionSecret = process.env.MFA_ENCRYPTION_KEY;
const port = Number(process.env.PORT || 3000);
const roles = ['inputer', 'manager', 'admin', 'administrator'];
if (!passwordPepper || passwordPepper.length < 32 || !encryptionSecret || encryptionSecret.length < 32) {
  console.error('Set PASSWORD_PEPPER and MFA_ENCRYPTION_KEY to different random secrets of at least 32 characters. See README.md.');
  process.exit(1);
}
const mfaKey = createHash('sha256').update(encryptionSecret, 'utf8').digest();

function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function audit(actorId, event, target = '') {
  db.prepare('INSERT INTO audit(actor_id,event,target) VALUES(?,?,?)').run(actorId ?? null, event, String(target).slice(0, 160));
}
function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mfaKey, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(x => x.toString('base64url')).join('.');
}
function decryptSecret(value) {
  const [iv, tag, body] = value.split('.').map(x => Buffer.from(x, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', mfaKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
async function makePasswordHash(password) {
  const salt = randomBytes(16);
  const material = createHmac('sha256', passwordPepper).update(password, 'utf8').digest();
  const hash = await scrypt(material, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${Buffer.from(hash).toString('base64url')}`;
}
async function verifyPassword(password, saved) {
  const [name, n, r, p, salt64, hash64] = saved.split('$');
  if (name !== 'scrypt') return false;
  const salt = Buffer.from(salt64, 'base64url');
  const expected = Buffer.from(hash64, 'base64url');
  const material = createHmac('sha256', passwordPepper).update(password, 'utf8').digest();
  const actual = Buffer.from(await scrypt(material, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function base32(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, result = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function fromBase32(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const out = [];
  for (const char of input.replace(/=+$/,'').toUpperCase()) {
    const n = alphabet.indexOf(char); if (n < 0) throw new Error('bad secret');
    value = (value << 5) | n; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, at = Date.now()) {
  const counter = Math.floor(at / 30000);
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', fromBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1000000).padStart(6, '0');
}
function checkTotp(secret, input) {
  if (!/^\d{6}$/.test(input)) return null;
  for (const drift of [-30000, 0, 30000]) {
    const candidate = Buffer.from(totp(secret, Date.now() + drift));
    const supplied = Buffer.from(input);
    if (timingSafeEqual(candidate, supplied)) return Math.floor((Date.now() + drift) / 30000);
  }
  return null;
}
function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function setCookie(res, name, value, options = {}) {
  const attrs = [`${name}=${value}`, 'Path=/', 'SameSite=Strict', 'HttpOnly'];
  if (options.maxAge !== undefined) attrs.push(`Max-Age=${options.maxAge}`);
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function page(title, body, csrf) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlEscape(title)} · Local Login</title><link rel="stylesheet" href="/style.css"></head><body><main class="shell"><header><span class="mark">LL</span><span>LOCAL LOGIN <small>SECURE WORKSPACE</small></span></header>${body}<footer>Local-only prototype · Keep this computer and its backups protected</footer></main><script>document.querySelectorAll('form[method="post"]').forEach(f=>{let i=document.createElement('input');i.type='hidden';i.name='_csrf';i.value=${JSON.stringify(csrf)};f.appendChild(i)});</script></body></html>`;
}
function send(res, status, content, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'Cache-Control':'no-store' });
  res.end(content);
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('='); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
  }));
}
async function readForm(req) {
  let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 16384) throw new Error('Request too large'); }
  return new URLSearchParams(data);
}
function getSession(req) {
  const token = cookies(req).sid;
  if (!token) return null;
  const row = db.prepare('SELECT users.id,users.username,users.role,users.active,sessions.token_hash FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').get(hashToken(token), Date.now());
  if (!row || !row.active) return null;
  return { ...row, token };
}
const attempts = new Map();
function throttled(key) { const entry = attempts.get(key); return !!entry && entry.count >= 8 && Date.now() - entry.first < 15 * 60_000; }
function failed(key) { const entry = attempts.get(key) || { count: 0, first: Date.now() }; entry.count++; attempts.set(key, entry); }
function succeeded(key) { attempts.delete(key); }
function roleCanManageUsers(role) { return role === 'manager' || role === 'admin' || role === 'administrator'; }
function isAdmin(role) { return role === 'admin' || role === 'administrator'; }
function auditPage(rows) { return rows.map(r => `<tr><td>${htmlEscape(r.created_at)}</td><td>${htmlEscape(r.actor || 'system')}</td><td>${htmlEscape(r.event)}</td><td>${htmlEscape(r.target)}</td></tr>`).join(''); }

const server = createServer(async (req, res) => {
  try {
    let url;
    try { url = new URL(req.url || '/', 'http://127.0.0.1'); }
    catch { return send(res, 400, 'Bad request', 'text/plain; charset=utf-8'); }
    if (req.method === 'GET' && url.pathname === '/style.css') {
      return send(res, 200, css, 'text/css; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'ok', 'text/plain');
    let csrf = cookies(req).csrf;
    if (!csrf || !/^[a-f0-9]{64}$/.test(csrf)) { csrf = randomBytes(32).toString('hex'); res.setHeader('Set-Cookie', `csrf=${csrf}; Path=/; SameSite=Strict`); }
    const session = getSession(req);
    if (req.method === 'GET' && url.pathname === '/') {
      if (!session) return send(res, 200, page('Sign in', `<section class="intro"><p class="eyebrow">ACCOUNT ACCESS</p><h1>Sign in to continue.</h1><p class="muted">Use your assigned account and authenticator code.</p></section><form method="post" action="/login" class="card"><label>Username<input name="username" autocomplete="username" required maxlength="64"></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><label>Authenticator code<input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button>Sign in <span>→</span></button><p class="hint">Your account must be created by an authorized manager or administrator.</p></form>`, csrf));
      const records = db.prepare('SELECT records.id,records.body,records.created_at,users.username FROM records JOIN users ON users.id=records.owner_id ORDER BY records.id DESC LIMIT 30').all();
      const visible = isAdmin(session.role) ? records : records.filter(r => r.username.toLowerCase() === session.username.toLowerCase());
      const users = roleCanManageUsers(session.role) ? db.prepare('SELECT id,username,role,active FROM users ORDER BY username').all() : [];
      const logs = isAdmin(session.role) ? db.prepare('SELECT audit.created_at,actor.username AS actor,audit.event,audit.target FROM audit LEFT JOIN users actor ON actor.id=audit.actor_id ORDER BY audit.id DESC LIMIT 30').all() : [];
      const body = `<section class="intro"><p class="eyebrow">SIGNED IN AS ${htmlEscape(session.role.toUpperCase())}</p><h1>Welcome, ${htmlEscape(session.username)}.</h1><p class="muted">Your access is limited to the actions assigned to your role.</p><form method="post" action="/logout"><button class="secondary">Sign out</button></form></section>
        ${(session.role === 'inputer' || session.role === 'manager' || isAdmin(session.role)) ? `<section class="card"><h2>New input</h2><form method="post" action="/records"><label>Record details<textarea name="body" rows="3" maxlength="2000" required></textarea></label><button>Save input <span>→</span></button></form></section>` : ''}
        <section class="card"><h2>Recent records</h2>${visible.length ? `<div class="tablewrap"><table><thead><tr><th>Record</th><th>Entered by</th><th>Created</th></tr></thead><tbody>${visible.map(r=>`<tr><td>${htmlEscape(r.body)}</td><td>${htmlEscape(r.username)}</td><td>${htmlEscape(r.created_at)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No records to show.</p>'}</section>
        ${roleCanManageUsers(session.role) ? `<section class="card"><h2>Add an inputer</h2><p class="muted">The new user must receive the temporary password and authenticator setup details through a secure, separate channel.</p><form method="post" action="/users"><label>New username<input name="username" required minlength="3" maxlength="64" autocomplete="off"></label><label>Temporary password<input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label><button>Create inputer</button></form>${users.map(u=>`<div class="userrow"><span><b>${htmlEscape(u.username)}</b><small>${htmlEscape(u.role)} · ${u.active ? 'active':'disabled'}</small></span>${isAdmin(session.role) && u.role === 'inputer' && u.active ? `<form method="post" action="/users/delete"><input type="hidden" name="user_id" value="${u.id}"><button class="danger">Deactivate</button></form>`:''}</div>`).join('')}</section>` : ''}
        ${logs.length ? `<section class="card"><h2>Recent security events</h2><div class="tablewrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Target</th></tr></thead><tbody>${auditPage(logs)}</tbody></table></div></section>`:''}`;
      return send(res, 200, page('Workspace', body, csrf));
    }
    if (req.method !== 'POST') return send(res, 404, page('Not found', '<section class="intro"><h1>Page not found.</h1></section>', csrf));
    const form = await readForm(req);
    const origin = req.headers.origin;
    let validOrigin = false;
    try {
      const parsedOrigin = new URL(origin || '');
      validOrigin = parsedOrigin.protocol === 'http:' && parsedOrigin.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
    } catch { /* malformed or absent Origin is rejected below */ }
    if (!validOrigin || form.get('_csrf') !== cookies(req).csrf) return send(res, 403, page('Request rejected', '<h1>Request rejected.</h1><p>Reload the page and try again.</p>', csrf));
    if (url.pathname === '/login') {
      const username = (form.get('username') || '').trim(); const key = `${req.socket.remoteAddress}:${username.toLowerCase()}`;
      if (throttled(key)) return send(res, 429, page('Try later', '<h1>Too many attempts.</h1><p>Wait 15 minutes before trying again.</p>', csrf));
      const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE AND active=1').get(username);
      const validPassword = user ? await verifyPassword(form.get('password') || '', user.password_hash) : false;
      const otpStep = user && validPassword ? checkTotp(decryptSecret(user.totp_cipher), form.get('otp') || '') : null;
      const otpFresh = user && otpStep !== null && db.prepare('UPDATE users SET last_totp_step=? WHERE id=? AND last_totp_step<?').run(otpStep, user.id, otpStep).changes === 1;
      if (!user || !validPassword || !otpFresh) { failed(key); audit(user?.id, 'login_failed', username); return send(res, 401, page('Sign in', '<section class="intro"><h1>Sign in failed.</h1><p class="muted">Check your details or contact your manager.</p><a href="/">Return to sign in →</a></section>', csrf)); }
      succeeded(key); const token = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + 8 * 60 * 60_000);
      audit(user.id, 'login_success', user.username); setCookie(res, 'sid', encodeURIComponent(token), { maxAge: 8 * 60 * 60 }); res.writeHead(303, { Location:'/' }); return res.end();
    }
    if (!session) { res.writeHead(303, { Location:'/' }); return res.end(); }
    if (url.pathname === '/logout') {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash); audit(session.id, 'logout', session.username); setCookie(res, 'sid', '', { maxAge: 0 }); res.writeHead(303, { Location:'/' }); return res.end();
    }
    if (url.pathname === '/records') {
      if (!['inputer','manager','admin','administrator'].includes(session.role)) return send(res, 403, page('Forbidden','<h1>Access denied.</h1>',csrf));
      const body = (form.get('body') || '').trim(); if (!body || body.length > 2000) return send(res, 400, page('Invalid input','<h1>Please enter a record of 1–2,000 characters.</h1><a href="/">Return</a>',csrf));
      db.prepare('INSERT INTO records(owner_id,body) VALUES(?,?)').run(session.id, body); audit(session.id,'record_created',String(db.prepare('SELECT last_insert_rowid() AS id').get().id)); res.writeHead(303,{Location:'/'}); return res.end();
    }
    if (url.pathname === '/users') {
      if (!roleCanManageUsers(session.role)) return send(res,403,page('Forbidden','<h1>Access denied.</h1>',csrf));
      const username=(form.get('username')||'').trim(); const password=form.get('password')||'';
      if (!/^[A-Za-z0-9._-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) return send(res,400,page('Invalid account','<h1>Use a username with 3–64 letters, numbers, dots, underscores, or hyphens and a temporary password of at least 12 characters.</h1><a href="/">Return</a>',csrf));
      const secret=base32(randomBytes(20)); const passwordHash=await makePasswordHash(password);
      try {
        const result=db.prepare('INSERT INTO users(username,password_hash,role,totp_cipher) VALUES(?,?,?,?)').run(username,passwordHash,'inputer',encryptSecret(secret));
        audit(session.id,'inputer_created',username);
        const uri=`otpauth://totp/${encodeURIComponent('Local Login:'+username)}?secret=${secret}&issuer=Local%20Login&algorithm=SHA1&digits=6&period=30`;
        return send(res,201,page('Inputer created',`<section class="intro"><p class="eyebrow">ACCOUNT CREATED</p><h1>${htmlEscape(username)} is ready.</h1><p>Give the TOTP secret below to the inputer through a separate trusted channel. They must add it to an authenticator app before signing in.</p><div class="secret">${htmlEscape(secret)}</div><p class="muted">Provisioning URI (for compatible enrollment tools):</p><code class="uri">${htmlEscape(uri)}</code><p><a href="/">Return to workspace →</a></p></section>`,csrf));
      } catch { return send(res,409,page('Account exists','<h1>That username is already in use.</h1><a href="/">Return</a>',csrf)); }
    }
    if (url.pathname === '/users/delete') {
      if (!isAdmin(session.role)) return send(res,403,page('Forbidden','<h1>Access denied.</h1>',csrf));
      const target=db.prepare('SELECT id,username,role FROM users WHERE id=?').get(Number(form.get('user_id')));
      if (!target || target.role !== 'inputer') return send(res,403,page('Forbidden','<h1>Only inputer accounts can be deactivated here.</h1><a href="/">Return</a>',csrf));
      db.prepare('UPDATE users SET active=0 WHERE id=?').run(target.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); audit(session.id,'inputer_deactivated',target.username); res.writeHead(303,{Location:'/'}); return res.end();
    }
    return send(res,404,page('Not found','<h1>Page not found.</h1>',csrf));
  } catch (error) {
    console.error('Request error:', error.message);
    if (!res.headersSent) send(res, 500, page('Service error','<h1>Something went wrong.</h1><p class="muted">The event was recorded on the local server.</p>', cookies(req).csrf || ''));
    else res.end();
  }
});

const css = `:root{color-scheme:light;--ink:#142d3a;--muted:#647681;--line:#dbe3e5;--green:#176b55;--paper:#f5f8f7}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 Inter,Segoe UI,Arial,sans-serif}.shell{max-width:760px;margin:0 auto;padding:26px 22px 44px}header{display:flex;align-items:center;gap:12px;font-size:12px;font-weight:800;letter-spacing:.12em}header small{display:block;color:var(--muted);font-size:9px;letter-spacing:.17em;margin-top:2px}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:var(--green);color:#fff;font-size:13px} .intro{padding:46px 4px 22px}.eyebrow{font-size:10px;font-weight:800;letter-spacing:.18em;color:var(--green)}h1{font-size:clamp(32px,6vw,48px);line-height:1.08;letter-spacing:-.04em;margin:8px 0 12px}h2{font-size:18px;letter-spacing:-.02em;margin:0 0 15px}.muted,.hint{color:var(--muted)}.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px;margin:14px 0;box-shadow:0 8px 28px #183c4a08}label{display:block;font-size:12px;font-weight:700;margin:14px 0;color:#3c515c}input,textarea{display:block;width:100%;margin-top:7px;padding:12px 13px;border:1px solid #cad6da;border-radius:9px;background:#fff;color:var(--ink);font:inherit;outline:none}input:focus,textarea:focus{border-color:var(--green);box-shadow:0 0 0 3px #176b5519}button{border:0;background:var(--green);color:#fff;border-radius:9px;padding:12px 16px;font:700 13px inherit;cursor:pointer}button span{margin-left:12px}.secondary{background:#e9f0ee;color:var(--ink)}.danger{background:#fff0ee;color:#9b3027;padding:8px 11px}.hint{font-size:12px;margin:14px 0 0}.tablewrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #edf1f2;vertical-align:top}th{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.1em}.userrow{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #edf1f2;padding:12px 0}.userrow small{display:block;color:var(--muted);font-size:11px}.secret{padding:14px;border:1px dashed #8caaa0;background:#f2f8f5;border-radius:9px;font:700 18px ui-monospace,monospace;letter-spacing:.14em;overflow-wrap:anywhere}.uri{display:block;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7f6;padding:12px;border-radius:8px}a{color:var(--green);font-weight:700;text-decoration:none}footer{padding:20px 4px;color:var(--muted);font-size:11px} `;

async function bootstrapAdmin() {
  const username = (process.env.BOOTSTRAP_ADMIN_USERNAME || '').trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username) || password.length < 16) {
    console.error('Set BOOTSTRAP_ADMIN_USERNAME and a unique BOOTSTRAP_ADMIN_PASSWORD (at least 16 characters) for this one-time command.'); process.exit(1);
  }
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) { console.error('Users already exist; bootstrap is disabled.'); process.exit(1); }
  const secret = base32(randomBytes(20));
  const hash = await makePasswordHash(password);
  const result = db.prepare('INSERT INTO users(username,password_hash,role,totp_cipher) VALUES(?,?,?,?)').run(username,hash,'administrator',encryptSecret(secret));
  audit(Number(result.lastInsertRowid),'administrator_bootstrapped',username);
  console.log(`Created administrator ${username}. Add this secret to an authenticator app now: ${secret}`);
  console.log(`Provisioning URI: otpauth://totp/${encodeURIComponent('Local Login:'+username)}?secret=${secret}&issuer=Local%20Login&algorithm=SHA1&digits=6&period=30`);
  console.log('Remove BOOTSTRAP_ADMIN_PASSWORD from the shell immediately. Protect and back up the two application secrets.');
}

if (process.argv[2] === 'bootstrap-admin') await bootstrapAdmin();
else {
  server.listen(port, '127.0.0.1', () => console.log(`Local Login is listening at http://127.0.0.1:${port}`));
}
