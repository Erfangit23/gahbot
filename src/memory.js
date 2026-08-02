/**
 * Local analysis engine — processes chat data WITHOUT any AI calls.
 * All operations are pure JavaScript + SQLite.
 */

import { getRecentMessages, getMessagesByUser, getSpeakerStats, getAllSpeakers, getMessageCount, saveGroupSummary, getGroupSummary, db } from './database.js';

// Common Persian swear words for detection
const SWEAR_WORDS = ['کیر', 'کص', 'گایید', 'جق', 'خرف', 'چرت', 'کصخلع', 'شاش', 'کون', 'ننه', 'بیناموس'];

/**
 * Extract frequent words from a user's messages (local, no AI)
 */
export function extractFrequentWords(userId, chatId, limit = 15) {
  const messages = getMessagesByUser(userId, chatId, 50);
  const wordCount = {};

  for (const msg of messages) {
    const words = msg.text.split(/\s+/);
    for (const word of words) {
      const clean = word.replace(/[!?.,،؛:"'@#$%^&*()_+=\[\]{}<>\/\\|`~]/g, '').toLowerCase();
      if (clean.length < 3) continue;
      wordCount[clean] = (wordCount[clean] || 0) + 1;
    }
  }

  return Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

/**
 * Count swears in a user's messages (local)
 */
export function countSwears(userId, chatId) {
  const messages = getMessagesByUser(userId, chatId, 30);
  let count = 0;
  for (const msg of messages) {
    const lower = msg.text.toLowerCase();
    for (const swear of SWEAR_WORDS) {
      if (lower.includes(swear)) count++;
    }
  }
  return count;
}

/**
 * Detect topics from messages (local pattern matching)
 */
export function detectTopics(messages) {
  const text = messages.map(m => m.text).join(' ').toLowerCase();
  const topics = [];

  const patterns = {
    'سیاست': /جنگ|تحریم|انتخاب|دولت|حکومت|سیاست|ترامپ|آمریکا|ایران|اسرائیل|فلسطین|حمله|موشک/,
    'پول و اقتصاد': /دلار|تورم|قیمت|بازار|کریپتو|بیت|ترید|پول|دبی|ثروت|درآمد/,
    'سکس و رابطه': /سکس|دختر|کراش|عاشق|دوست|سیدنی|انا|فمبوی|خوشگل|دلاپ|بوس/,
    'موسیقی': /گیتار|موسیقی|آهنگ|اسپاتیفای|کنسرت|رپ|دوالبیپا/,
    'تکنولوژی': /برنامه|پایتون|کد|هک|لینوکس|کالی|سیستم|کامپیوتر|سرور/,
    'مدرسه': /درس|امتحان|معلم|کلاس|همکلاسی|مدرسه|ریاضی/,
    'مهاجرت': /مهاجرت|ترک|کانادا|آمریکا|ورود|ویزا|پاسپورت/,
  };

  for (const [topic, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) topics.push(topic);
  }
  return topics;
}

/**
 * Build a conversation graph: who talks to whom (local)
 */
export function getConversationGraph(chatId, threadId) {
  const messages = getRecentMessages(chatId, threadId, 50);
  const graph = {};

  for (const msg of messages) {
    if (msg.reply_to_user_id) {
      const from = msg.first_name || msg.username || 'ناشناس';
      const key = `${from}`;
      if (!graph[key]) graph[key] = {};
      graph[key][msg.reply_to_user_id] = (graph[key][msg.reply_to_user_id] || 0) + 1;
    }
  }

  return graph;
}

/**
 * Get active participants in recent messages
 */
export function getActiveParticipants(chatId, threadId, limit = 30) {
  const messages = getRecentMessages(chatId, threadId, limit);
  const participants = {};
  for (const msg of messages) {
    const name = msg.first_name || msg.username || 'ناشناس';
    participants[name] = (participants[name] || 0) + 1;
  }
  return Object.entries(participants)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

/**
 * Measure conversation "temperature" — how fast messages are coming
 * Returns: 'quiet' | 'normal' | 'active' | 'heated'
 */
export function getConversationTemp(chatId, threadId) {
  const messages = getRecentMessages(chatId, threadId, 10);
  if (messages.length < 2) return 'quiet';

  const timeSpan = messages[messages.length - 1].created_at - messages[0].created_at;
  const avgGap = timeSpan / (messages.length - 1) / 1000; // seconds

  if (avgGap < 5) return 'heated';
  if (avgGap < 15) return 'active';
  if (avgGap < 60) return 'normal';
  return 'quiet';
}

/**
 * Build a compact local context summary (NO AI)
 * This is sent to the AI only when it needs to respond
 */
export function buildLocalContext(chatId, threadId) {
  const messages = getRecentMessages(chatId, threadId, 15);
  if (messages.length === 0) return '';

  const participants = getActiveParticipants(chatId, threadId, 15);
  const topics = detectTopics(messages);
  const temp = getConversationTemp(chatId, threadId);
  const msgCount = getMessageCount(chatId, threadId);

  let context = `\n## Context (local analysis, no AI needed):\n`;
  context += `Total messages in this topic: ${msgCount}\n`;
  context += `Conversation temperature: ${temp}\n`;
  context += `Active participants: ${participants.map(p => `${p.name}(${p.count})`).join(', ')}\n`;
  if (topics.length > 0) {
    context += `Detected topics: ${topics.join(', ')}\n`;
  }

  // Recent messages
  context += `\n### Recent messages:\n`;
  context += messages.map(m => {
    const name = m.first_name || m.username || 'ناشناس';
    const time = new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    return `[${time}] ${name}: ${m.text}`;
  }).join('\n');

  return context;
}

/**
 * Get stored batch summary (computed periodically, not per-message)
 */
export function getStoredSummary(chatId, threadId) {
  const stored = getGroupSummary(chatId, threadId);
  if (!stored) return null;

  return {
    summary: stored.summary,
    participants: JSON.parse(stored.participants || '[]'),
    topics: JSON.parse(stored.topics || '[]'),
    messageCount: stored.message_count,
    age: Date.now() - stored.updated_at,
  };
}

/**
 * Check if batch summary needs refresh (every 24h or every 100 new messages)
 */
export function needsBatchSummary(chatId, threadId) {
  const stored = getStoredSummary(chatId, threadId);
  if (!stored) return true;

  const dayMs = 24 * 60 * 60 * 1000;
  if (stored.age > dayMs) return true;

  const currentCount = getMessageCount(chatId, threadId);
  if (currentCount - stored.messageCount > 100) return true;

  return false;
}
