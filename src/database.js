import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'gahmood.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---

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
    created_at INTEGER NOT NULL,
    raw_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_thread_time
    ON messages(chat_id, thread_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS speakers (
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    message_count INTEGER DEFAULT 0,
    tone_profile TEXT,
    last_updated INTEGER NOT NULL,
    UNIQUE(user_id, chat_id)
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

  CREATE INDEX IF NOT EXISTS idx_bot_replies_chat_thread_time
    ON bot_replies(chat_id, thread_id, created_at DESC);
`);

// --- Message operations ---

export function storeMessage({ telegram_msg_id, chat_id, thread_id, user_id, username, first_name, text, raw_json }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO messages (telegram_msg_id, chat_id, thread_id, user_id, username, first_name, text, created_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(telegram_msg_id, chat_id, thread_id || null, user_id, username || null, first_name || null, text, now, raw_json || null);

  // Upsert speaker
  db.prepare(`
    INSERT INTO speakers (user_id, chat_id, username, first_name, message_count, last_updated)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(user_id, chat_id)
    DO UPDATE SET
      message_count = message_count + 1,
      username = COALESCE(excluded.username, speakers.username),
      first_name = COALESCE(excluded.first_name, speakers.first_name),
      last_updated = excluded.last_updated
  `).run(user_id, chat_id, username || null, first_name || null, now);
}

export function getRecentMessages(chat_id, thread_id, limit = 50) {
  // If thread_id is null, get messages without a thread (General topic or non-forum group)
  if (thread_id === null || thread_id === undefined) {
    return db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ? AND thread_id IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(chat_id, limit).reverse();
  }

  // Get messages from the specific topic thread
  return db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ? AND thread_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(chat_id, thread_id, limit).reverse();
}

export function getMessagesByUser(user_id, chat_id, thread_id, limit = 30) {
  if (thread_id === null || thread_id === undefined) {
    return db.prepare(`
      SELECT * FROM messages
      WHERE user_id = ? AND chat_id = ? AND thread_id IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(user_id, chat_id, limit).reverse();
  }

  return db.prepare(`
    SELECT * FROM messages
    WHERE user_id = ? AND chat_id = ? AND thread_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(user_id, chat_id, thread_id, limit).reverse();
}

// --- Speaker profile operations ---

export function getSpeakerProfile(user_id, chat_id) {
  const row = db.prepare(`
    SELECT * FROM speakers WHERE user_id = ? AND chat_id = ?
  `).get(user_id, chat_id);
  return row;
}

export function getAllSpeakers(chat_id, thread_id) {
  if (thread_id === null || thread_id === undefined) {
    return db.prepare(`
      SELECT s.* FROM speakers s
      WHERE s.chat_id = ?
      ORDER BY s.message_count DESC
    `).all(chat_id);
  }

  // For topic-specific speaker stats, we need to count from messages
  return db.prepare(`
    SELECT s.*, COUNT(m.id) as topic_message_count
    FROM speakers s
    JOIN messages m ON s.user_id = m.user_id AND s.chat_id = m.chat_id
    WHERE s.chat_id = ? AND m.thread_id = ?
    GROUP BY s.user_id
    ORDER BY topic_message_count DESC
  `).all(chat_id, thread_id);
}

export function updateSpeakerToneProfile(user_id, chat_id, toneProfile) {
  db.prepare(`
    UPDATE speakers SET tone_profile = ?, last_updated = ?
    WHERE user_id = ? AND chat_id = ?
  `).run(JSON.stringify(toneProfile), Date.now(), user_id, chat_id);
}

export function getGroupToneSample(chat_id, thread_id, limit = 100) {
  if (thread_id === null || thread_id === undefined) {
    return db.prepare(`
      SELECT m.* FROM messages m
      WHERE m.chat_id = ? AND m.thread_id IS NULL
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(chat_id, limit).reverse();
  }

  return db.prepare(`
    SELECT m.* FROM messages m
    WHERE m.chat_id = ? AND m.thread_id = ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(chat_id, thread_id, limit).reverse();
}

// --- Bot reply operations ---

export function storeBotReply({ chat_id, thread_id, trigger_msg_id, reply_text, topic }) {
  db.prepare(`
    INSERT INTO bot_replies (chat_id, thread_id, trigger_msg_id, reply_text, topic, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(chat_id, thread_id || null, trigger_msg_id || null, reply_text, topic || null, Date.now());
}

export function getLastBotReplyTime(chat_id, thread_id) {
  if (thread_id === null || thread_id === undefined) {
    const row = db.prepare(`
      SELECT created_at FROM bot_replies
      WHERE chat_id = ? AND thread_id IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(chat_id);
    return row ? row.created_at : 0;
  }

  const row = db.prepare(`
    SELECT created_at FROM bot_replies
    WHERE chat_id = ? AND thread_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(chat_id, thread_id);
  return row ? row.created_at : 0;
}

export function getBotReplyCount(chat_id, thread_id, since) {
  if (thread_id === null || thread_id === undefined) {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM bot_replies
      WHERE chat_id = ? AND thread_id IS NULL AND created_at >= ?
    `).get(chat_id, since);
    return row.count;
  }

  const row = db.prepare(`
    SELECT COUNT(*) as count FROM bot_replies
    WHERE chat_id = ? AND thread_id = ? AND created_at >= ?
  `).get(chat_id, thread_id, since);
  return row.count;
}

export default db;
