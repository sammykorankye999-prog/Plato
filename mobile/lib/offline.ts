import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const KEY_NAME = 'offline_database_key_v1';
let database: SQLite.SQLiteDatabase | null = null;

export async function localQueue() {
  if (database) return database;
  let key = await SecureStore.getItemAsync(KEY_NAME);
  if (!key) {
    key = Array.from(await Crypto.getRandomBytesAsync(32)).map(byte => byte.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(KEY_NAME, key);
  }
  const db = await SQLite.openDatabaseAsync('secure-workspace.db');
  await db.execAsync(`PRAGMA key = '${key}';`);
  const cipher = await db.getFirstAsync<{ cipher: string }>('PRAGMA cipher_version;');
  if (!cipher?.cipher) {
    await db.closeAsync();
    throw new Error('SQLCipher is unavailable in this native build. Rebuild the development app with the SQLCipher config plugin enabled.');
  }
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS pending_inputs (
      id TEXT PRIMARY KEY NOT NULL,
      owner_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sync_state TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  database = db;
  return db;
}
