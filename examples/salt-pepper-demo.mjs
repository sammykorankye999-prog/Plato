// EDUCATIONAL DEMO ONLY. This is not used by the Supabase login system.
// Real accounts stay under Supabase Auth; never store the pepper with user rows.
import { createHmac, randomBytes, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function getPepper() {
  const pepper = process.env.PASSWORD_PEPPER;
  if (!pepper || Buffer.byteLength(pepper, 'utf8') < 32) {
    throw new Error('Set PASSWORD_PEPPER to a random secret of at least 32 bytes. Keep it outside the account database.');
  }
  return Buffer.from(pepper, 'utf8');
}

async function derive(password, salt, pepper) {
  const pepperedPassword = createHmac('sha256', pepper).update(password, 'utf8').digest();
  return scrypt(pepperedPassword, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });
}

export async function hashPasswordForDemo(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('Use a password of at least 12 characters for this demonstration.');
  }
  const salt = randomBytes(16); // Fresh random salt for each account/password.
  const digest = await derive(password, salt, getPepper());
  return {
    algorithm: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString('base64'),
    hash: digest.toString('base64'),
  };
}

export async function verifyPasswordForDemo(password, storedRecord) {
  if (storedRecord?.algorithm !== 'scrypt' || storedRecord.N !== SCRYPT_N || storedRecord.r !== SCRYPT_R || storedRecord.p !== SCRYPT_P) {
    return false;
  }
  try {
    const salt = Buffer.from(storedRecord.salt, 'base64');
    const expected = Buffer.from(storedRecord.hash, 'base64');
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
    const actual = await derive(password, salt, getPepper());
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const password = process.env.DEMO_PASSWORD;
  if (!password) {
    throw new Error('Set DEMO_PASSWORD in this local shell to run the illustration. It is not sent or saved by this script.');
  }
  const storedRecord = await hashPasswordForDemo(password);
  console.log('Educational database row (salt and hash only; pepper is not included):');
  console.log(JSON.stringify(storedRecord, null, 2));
  console.log('Correct password verifies:', await verifyPasswordForDemo(password, storedRecord));
  console.log('Different password verifies:', await verifyPasswordForDemo(`${password}!wrong`, storedRecord));
}
