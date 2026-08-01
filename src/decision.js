import { getRecentMessages, getSpeakerProfile, getMessagesByUser,
         getGroupToneSample, getAllSpeakers, updateSpeakerToneProfile,
         getLastBotReplyTime, getBotReplyCount, storeBotReply } from './database.js';
import { detectTension, analyzeSpeakerTone, analyzeGroupTone, generateResponse } from './llm.js';
import { searchFacts, formatSearchResultsForLLM } from './tavily.js';
import { buildSystemPrompt, buildCasualPrompt } from './persona.js';
import db from './database.js';

const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '15000', 10);
const MAX_REPLIES_PER_HOUR = 30;
const CASUAL_INTERVENTION_CHANCE = 0.05; // 5% chance of casual comment
const TONE_REFRESH_INTERVAL = 60 * 60 * 1000;
const MIN_MESSAGES_FOR_TONE = 10;

// In-memory cache for tone profiles — keyed by `${chat_id}:${thread_id}`
const toneCache = new Map();

function toneCacheKey(chat_id, thread_id) {
  return `${chat_id}:${thread_id || 'general'}`;
}

/**
 * Get cached or refreshed group tone for a specific topic thread
 */
async function getGroupTone(chat_id, thread_id) {
  const key = toneCacheKey(chat_id, thread_id);
  const cached = toneCache.get(key);
  const now = Date.now();

  if (cached && (now - cached.lastUpdated) < TONE_REFRESH_INTERVAL) {
    return cached.groupTone;
  }

  const messages = getGroupToneSample(chat_id, thread_id, 100);
  if (messages.length < MIN_MESSAGES_FOR_TONE) {
    return null;
  }

  const groupTone = await analyzeGroupTone({ messages });

  // Also analyze individual speakers in this topic
  const speakers = getAllSpeakers(chat_id, thread_id);
  const speakerTones = new Map();

  for (const speaker of speakers.slice(0, 10)) {
    if (speaker.message_count < 3) continue;

    const speakerMessages = getMessagesByUser(speaker.user_id, chat_id, thread_id, 20);
    const tone = await analyzeSpeakerTone({
      messages: speakerMessages,
      speakerName: speaker.first_name || speaker.username || 'Unknown',
    });
    updateSpeakerToneProfile(speaker.user_id, chat_id, tone);
    speakerTones.set(speaker.user_id, tone);
  }

  toneCache.set(key, {
    groupTone,
    lastUpdated: now,
    speakers: speakerTones,
  });

  return groupTone;
}

/**
 * Get cached speaker tone for a specific topic thread
 */
async function getSpeakerTone(chat_id, thread_id, user_id) {
  const key = toneCacheKey(chat_id, thread_id);
  const cached = toneCache.get(key);
  if (cached && cached.speakers.has(user_id)) {
    return cached.speakers.get(user_id);
  }

  // Try database
  const speaker = getSpeakerProfile(user_id, chat_id);
  if (speaker && speaker.tone_profile) {
    try {
      return JSON.parse(speaker.tone_profile);
    } catch {
      // Fall through to fresh analysis
    }
  }

  // Fresh analysis
  const messages = getMessagesByUser(user_id, chat_id, thread_id, 20);
  if (messages.length < 3) return null;

  const tone = await analyzeSpeakerTone({
    messages,
    speakerName: speaker?.first_name || speaker?.username || 'Unknown',
  });
  updateSpeakerToneProfile(user_id, chat_id, tone);

  if (cached) {
    cached.speakers.set(user_id, tone);
  }

  return tone;
}

/**
 * Format recent messages for LLM context
 */
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
 * Main decision and response logic
 * Now thread-aware: each topic gets its own context, tone, and cooldown
 */
