import TelegramBot from 'node-telegram-bot-api';
import { storeMessage } from './database.js';
import { handleReplyToBot, handleDirectMention } from './decision.js';
import { generateResponse } from './llm.js';
import { startHealthServer } from './health.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('❌ TELEGRAM_BOT_TOKEN required.'); process.exit(1); }
if (!process.env.NVIDIA_API_KEY) { console.error('❌ NVIDIA_API_KEY required.'); process.exit(1); }
if (!process.env.TAVILY_API_KEY) { console.error('❌ TAVILY_API_KEY required.'); process.exit(1); }

const PORT = process.env.PORT || 3000;
startHealthServer(PORT);

const bot = new TelegramBot(token, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});

let botInfo = null;
bot.getMe().then((info) => {
  botInfo = info;
  console.log(`✅ Gahmood Bot started: @${botInfo.username} (ID: ${botInfo.id})`);
  console.log('🤖 Gahmood is ready. Mention or reply to talk.');
}).catch((err) => {
  console.error('❌ Failed to get bot info:', err.message);
  process.exit(1);
});

function isBotMentioned(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const triggers = [
    'قاهمد', 'گاحمود', 'گاهمود', 'قاحمود', 'شاهمود', 'شاهمد',
    'gahmood', 'shahmood', 'shahmad', 'gahmad', 'qahmood',
    `@${botInfo?.username?.toLowerCase()}`,
  ];
  return triggers.some(t => lower.includes(t));
}

function isCommand(text) {
  return text && text.startsWith('/');
}

// --- Message handler ---

bot.on('message', async (msg) => {
  try {
    if (!botInfo) return;
    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
    if (!msg.text || msg.text.length === 0) return;
    if (String(msg.from.id) === String(botInfo.id)) return;
    if (isCommand(msg.text)) return;

    const chat_id = msg.chat.id;
    const user_id = msg.from.id;
    const username = msg.from.username || null;
    const first_name = msg.from.first_name || null;
    const text = msg.text;
    const telegram_msg_id = msg.message_id;
    const thread_id = msg.message_thread_id || null;

    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from &&
                         String(msg.reply_to_message.from.id) === String(botInfo.id);
    const mentioned = isBotMentioned(text);

    // Store message for memory (but don't process unless mentioned or replied to)
    storeMessage({
      telegram_msg_id, chat_id, thread_id, user_id, username, first_name, text,
      raw_json: JSON.stringify({ from: msg.from, chat: msg.chat, thread_id }),
    });

    // Only respond when mentioned or replied to — no auto-scanning
    if (isReplyToBot) {
      console.log(`[Route] Reply to bot from ${first_name}: "${text.substring(0, 60)}"`);
      try {
        const result = await handleReplyToBot({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id });
        if (result && result.text) {
          await sendReply(chat_id, telegram_msg_id, thread_id, result.text);
          console.log(`[Sent] Reply to bot`);
        }
      } catch (err) {
        console.error('[Error] handleReplyToBot:', err.message);
      }
      return;
    }

    if (mentioned) {
      console.log(`[Route] Mention from ${first_name}: "${text.substring(0, 60)}"`);
      try {
        const result = await handleDirectMention({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id });
        if (result && result.text) {
          await sendReply(chat_id, telegram_msg_id, thread_id, result.text);
          console.log(`[Sent] Mention response`);
        }
      } catch (err) {
        console.error('[Error] handleDirectMention:', err.message);
      }
      return;
    }

    // Not mentioned, not replied to — just store the message silently
  } catch (err) {
    console.error('[Bot] Error:', err.message);
  }
});

async function sendReply(chat_id, reply_to_id, thread_id, text) {
  const opts = { reply_to_message_id: reply_to_id, disable_web_page_preview: true };
  if (thread_id !== null) opts.message_thread_id = thread_id;
  await bot.sendMessage(chat_id, text, opts);
}

// --- Commands ---

bot.onText(/\/gahmood_stats/, async (msg) => {
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  const chat_id = msg.chat.id;
  const thread_id = msg.message_thread_id || null;
  const replyOpts = { reply_to_message_id: msg.message_id };
  if (thread_id !== null) replyOpts.message_thread_id = thread_id;
  try {
    const { getAllSpeakers } = await import('./database.js');
    const speakers = getAllSpeakers(chat_id, thread_id);
    let response = '📊 آمار:\n\n';
    response += `اعضا: ${speakers.length}\n`;
    response += 'فعال‌ترین‌ها:\n';
    speakers.slice(0, 10).forEach((s, i) => {
      const count = s.topic_message_count || s.message_count;
      response += `${i + 1}. ${s.first_name || s.username || 'ناشناس'} — ${count} پیام\n`;
    });
    await bot.sendMessage(chat_id, response, replyOpts);
  } catch (err) { console.error('[Bot] Stats error:', err.message); }
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
      temperature: 0.8, maxTokens: 500,
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
