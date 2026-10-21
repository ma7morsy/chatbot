const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS bots(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  welcome TEXT NOT NULL DEFAULT 'Hi! How can I help you today?',
  instructions TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'openai', base_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  model TEXT NOT NULL DEFAULT 'gpt-4o-mini', api_key_enc TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY, bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL, chars INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS conversations(
  id INTEGER PRIMARY KEY, bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  session TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(bot_id, session));
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL, sources TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  text, bot_id UNINDEXED, doc_id UNINDEXED, doc_name UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2');
`);

// AES-256-GCM for provider API keys stored in the database
const KEY = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || '').digest();
function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob) return '';
  try {
    const [iv, tag, enc] = blob.split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return ''; }
}
module.exports = { db, encrypt, decrypt };
