import TelegramBot from 'node-telegram-bot-api';
import { storeMessage } from './database.js';
import { processMessage, handleReplyToBot, handleDirectMention } from './decision.js';
import { analyzeGroupTone, analyzeSpeakerTone } from './llm.js';
import { getMessagesByUser, getGroupToneSample, getAllSpeakers, updateSpeakerToneProfile } from './database.js';
import { generateResponse } from './llm.js';
import { startHealthServer } from './health.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required.');
  process.exit(1);
}
if (!process.env.NVIDIA_API_KEY) {
  console.error('❌ NVIDIA_API_KEY is required.');
  process.exit(1);
}
if (!process.env.TAVILY_API_KEY) {
  console.error('❌ TAVILY_API_KEY is required.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
startHealthServer(PORT);

const bot = new TelegramBot(token, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});

let botInfo = null;

bot.getMe().then((info) => {
  botInfo = info;
  console.log(`✅ Gahmood Bot started: @${botInfo.username} (ID: ${botInfo.id})`);
  console.log('🤖 Gahmood is watching the group...');
}).catch((err) => {
  console.error('❌ Failed to get bot info:', err.message);
  process.exit(1);
});

// Helper: check if text mentions the bot
function isBotMentioned(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Check various ways people might mention the bot
  const triggers = [
    'قاهمد', 'گاحمود', 'گاهمود', 'قاحمود', 'شاهمود', 'شاهمد',
    'gahmood', 'shahmood', 'shahmad', 'gahmad', 'qahmood',
    `@${botInfo?.username?.toLowerCase()}`,
  ];
  return triggers.some(t => lower.includes(t));
}

// Helper: check if text is a command
function isCommand(text) {
  return text && text.startsWith('/');
}

// --- Main message handler ---

bot.on('message', async (msg) => {
  try {
    if (!botInfo) return;

    // Only group/supergroup
    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;

    // Skip non-text
    if (!msg.text || msg.text.length === 0) return;

    // Skip bot's own messages
    if (String(msg.from.id) === String(botInfo.id)) return;

    // Skip command messages — they're handled by onText handlers below
    if (isCommand(msg.text)) return;

    const chat_id = msg.chat.id;
    const user_id = msg.from.id;
    const username = msg.from.username || null;
    const first_name = msg.from.first_name || null;
    const text = msg.text;
    const telegram_msg_id = msg.message_id;
    const thread_id = msg.message_thread_id || null;

    // Check if replying to the bot
    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from &&
                         String(msg.reply_to_message.from.id) === String(botInfo.id);

    // Check if bot is mentioned by name
    const mentioned = isBotMentioned(text);

    console.log(`[Msg] ${first_name} in ${chat_id}/${thread_id || 'general'}: "${text.substring(0, 60)}" | replyToBot=${isReplyToBot} mentioned=${mentioned}`);

    // Store message
    storeMessage({
      telegram_msg_id, chat_id, thread_id, user_id, username, first_name, text,
      raw_json: JSON.stringify({ from: msg.from, chat: msg.chat, thread_id }),
    });

    // --- Priority 1: Reply to bot ---
    if (isReplyToBot) {
      console.log('[Route] → reply to bot');
      try {
        const result = await handleReplyToBot({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id });
        if (result && result.text) {
          await sendReply(bot, chat_id, telegram_msg_id, thread_id, result.text);
          console.log(`[Sent] Reply to bot | ${result.topic}`);
        }
      } catch (err) {
        console.error('[Error] handleReplyToBot:', err.message);
      }
      return; // Don't also process as general message
    }

    // --- Priority 2: Direct mention (someone says "قاهمد جواب بده" etc) ---
    if (mentioned) {
      console.log('[Route] → direct mention');
      try {
        const result = await handleDirectMention({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id });
        if (result && result.text) {
          await sendReply(bot, chat_id, telegram_msg_id, thread_id, result.text);
          console.log(`[Sent] Direct mention | ${result.topic}`);
        }
      } catch (err) {
        console.error('[Error] handleDirectMention:', err.message);
      }
      return; // Don't also process as general message
    }

    // --- Priority 3: Auto-detect arguments/tension ---
    const result = await processMessage({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id });
    if (result && result.text) {
      await sendReply(bot, chat_id, telegram_msg_id, thread_id, result.text);
      const topicLabel = thread_id !== null ? `topic:${thread_id}` : 'general';
      console.log(`[Sent] Auto-intervention | ${topicLabel} | ${result.topic} | Tension: ${result.tensionScore}`);
    }

  } catch (err) {
    console.error('[Bot] Error:', err.message, err.stack);
  }
});

// Helper: send reply with correct threading
async function sendReply(bot, chat_id, reply_to_id, thread_id, text) {
  const opts = {
    reply_to_message_id: reply_to_id,
    disable_web_page_preview: true,
  };
  if (thread_id !== null) opts.message_thread_id = thread_id;
  await bot.sendMessage(chat_id, text, opts);
}

// --- Commands ---

bot.onText(/\/gahmood_tone/, async (msg) => {
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  const chat_id = msg.chat.id;
  const thread_id = msg.message_thread_id || null;
  const replyOpts = { reply_to_message_id: msg.message_id };
  if (thread_id !== null) replyOpts.message_thread_id = thread_id;

  await bot.sendChatAction(chat_id, 'typing');
  try {
    const messages = getGroupToneSample(chat_id, thread_id, 100);
    if (messages.length < 5) {
      await bot.sendMessage(chat_id, 'هنوز پیام کافی نیست. حداقل ۵ تا پیام لازمه.', replyOpts);
      return;
    }
    const groupTone = await analyzeGroupTone({ messages });
    let response = '🔍 تحلیل لحن گروه:\n\n';
    response += `فضای کلی: ${groupTone.overallVibe}\n`;
    response += `جدیت: ${groupTone.formality}\n`;
    response += `شوخی: ${groupTone.humorLevel}\n`;
    response += `فحش: ${groupTone.swearingFrequency}\n`;
    response += `سبک بحث: ${groupTone.discussionStyle}\n`;
    if (groupTone.commonSlang?.length) response += `کلمات رایج: ${groupTone.commonSlang.join('، ')}\n`;
    if (groupTone.commonTopics?.length) response += `موضوعات رایج: ${groupTone.commonTopics.join('، ')}\n`;

    const speakers = getAllSpeakers(chat_id, thread_id);
    response += '\n👥 فعال‌ترین‌ها:\n';
    for (const speaker of speakers.slice(0, 5)) {
      const count = speaker.topic_message_count || speaker.message_count;
      if (count < 3) continue;
      const speakerMessages = getMessagesByUser(speaker.user_id, chat_id, thread_id, 20);
      const tone = await analyzeSpeakerTone({ messages: speakerMessages, speakerName: speaker.first_name || speaker.username || '?' });
      updateSpeakerToneProfile(speaker.user_id, chat_id, tone);
      response += `\n${speaker.first_name || speaker.username} (${count} پیام):\n`;
      response += `  سبک: ${tone.style} | شوخی: ${tone.humor} | فحش: ${tone.swearing}\n`;
    }
    await bot.sendMessage(chat_id, response, replyOpts);
  } catch (err) {
    console.error('[Bot] Tone error:', err.message);
    await bot.sendMessage(chat_id, 'خطا. دوباره امتحان کن.', replyOpts);
  }
});

bot.onText(/\/gahmood_stats/, async (msg) => {
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  const chat_id = msg.chat.id;
  const thread_id = msg.message_thread_id || null;
  const replyOpts = { reply_to_message_id: msg.message_id };
  if (thread_id !== null) replyOpts.message_thread_id = thread_id;

  try {
    const speakers = getAllSpeakers(chat_id, thread_id);
    const totalMessages = speakers.reduce((sum, s) => sum + (s.topic_message_count || s.message_count), 0);
    let response = '📊 آمار:\n\n';
    response += `کل پیام‌ها: ${totalMessages}\n`;
    response += `اعضا: ${speakers.length}\n\n`;
    response += 'فعال‌ترین‌ها:\n';
    speakers.slice(0, 10).forEach((s, i) => {
      const count = s.topic_message_count || s.message_count;
      response += `${i + 1}. ${s.first_name || s.username || 'ناشناس'} — ${count} پیام\n`;
    });
    await bot.sendMessage(chat_id, response, replyOpts);
  } catch (err) {
    console.error('[Bot] Stats error:', err.message);
  }
});

bot.onText(/\/gahmood_ask (.+)/, async (msg, match) => {
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  const chat_id = msg.chat.id;
  const thread_id = msg.message_thread_id || null;
  const question = match[1];
  const replyOpts = { reply_to_message_id: msg.message_id };
  if (thread_id !== null) replyOpts.message_thread_id = thread_id;

  await bot.sendChatAction(chat_id, 'typing');
  try {
    const { shouldSearch, searchFacts, formatSearchResultsForLLM } = await import('./tavily.js');
    let searchContext = '';
    if (shouldSearch(question)) {
      const results = await searchFacts(question.substring(0, 200), { maxResults: 4 });
      searchContext = formatSearchResultsForLLM([results]);
    }
    let sysPrompt = 'تو قاهمد هستی. یه آدم تو گروه تلگرامی. کوتاه و مستند جواب بده. فارسی حرف بزن.';
    if (searchContext) sysPrompt += '\n' + searchContext;

    const response = await generateResponse({
      systemPrompt: sysPrompt,
      messages: [{ role: 'user', content: question }],
      temperature: 0.8,
      maxTokens: 500,
    });
    await bot.sendMessage(chat_id, response, replyOpts);
  } catch (err) {
    console.error('[Bot] Ask error:', err.message);
    await bot.sendMessage(chat_id, 'الان نمی‌تونم جواب بدم.', replyOpts);
  }
});

bot.on('polling_error', (err) => console.error('[Bot] Polling:', err.message));

process.on('SIGINT', () => { bot.stopPolling(); process.exit(0); });
process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
