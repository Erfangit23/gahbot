import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'gahmood.db');

const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const SCHEMA_VERSION = 4;
const currentVersion = db.pragma('user_version', { simple: true }) || 0;

if (currentVersion < SCHEMA_VERSION) {
  console.log(`[DB] Migrating v${currentVersion} → v${SCHEMA_VERSION}...`);
  db.exec(`DROP TABLE IF EXISTS speakers`);
  db.exec(`DROP TABLE IF EXISTS messages`);
  db.exec(`DROP TABLE IF EXISTS bot_replies`);
  db.exec(`DROP TABLE IF EXISTS group_summary`);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  console.log('[DB] Migration done.');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_msg_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    thread_id INTEGER,
    user_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    text TEXT NOT NULL,
    reply_to_user_id INTEGER,
    reply_to_msg_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_chat_thread ON messages(chat_id, thread_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(user_id, chat_id);

  CREATE TABLE IF NOT EXISTS speakers (
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    message_count INTEGER DEFAULT 0,
    avg_msg_length REAL DEFAULT 0,
    swear_count INTEGER DEFAULT 0,
    frequent_words TEXT,
    active_hours TEXT,
    tone_profile TEXT,
    last_updated INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS bot_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    thread_id INTEGER,
    trigger_msg_id INTEGER,
    reply_text TEXT NOT NULL,
    topic TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_summary (
    chat_id INTEGER NOT NULL,
    thread_id INTEGER,
    summary TEXT,
    participants TEXT,
    topics TEXT,
    message_count INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, thread_id)
  );

  CREATE TABLE IF NOT EXISTS learned_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    fact TEXT NOT NULL,
    taught_by TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_learned_chat ON learned_facts(chat_id);
`);

// --- Message operations ---

export function storeMessage({ telegram_msg_id, chat_id, thread_id, user_id, username, first_name, text, reply_to_user_id, reply_to_msg_id }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO messages (telegram_msg_id, chat_id, thread_id, user_id, username, first_name, text, reply_to_user_id, reply_to_msg_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(telegram_msg_id, chat_id, thread_id || null, user_id, username || null, first_name || null, text, reply_to_user_id || null, reply_to_msg_id || null, now);
}

export function getRecentMessages(chat_id, thread_id, limit = 15) {
  if (!thread_id) {
    return db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND thread_id IS NULL ORDER BY created_at DESC LIMIT ?`).all(chat_id, limit).reverse();
  }
  return db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT ?`).all(chat_id, thread_id, limit).reverse();
}

export function getMessageCount(chat_id, thread_id) {
  if (!thread_id) {
    return db.prepare(`SELECT COUNT(*) as count FROM messages WHERE chat_id = ? AND thread_id IS NULL`).get(chat_id).count;
  }
  return db.prepare(`SELECT COUNT(*) as count FROM messages WHERE chat_id = ? AND thread_id = ?`).get(chat_id, thread_id).count;
}

export function getMessagesByUser(user_id, chat_id, limit = 20) {
  return db.prepare(`SELECT * FROM messages WHERE user_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT ?`).all(user_id, chat_id, limit).reverse();
}

// --- Speaker operations ---

export function updateSpeakerStats(chat_id, user_id, username, first_name, text) {
  const now = Date.now();
  const existing = db.prepare(`SELECT * FROM speakers WHERE user_id = ? AND chat_id = ?`).get(user_id, chat_id);

  if (existing) {
    const newCount = existing.message_count + 1;
    const newAvg = ((existing.avg_msg_length * existing.message_count) + text.length) / newCount;
    const hour = new Date().getHours();
    let hours = {};
    try { hours = JSON.parse(existing.active_hours || '{}'); } catch {}
    hours[hour] = (hours[hour] || 0) + 1;

    db.prepare(`
      UPDATE speakers SET message_count = ?, avg_msg_length = ?, username = COALESCE(?, username), first_name = COALESCE(?, first_name), active_hours = ?, last_updated = ?
      WHERE user_id = ? AND chat_id = ?
    `).run(newCount, newAvg, username, first_name, JSON.stringify(hours), now, user_id, chat_id);
  } else {
    const hour = new Date().getHours();
    db.prepare(`
      INSERT INTO speakers (user_id, chat_id, username, first_name, message_count, avg_msg_length, active_hours, last_updated)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run(user_id, chat_id, username || null, first_name || null, text.length, JSON.stringify({ [hour]: 1 }), now);
  }
}

export function getSpeakerStats(user_id, chat_id) {
  return db.prepare(`SELECT * FROM speakers WHERE user_id = ? AND chat_id = ?`).get(user_id, chat_id);
}

export function getAllSpeakers(chat_id) {
  return db.prepare(`SELECT * FROM speakers WHERE chat_id = ? ORDER BY message_count DESC`).all(chat_id);
}

// --- Bot reply operations ---

export function storeBotReply({ chat_id, thread_id, trigger_msg_id, reply_text, topic }) {
  db.prepare(`INSERT INTO bot_replies (chat_id, thread_id, trigger_msg_id, reply_text, topic, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(chat_id, thread_id || null, trigger_msg_id || null, reply_text, topic || null, Date.now());
}

// --- Group summary (batch-computed, stored for reuse) ---

export function getGroupSummary(chat_id, thread_id) {
  return db.prepare(`SELECT * FROM group_summary WHERE chat_id = ? AND (thread_id = ? OR (thread_id IS NULL AND ? IS NULL))`)
    .get(chat_id, thread_id || null, thread_id || null);
}

export function saveGroupSummary(chat_id, thread_id, summary, participants, topics, messageCount) {
  db.prepare(`
    INSERT INTO group_summary (chat_id, thread_id, summary, participants, topics, message_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, thread_id) DO UPDATE SET
      summary = excluded.summary,
      participants = excluded.participants,
      topics = excluded.topics,
      message_count = excluded.message_count,
      updated_at = excluded.updated_at
  `).run(chat_id, thread_id || null, summary, JSON.stringify(participants), JSON.stringify(topics), messageCount, Date.now());
}

// --- Learned facts ---

export function saveLearnedFact(chat_id, fact, taughtBy) {
  db.prepare(`INSERT INTO learned_facts (chat_id, fact, taught_by, created_at) VALUES (?, ?, ?, ?)`)
    .run(chat_id, fact, taughtBy || null, Date.now());
  console.log(`[Learn] Saved: ${fact.substring(0, 80)}`);
}

export function getLearnedFacts(chat_id) {
  return db.prepare(`SELECT * FROM learned_facts WHERE chat_id = ? ORDER BY created_at DESC LIMIT 30`).all(chat_id);
}

export default db;
