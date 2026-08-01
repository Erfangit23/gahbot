import { getRecentMessages, getMessagesByUser, getSpeakerProfile,
         getGroupToneSample, getAllSpeakers, updateSpeakerToneProfile,
         storeBotReply } from './database.js';
import { analyzeSpeakerTone, analyzeGroupTone, generateResponse } from './llm.js';
import { searchFacts, formatSearchResultsForLLM, shouldSearch } from './tavily.js';
import { buildSystemPrompt } from './persona.js';
import { formatUserProfiles } from './userProfiles.js';
import db from './database.js';

const TONE_REFRESH_INTERVAL = 60 * 60 * 1000;
const MIN_MESSAGES_FOR_TONE = 10;
const toneCache = new Map();

function toneCacheKey(chat_id, thread_id) {
  return `${chat_id}:${thread_id || 'general'}`;
}

async function getGroupTone(chat_id, thread_id) {
  const key = toneCacheKey(chat_id, thread_id);
  const cached = toneCache.get(key);
  const now = Date.now();
  if (cached && (now - cached.lastUpdated) < TONE_REFRESH_INTERVAL) {
    return cached.groupTone;
  }
  const messages = getGroupToneSample(chat_id, thread_id, 100);
  if (messages.length < MIN_MESSAGES_FOR_TONE) return null;
  const groupTone = await analyzeGroupTone({ messages });
  toneCache.set(key, { groupTone, lastUpdated: now, speakers: new Map() });
  return groupTone;
}

async function getSpeakerTone(chat_id, thread_id, user_id) {
  const key = toneCacheKey(chat_id, thread_id);
  const cached = toneCache.get(key);
  if (cached && cached.speakers.has(user_id)) return cached.speakers.get(user_id);
  const speaker = getSpeakerProfile(user_id, chat_id);
  if (speaker && speaker.tone_profile) {
    try { return JSON.parse(speaker.tone_profile); } catch {}
  }
  const messages = getMessagesByUser(user_id, chat_id, thread_id, 20);
  if (messages.length < 3) return null;
  const tone = await analyzeSpeakerTone({
    messages,
    speakerName: speaker?.first_name || speaker?.username || 'Unknown',
  });
  updateSpeakerToneProfile(user_id, chat_id, tone);
  if (cached) cached.speakers.set(user_id, tone);
  return tone;
}

function formatRecentMessages(messages) {
  return messages
    .slice(-20)
    .map(m => {
      const name = m.first_name || m.username || 'ناشناس';
      const time = new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${name}: ${m.text}`;
    })
    .join('\n');
}

/**
 * Handle reply to bot — full conversation memory + user profiles
 */
export async function handleReplyToBot({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id }) {
  const recentMessages = getRecentMessages(chat_id, thread_id, 30);

  // Get bot's recent replies for context
  const botReplies = db.prepare(`
    SELECT * FROM bot_replies
    WHERE chat_id = ? AND (thread_id = ? OR (thread_id IS NULL AND ? IS NULL))
    ORDER BY created_at DESC LIMIT 5
  `).all(chat_id, thread_id || null, thread_id || null);

  let speakerTone = null;
  try { speakerTone = await getSpeakerTone(chat_id, thread_id, user_id); } catch {}

  let groupTone = null;
  try { groupTone = await getGroupTone(chat_id, thread_id); } catch {}

  // Build bot's previous messages context
  let botContext = '';
  if (botReplies.length > 0) {
    botContext = '\n## چیزایی که تو قبلاً گفتی:\n';
    botReplies.reverse().forEach((r) => {
      botContext += `تو: ${r.reply_text}\n`;
    });
  }

  // Search for real-time facts
  let searchContext = botContext;
  if (shouldSearch(text)) {
    console.log(`[Reply] Searching: ${text.substring(0, 80)}`);
    const results = await searchFacts(text.substring(0, 200), { maxResults: 4 });
    searchContext += formatSearchResultsForLLM([results]);
  }

  const recentContext = formatRecentMessages(recentMessages);

  // Collect usernames from recent messages for user profiles
  const recentUsernames = recentMessages
    .map(m => m.username)
    .filter(Boolean);
  if (username) recentUsernames.push(username);
  const userProfilesContext = formatUserProfiles([...new Set(recentUsernames)]);

  let systemPrompt = buildSystemPrompt({
    groupTone, speakerProfile: speakerTone,
    topic: 'reply_to_bot', topicCategory: 'general',
    searchContext, recentContext,
  });

  systemPrompt += userProfilesContext;
  systemPrompt += `\n## نکته:\nاین شخص مستقیماً به پیام تو جواب میده. با توجه به بحث قبلی و چیزایی که گفتی جواب بده.\n`;

  const conversationMessages = recentMessages
    .slice(-10)
    .map(m => ({ role: 'user', content: `${m.first_name || m.username || 'ناشناس'}: ${m.text}` }));

  conversationMessages.push({
    role: 'user',
    content: `${first_name || username || 'ناشناس'} (در جواب تو): ${text}`,
  });

  const response = await generateResponse({
    systemPrompt, messages: conversationMessages,
    temperature: 0.85, maxTokens: 800,
  });

  if (!response || response.trim().length === 0) return null;

  storeBotReply({ chat_id, thread_id, trigger_msg_id: telegram_msg_id, reply_text: response, topic: 'reply_to_bot' });
  return { text: response, topic: 'reply_to_bot' };
}

/**
 * Handle direct mention — respond with memory + user profiles
 */
export async function handleDirectMention({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id }) {
  const recentMessages = getRecentMessages(chat_id, thread_id, 30);

  let speakerTone = null;
  try { speakerTone = await getSpeakerTone(chat_id, thread_id, user_id); } catch {}

  let groupTone = null;
  try { groupTone = await getGroupTone(chat_id, thread_id); } catch {}

  // Search for real-time facts
  let searchContext = '';
  if (shouldSearch(text)) {
    console.log(`[Mention] Searching: ${text.substring(0, 80)}`);
    const results = await searchFacts(text.substring(0, 200), { maxResults: 4 });
    searchContext = formatSearchResultsForLLM([results]);
  }

  const recentContext = formatRecentMessages(recentMessages);

  // Collect usernames for profiles
  const recentUsernames = recentMessages.map(m => m.username).filter(Boolean);
  if (username) recentUsernames.push(username);
  const userProfilesContext = formatUserProfiles([...new Set(recentUsernames)]);

  let systemPrompt = buildSystemPrompt({
    groupTone, speakerProfile: speakerTone,
    topic: 'direct_mention', topicCategory: 'general',
    searchContext, recentContext,
  });

  systemPrompt += userProfilesContext;
  systemPrompt += `\n## نکته:\nاین شخص اسمتو صدا زده. کوتاه و مستقیم جواب بده.\n`;

  const conversationMessages = recentMessages
    .slice(-8)
    .map(m => ({ role: 'user', content: `${m.first_name || m.username || 'ناشناس'}: ${m.text}` }));

  conversationMessages.push({
    role: 'user',
    content: `${first_name || username || 'ناشناس'}: ${text}`,
  });

  const response = await generateResponse({
    systemPrompt, messages: conversationMessages,
    temperature: 0.85, maxTokens: 600,
  });

  if (!response || response.trim().length === 0) return null;

  storeBotReply({ chat_id, thread_id, trigger_msg_id: telegram_msg_id, reply_text: response, topic: 'direct_mention' });
  return { text: response, topic: 'direct_mention' };
}

// Keep processMessage export for backwards compat but it's unused now
export async function processMessage() { return null; }
