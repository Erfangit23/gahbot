import TelegramBot from 'node-telegram-bot-api';
import { storeMessage } from './database.js';
import { processMessage, handleReplyToBot } from './decision.js';
import { analyzeGroupTone, analyzeSpeakerTone } from './llm.js';
import { getMessagesByUser, getGroupToneSample, getAllSpeakers, updateSpeakerToneProfile } from './database.js';
import { generateResponse } from './llm.js';
import { startHealthServer } from './health.js';

// Start health check server for Railway
const PORT = process.env.PORT || 3000;
startHealthServer(PORT);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required. Set it in .env file.');
  process.exit(1);
}

if (!process.env.NVIDIA_API_KEY) {
  console.error('❌ NVIDIA_API_KEY is required. Set it in .env file.');
  process.exit(1);
}

if (!process.env.TAVILY_API_KEY) {
  console.error('❌ TAVILY_API_KEY is required. Set it in .env file.');
  process.exit(1);
}

// Initialize bot with polling
const bot = new TelegramBot(token, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: {
      timeout: 10,
    },
  },
});

const botInfo = await bot.getMe();
console.log(`✅ Gahmood Bot started: @${botInfo.username}`);
console.log(`   Add the bot to your group and make it an admin so it can read all messages.`);
console.log(`   For topic/forum groups: make sure 'Topics' are enabled in group settings.`);

// --- Message handler ---

bot.on('message', async (msg) => {
  try {
    // Only process group/supergroup chats
    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
      return;
    }

    // Skip non-text messages
    if (!msg.text || msg.text.length === 0) {
      return;
    }

    // Skip if message is from the bot itself
    if (msg.from.id === botInfo.id) {
      return;
    }

    const chat_id = msg.chat.id;
    const user_id = msg.from.id;
    const username = msg.from.username || null;
    const first_name = msg.from.first_name || null;
    const text = msg.text;
    const telegram_msg_id = msg.message_id;

    // --- Topic/Forum support ---
    // In supergroups with Topics enabled, each message has a message_thread_id
    // General topic has thread_id = 1 (or sometimes undefined for non-topic messages)
    // If the group doesn't use topics, thread_id will be undefined
    let thread_id = msg.message_thread_id || null;

    // For forum groups, even General topic messages might have thread_id = 1
    // For non-forum groups, thread_id will be undefined → we store as null
    // This ensures each topic gets its own conversation context

    // Check if this is a reply to the bot's message
    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from &&
                         msg.reply_to_message.from.id === botInfo.id;

    // Store the message with thread_id
    storeMessage({
      telegram_msg_id,
      chat_id,
      thread_id,
      user_id,
      username,
      first_name,
      text,
      raw_json: JSON.stringify({ from: msg.from, chat: msg.chat, thread_id }),
    });

    // If replying directly to the bot, always respond with context
    if (isReplyToBot) {
      const result = await handleReplyToBot({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id });
      if (result && result.text) {
        const replyOptions = {
          reply_to_message_id: telegram_msg_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        };
        if (thread_id !== null) {
          replyOptions.message_thread_id = thread_id;
        }
        await bot.sendMessage(chat_id, result.text, replyOptions);
        console.log(`[${new Date().toISOString()}] Replied to direct reply in chat ${chat_id} | Topic: ${result.topic}`);
      }
      return;
    }

    // Process the message through the decision engine
    const result = await processMessage({
      chat_id,
      thread_id,
      user_id,
      username,
      first_name,
      text,
      telegram_msg_id,
    });

    if (result && result.text) {
      // Build reply options
      const replyOptions = {
        reply_to_message_id: telegram_msg_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };

      // If this is a forum group with topics, reply in the correct topic thread
      if (thread_id !== null) {
        replyOptions.message_thread_id = thread_id;
      }

      await bot.sendMessage(chat_id, result.text, replyOptions);

      const topicLabel = thread_id !== null ? `topic:${thread_id}` : 'general';
      console.log(`[${new Date().toISOString()}] Replied in chat ${chat_id} | ${topicLabel} | Topic: ${result.topic} | Tension: ${result.tensionScore}`);
    }
  } catch (err) {
    console.error('[Bot] Message handling error:', err.message);
  }
});

