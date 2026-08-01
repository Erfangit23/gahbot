import db from './database.js';

/**
 * Lightweight conversation memory engine.
 * Caches and summarizes chat data locally WITHOUT calling the LLM.
 * When the AI needs context, it gets a compact summary instead of raw messages.
 */

const MESSAGE_CACHE_LIMIT = 200; // Keep last 200 messages per topic in memory
const SUMMARY_INTERVAL = 20; // Generate a local summary every 20 messages

// In-memory cache: chat_id:thread_id -> { messages: [], lastSummary: '', messageCount: 0 }
const cache = new Map();

function cacheKey(chat_id, thread_id) {
  return `${chat_id}:${thread_id || 'general'}`;
}

/**
 * Add a message to the local cache (no LLM call)
 */
export function cacheMessage({ chat_id, thread_id, user_id, username, first_name, text }) {
  const key = cacheKey(chat_id, thread_id);
  if (!cache.has(key)) {
    cache.set(key, { messages: [], lastSummary: '', messageCount: 0 });
  }
  const entry = cache.get(key);
  entry.messages.push({ user_id, username, first_name, text, timestamp: Date.now() });
  entry.messageCount++;

  // Trim cache
  if (entry.messages.length > MESSAGE_CACHE_LIMIT) {
    entry.messages = entry.messages.slice(-MESSAGE_CACHE_LIMIT);
  }

  // Update local summary every N messages (purely local, no AI)
  if (entry.messageCount % SUMMARY_INTERVAL === 0) {
    updateLocalSummary(entry);
  }
}

/**
 * Generate a local summary of recent conversation (no LLM — just structure data)
 */
function updateLocalSummary(entry) {
  const recent = entry.messages.slice(-SUMMARY_INTERVAL);
  const participants = [...new Set(recent.map(m => m.first_name || m.username || 'ناشناس'))];
  const topics = extractTopics(recent.map(m => m.text).join(' '));
  
  entry.lastSummary = {
    participants,
    topics,
    messageCount: entry.messageCount,
    timeRange: {
      start: recent[0]?.timestamp,
      end: recent[recent.length - 1]?.timestamp,
    },
    lastMessages: recent.slice(-5).map(m => ({
      who: m.first_name || m.username || 'ناشناس',
      text: m.text.substring(0, 100),
    })),
  };
}

/**
 * Extract topics locally using simple patterns (no AI)
 */
function extractTopics(text) {
  const lower = text.toLowerCase();
  const topics = [];
  
  const patterns = {
    'سیاست': /جنگ|تحریم|انتخاب|دولت|حکومت|سیاست|ترامپ|آمریکا|ایران|اسرائیل|فلسطین/,
    'پول و اقتصاد': /دلار|تورم|قیمت|بازار|کریپتو|بیت|ترید|پول|دبی|ثروت/,
    'سکس و رابطه': /سکس|دختر|کراش|عاشق|دوست|دلاپ|سیدنی|انا|فمبوی|خوشگل/,
    'موسیقی': /گیتار|موسیقی|آهنگ|اسپاتیفای|کنسرت|رپ/,
    'تکنولوژی': /برنامه|پایتون|کد|هک|لینوکس|کالی|سیستم|کامپیوتر/,
    'مدرسه': /درس|امتحان|معلم|کلاس|همکلاسی|مدرسه|ریاضی/,
    'مهاجرت': /مهاجرت|ترک|کانادا|آمریکا|ورود|ویزا/,
  };

  for (const [topic, pattern] of Object.entries(patterns)) {
    if (pattern.test(lower)) topics.push(topic);
  }
  
  return topics;
}

/**
 * Get compact conversation context for the AI
 * Returns a formatted string with participants, topics, and recent messages
 * This is MUCH cheaper than sending 50 raw messages to the LLM
 */
export function getConversationContext(chat_id, thread_id, limit = 15) {
  const key = cacheKey(chat_id, thread_id);
  const entry = cache.get(key);

  // Also pull from database in case cache was cleared
  const dbMessages = getRecentFromDb(chat_id, thread_id, limit);
  
  if (dbMessages.length === 0) return '';

  const participants = [...new Set(dbMessages.map(m => m.first_name || m.username || 'ناشناس'))];
  const topics = extractTopics(dbMessages.map(m => m.text).join(' '));
  
  let context = `\n## خلاصه گفتگو (${dbMessages.length} پیام اخیر):\n`;
  context += `پارتیسیپنت‌ها: ${participants.join('، ')}\n`;
  if (topics.length > 0) {
    context += `موضوعات: ${topics.join('، ')}\n`;
  }
  context += `\n### پیام‌های اخیر:\n`;
  
  context += dbMessages
    .map(m => {
      const name = m.first_name || m.username || 'ناشناس';
      const time = new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${name}: ${m.text}`;
    })
    .join('\n');

  return context;
}

function getRecentFromDb(chat_id, thread_id, limit) {
  if (thread_id === null || thread_id === undefined) {
    return db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ? AND thread_id IS NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(chat_id, limit).reverse();
  }
  return db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ? AND thread_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(chat_id, thread_id, limit).reverse();
}

/**
 * Get who replied to whom (conversation threads)
 */
export function getConversationThreads(chat_id, thread_id, limit = 20) {
  const messages = getRecentFromDb(chat_id, thread_id, limit);
  
  // Group messages into conversation threads based on who's talking to whom
  // Simple heuristic: if person A and person B alternate messages, they're in a conversation
  const threads = [];
  let currentThread = [];
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (currentThread.length === 0) {
      currentThread.push(msg);
    } else {
      const lastMsg = currentThread[currentThread.length - 1];
      const sameTimeFrame = (msg.created_at - lastMsg.created_at) < 5 * 60 * 1000; // 5 min
      if (sameTimeFrame) {
        currentThread.push(msg);
      } else {
        if (currentThread.length >= 2) threads.push(currentThread);
        currentThread = [msg];
      }
    }
  }
  if (currentThread.length >= 2) threads.push(currentThread);
  
  return threads;
}
