import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCb);
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = join(root, 'data');
const vaultPath = join(dataDir, 'secrets.vault');
const dbPath = join(dataDir, 'login.sqlite');
mkdirSync(dataDir, { recursive: true });

function ask(prompt, mask = false) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('Run this command in an interactive PowerShell terminal.');
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); };
    const onData = chunk => {
      const input = chunk.toString('utf8');
      for (const char of input) {
        if (char === '\u0003') { cleanup(); process.stdout.write('\n'); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); process.stdout.write('\n'); resolve(value); return; }
        if (char === '\u007f' || char === '\b') {
          if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (char >= ' ' && char !== '\u007f') { value += char; process.stdout.write(mask ? '*' : char); }
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8'); process.stdin.on('data', onData);
  });
}

async function encryptVault(secrets, passphrase) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  const file = { version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  writeFileSync(vaultPath, JSON.stringify(file), { flag: 'wx' });
}

async function decryptVault(passphrase) {
  const file = JSON.parse(readFileSync(vaultPath, 'utf8'));
  if (file.version !== 1) throw new Error('Unsupported local secrets vault version.');
  const salt = Buffer.from(file.salt, 'base64'), iv = Buffer.from(file.iv, 'base64');
  const key = await scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  const clear = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(clear.toString('utf8'));
}

function encryptTotpSeed(seed, secret) {
  const key = createHash('sha256').update(secret, 'utf8').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(seed, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.');
}

function makeBase32(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

function hasUsers() {
  if (!existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
    return !!table && Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) > 0;
  } finally { db.close(); }
}

try {
  let secrets;
  if (existsSync(vaultPath)) {
    const passphrase = await ask('Secrets vault passphrase: ', true);
    if (passphrase.length < 16) throw new Error('Passphrase must be at least 16 characters.');
    try { secrets = await decryptVault(passphrase); }
    catch { throw new Error('Could not unlock the secrets vault. Check the passphrase.'); }
  } else {
    if (hasUsers()) throw new Error('A database with users already exists but its secrets vault is missing. Restore the original vault; do not generate replacement secrets.');
    const passphrase = await ask('Create a vault passphrase (at least 16 characters): ', true);
    if (passphrase.length < 16) throw new Error('Passphrase must be at least 16 characters.');
    const confirm = await ask('Re-enter vault passphrase: ', true);
    if (passphrase !== confirm) throw new Error('Passphrases did not match. Start again.');
    secrets = {
      PASSWORD_PEPPER: randomBytes(48).toString('base64url'),
      MFA_ENCRYPTION_KEY: randomBytes(48).toString('base64url'),
      PORT: process.env.PORT || '3000'
    };
    await encryptVault(secrets, passphrase);
    console.log('Created encrypted local secrets vault. Keep the passphrase and back up data/secrets.vault securely.');
  }

  if (!secrets.PASSWORD_PEPPER || !secrets.MFA_ENCRYPTION_KEY) throw new Error('Vault is missing required secrets.');
  if (process.argv[2] === 'reset-admin-mfa') {
    if (!hasUsers()) throw new Error('No administrator account exists yet.');
    const username = (await ask('Administrator username to reset: ')).trim();
    const db = new DatabaseSync(dbPath);
    try {
      const user = db.prepare("SELECT id,username,role FROM users WHERE username=? COLLATE NOCASE AND active=1").get(username);
      if (!user || !['admin','administrator'].includes(user.role)) throw new Error('That active administrator account was not found.');
      const seed = makeBase32(randomBytes(20));
      db.prepare('UPDATE users SET totp_cipher=?,last_totp_step=0 WHERE id=?').run(encryptTotpSeed(seed, secrets.MFA_ENCRYPTION_KEY), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      db.prepare('INSERT INTO audit(actor_id,event,target) VALUES(?,?,?)').run(null, 'administrator_mfa_reset', user.username);
      console.log(`\nNew authenticator secret for ${user.username}: ${seed}`);
      console.log(`Provisioning URI: otpauth://totp/${encodeURIComponent('Local Login:'+user.username)}?secret=${seed}&issuer=Local%20Login&algorithm=SHA1&digits=6&period=30`);
      console.log('Add this to the authenticator app, then delete this terminal output. Do not share the new secret.');
    } finally { db.close(); }
    process.exit(0);
  }
  if (!hasUsers()) {
    console.log('\nCreate the first administrator. The password is entered only in this terminal.');
    const username = (await ask('Administrator username: ')).trim();
    const password = await ask('Administrator password (at least 16 characters): ', true);
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username) || password.length < 16) throw new Error('Invalid username or password length.');
    const env = { ...process.env, ...secrets, BOOTSTRAP_ADMIN_USERNAME: username, BOOTSTRAP_ADMIN_PASSWORD: password };
    const result = spawnSync(process.execPath, ['server.mjs', 'bootstrap-admin'], { cwd: root, env, stdio: 'inherit' });
    delete env.BOOTSTRAP_ADMIN_PASSWORD;
    if (result.status !== 0) throw new Error('Administrator bootstrap failed. Correct the issue and run start.mjs again.');
  }

  console.log('\nStarting Local Login at http://127.0.0.1:' + (secrets.PORT || '3000') + '  (Ctrl+C to stop)');
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, ...secrets }, stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
} catch (error) {
  console.error('\n' + error.message);
  process.exitCode = 1;
}