// --- Command: /gahmood_tone ---
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
      await bot.sendMessage(chat_id, 'هنوز پیام کافی تو این topic نیست. حداقل ۵ تا پیام لازمه.', replyOpts);
      return;
    }

    const groupTone = await analyzeGroupTone({ messages });

    let response = '🔍 تحلیل لحن گروه';
    if (thread_id !== null) response += ` (Topic: ${thread_id})`;
    response += ':\n\n';
    response += `فضای کلی: ${groupTone.overallVibe}\n`;
    response += `جدیت: ${groupTone.formality}\n`;
    response += `شوخی: ${groupTone.humorLevel}\n`;
    response += `فحش: ${groupTone.swearingFrequency}\n`;
    response += `سبک بحث: ${groupTone.discussionStyle}\n`;

    if (groupTone.commonSlang && groupTone.commonSlang.length > 0) {
      response += `کلمات رایج: ${groupTone.commonSlang.join('، ')}\n`;
    }
    if (groupTone.commonTopics && groupTone.commonTopics.length > 0) {
      response += `موضوعات رایج: ${groupTone.commonTopics.join('، ')}\n`;
    }

    // Analyze top speakers in this topic
    const speakers = getAllSpeakers(chat_id, thread_id);
    response += '\n👥 فعال‌ترین اعضا در این topic:\n';
    for (const speaker of speakers.slice(0, 5)) {
      const count = speaker.topic_message_count || speaker.message_count;
      if (count < 3) continue;
      const speakerMessages = getMessagesByUser(speaker.user_id, chat_id, thread_id, 20);
      const tone = await analyzeSpeakerTone({
        messages: speakerMessages,
        speakerName: speaker.first_name || speaker.username || 'Unknown',
      });
      updateSpeakerToneProfile(speaker.user_id, chat_id, tone);
      response += `\n${speaker.first_name || speaker.username} (${count} پیام):\n`;
      response += `  سبک: ${tone.style} | شوخی: ${tone.humor} | فحش: ${tone.swearing}\n`;
    }

    await bot.sendMessage(chat_id, response, replyOpts);
  } catch (err) {
    console.error('[Bot] Tone analysis error:', err.message);
    await bot.sendMessage(chat_id, 'خطا تو تحلیل لحن. دوباره امتحان کن.', replyOpts);
  }
});

// --- Command: /gahmood_stats ---
bot.onText(/\/gahmood_stats/, async (msg) => {
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;

  const chat_id = msg.chat.id;
  const thread_id = msg.message_thread_id || null;
  const replyOpts = { reply_to_message_id: msg.message_id };
  if (thread_id !== null) replyOpts.message_thread_id = thread_id;

  try {
    const speakers = getAllSpeakers(chat_id, thread_id);
    const totalMessages = speakers.reduce((sum, s) => sum + (s.topic_message_count || s.message_count), 0);

    let response = '📊 آمار';
    if (thread_id !== null) response += ` (Topic: ${thread_id})`;
    response += ':\n\n';
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

// --- Command: /gahmood_ask ---
bot.onText(/\/gahmood_ask (.+)/, async (msg, match) => {
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;

  const chat_id = msg.chat.id;
  const thread_id = msg.message_thread_id || null;
  const question = match[1];
  const replyOpts = { reply_to_message_id: msg.message_id };
  if (thread_id !== null) replyOpts.message_thread_id = thread_id;

  await bot.sendChatAction(chat_id, 'typing');

  try {
    const response = await generateResponse({
      systemPrompt: 'تو قاهمد هستی. یه آدم تو گروه تلگرامی. کوتاه و مستند جواب بده. فارسی حرف بزن.',
      messages: [{ role: 'user', content: question }],
      temperature: 0.8,
      maxTokens: 500,
    });

    await bot.sendMessage(chat_id, response, replyOpts);
  } catch (err) {
    console.error('[Bot] Ask error:', err.message);
    await bot.sendMessage(chat_id, 'الان نمی‌تونم جواب بدم. دوباره امتحان کن.', replyOpts);
  }
});

// --- Error handling ---

bot.on('polling_error', (err) => {
  console.error('[Bot] Polling error:', err.message);
});

bot.on('webhook_error', (err) => {
  console.error('[Bot] Webhook error:', err.message);
});

// --- Graceful shutdown ---

process.on('SIGINT', () => {
  console.log('\n⏹ Shutting down Gahmood Bot...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n⏹ SIGTERM received, shutting down...');
  bot.stopPolling();
  process.exit(0);
});

console.log('🤖 Gahmood is watching the group...');