export async function processMessage({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id }) {
  const botUsername = process.env.BOT_USERNAME || 'gahmood_bot';

  // Check if bot was mentioned
  const botMentioned = text.toLowerCase().includes('قاهمد') ||
                       text.toLowerCase().includes('گاحمود') ||
                       text.toLowerCase().includes('گاهمود') ||
                       text.toLowerCase().includes('قاحمود') ||
                       text.toLowerCase().includes('gahmood') ||
                       text.toLowerCase().includes('shahmood') ||
                       text.includes(`@${process.env.BOT_USERNAME || 'Shahmoodbot'}`);

  // Cooldown check — per topic thread
  const lastReply = getLastBotReplyTime(chat_id, thread_id);
  const sinceLastReply = Date.now() - lastReply;
  if (sinceLastReply < COOLDOWN_MS && !botMentioned) {
    return null;
  }

  // Rate limit: max N replies per hour — per topic thread
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  const recentReplyCount = getBotReplyCount(chat_id, thread_id, oneHourAgo);
  if (recentReplyCount >= MAX_REPLIES_PER_HOUR && !botMentioned) {
    return null;
  }

  // Get recent messages for this specific topic thread
  const recentMessages = getRecentMessages(chat_id, thread_id, 50);
  if (recentMessages.length < 2) return null;

  // Detect tension / need for intervention
  const tension = await detectTension({ recentMessages, botMentioned });

  if (!tension.shouldIntervene) {
    // Small chance of a casual comment (like a real group member)
    if (Math.random() < CASUAL_INTERVENTION_CHANCE && recentMessages.length >= 5) {
      return await generateCasualComment({ chat_id, thread_id, recentMessages, telegram_msg_id });
    }
    return null;
  }

  // --- Intervention logic ---

  let groupTone = null;
  let speakerTone = null;

  try {
    groupTone = await getGroupTone(chat_id, thread_id);
  } catch (e) {
    console.error('[Decision] Group tone fetch error:', e.message);
  }

  if (tension.keyParticipants && tension.keyParticipants.length > 0) {
    const mainSpeaker = recentMessages[recentMessages.length - 1];
    if (mainSpeaker) {
      try {
        speakerTone = await getSpeakerTone(chat_id, thread_id, mainSpeaker.user_id);
      } catch (e) {
        console.error('[Decision] Speaker tone fetch error:', e.message);
      }
    }
  }

  // Search for real-time facts if there are disputed claims
  let searchContext = '';
  if (tension.disputedClaims && tension.disputedClaims.length > 0) {
    console.log(`[Decision] Searching facts for claims: ${tension.disputedClaims.join(' | ')}`);

    const searchPromises = tension.disputedClaims
      .slice(0, 3)
      .map(claim => searchFacts(claim, { maxResults: 3, searchDepth: 'advanced' }));

    const searchResults = await Promise.all(searchPromises);
    searchContext = formatSearchResultsForLLM(searchResults);
  }

  const recentContext = formatRecentMessages(recentMessages);

  const systemPrompt = buildSystemPrompt({
    groupTone,
    speakerProfile: speakerTone,
    topic: tension.topic,
    topicCategory: tension.topicCategory,
    searchContext,
    recentContext,
  });

  const conversationMessages = recentMessages
    .slice(-10)
    .map(m => ({
      role: 'user',
      content: `${m.first_name || m.username || 'ناشناس'}: ${m.text}`,
    }));

  conversationMessages.push({
    role: 'user',
    content: 'حالا تو وارد بحث شو. نظرت رو بگو.',
  });

  const response = await generateResponse({
    systemPrompt,
    messages: conversationMessages,
    temperature: 0.85,
    maxTokens: 800,
  });

  if (!response || response.trim().length === 0) {
    return null;
  }

  storeBotReply({
    chat_id,
    thread_id,
    trigger_msg_id: telegram_msg_id,
    reply_text: response,
    topic: tension.topic,
  });

  return {
    text: response,
    topic: tension.topic,
    tensionScore: tension.tensionScore,
  };
}

/**
 * Generate a casual comment (not an argument response)
 */
async function generateCasualComment({ chat_id, thread_id, recentMessages, telegram_msg_id }) {
  let groupTone = null;
  try {
    groupTone = await getGroupTone(chat_id, thread_id);
  } catch (e) {
    // Use default
  }

  const recentContext = formatRecentMessages(recentMessages.slice(-10));
  const systemPrompt = buildCasualPrompt({ groupTone, recentContext });

  const response = await generateResponse({
    systemPrompt,
    messages: [{ role: 'user', content: 'یه کامنت کوتاه بزن اگر لازمه.' }],
    temperature: 0.9,
    maxTokens: 150,
  });

  if (!response || response.trim().length < 2) return null;

  storeBotReply({
    chat_id,
    thread_id,
    trigger_msg_id: telegram_msg_id,
    reply_text: response,
    topic: 'casual',
  });

  return { text: response, topic: 'casual', tensionScore: 0 };
}

/**
 * Handle when someone replies directly to the bot's message.
 * The bot responds with full conversation context — what was discussed before,
 * what the bot said, and the person's reply.
 */
export async function handleReplyToBot({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id }) {
  // Get recent messages for context (includes the bot's previous messages)
  const recentMessages = getRecentMessages(chat_id, thread_id, 30);

  // Find the bot's last reply in this thread for direct context
  const botReplies = db.prepare(`
    SELECT * FROM bot_replies
    WHERE chat_id = ? AND (thread_id = ? OR (thread_id IS NULL AND ? IS NULL))
    ORDER BY created_at DESC
    LIMIT 5
  `).all(chat_id, thread_id || null, thread_id || null);

  // Get speaker tone
  let speakerTone = null;
  try {
    speakerTone = await getSpeakerTone(chat_id, thread_id, user_id);
  } catch (e) {
    console.error('[Reply] Speaker tone error:', e.message);
  }

  // Get group tone
  let groupTone = null;
  try {
    groupTone = await getGroupTone(chat_id, thread_id);
  } catch (e) {
    console.error('[Reply] Group tone error:', e.message);
  }

  // Build context with what the bot previously said
  let botContext = '';
  if (botReplies.length > 0) {
    botContext = '\n## چیزایی که تو قبلاً گفتی:\n';
    botReplies.reverse().forEach((r, i) => {
      const time = new Date(r.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
      botContext += `[${time}] تو: ${r.reply_text}\n`;
    });
  }

  // Build the recent conversation context
  const recentContext = formatRecentMessages(recentMessages);

  // Build system prompt with extra context about previous bot messages
  let systemPrompt = buildSystemPrompt({
    groupTone,
    speakerProfile: speakerTone,
    topic: 'reply_to_bot',
    topicCategory: 'general',
    searchContext: botContext,
    recentContext,
  });

  // Add instruction that someone is replying to the bot
  systemPrompt += `\n## نکته مهم:\nاین شخص مستقیماً داره به پیام تو جواب میده. یعنی یا باهات موافقت کرده، یا مخالفت میکنه، یا سوال پرسیده. با توجه به چیزی که تو قبلاً گفتی جواب بده. اگه اشتباه گفتی، اعتراف کن. اگه درست گفتی، از نظرت دفاع کن.\n`;

  // Build conversation — include recent messages for context, then the person's reply
  const conversationMessages = recentMessages
    .slice(-10)
    .map(m => ({
      role: 'user',
      content: `${m.first_name || m.username || 'ناشناس'}: ${m.text}`,
    }));

  // The last message is the person's reply to the bot
  conversationMessages.push({
    role: 'user',
    content: `${first_name || username || 'ناشناس'} (در جواب تو): ${text}`,
  });

  const response = await generateResponse({
    systemPrompt,
    messages: conversationMessages,
    temperature: 0.85,
    maxTokens: 800,
  });

  if (!response || response.trim().length === 0) {
    return null;
  }

  storeBotReply({
    chat_id,
    thread_id,
    trigger_msg_id: telegram_msg_id,
    reply_text: response,
    topic: 'reply_to_bot',
  });

  return { text: response, topic: 'reply_to_bot', tensionScore: 0 };
}

/**
 * Handle when someone mentions the bot by name in a message (not a command, not a reply).
 * e.g. "قاهمد این درسته؟" or "گاحمود جواب بده"
 */
export async function handleDirectMention({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id }) {
  const recentMessages = getRecentMessages(chat_id, thread_id, 30);

  let speakerTone = null;
  try {
    speakerTone = await getSpeakerTone(chat_id, thread_id, user_id);
  } catch (e) {}

  let groupTone = null;
  try {
    groupTone = await getGroupTone(chat_id, thread_id);
  } catch (e) {}

  const recentContext = formatRecentMessages(recentMessages);

  let systemPrompt = buildSystemPrompt({
    groupTone,
    speakerProfile: speakerTone,
    topic: 'direct_mention',
    topicCategory: 'general',
    searchContext: '',
    recentContext,
  });

  systemPrompt += `\n## نکته:\nاین شخص اسمتو صدا زده و یه چیزی ازت می‌خواد. کوتاه و مستقیم جواب بده.\n`;

  const conversationMessages = recentMessages
    .slice(-8)
    .map(m => ({
      role: 'user',
      content: `${m.first_name || m.username || 'ناشناس'}: ${m.text}`,
    }));

  // The person's current message (already in recentMessages but emphasize it)
  conversationMessages.push({
    role: 'user',
    content: `${first_name || username || 'ناشناس'}: ${text}`,
  });

  const response = await generateResponse({
    systemPrompt,
    messages: conversationMessages,
    temperature: 0.85,
    maxTokens: 600,
  });

  if (!response || response.trim().length === 0) return null;

  storeBotReply({
    chat_id,
    thread_id,
    trigger_msg_id: telegram_msg_id,
    reply_text: response,
    topic: 'direct_mention',
  });

  return { text: response, topic: 'direct_mention', tensionScore: 0 };
}
