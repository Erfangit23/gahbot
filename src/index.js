import TelegramBot from 'node-telegram-bot-api';
import { storeMessage, updateSpeakerStats, saveLearnedFact, getLearnedFacts } from './database.js';
import { handleReplyToBot, handleDirectMention } from './decision.js';
import { generateResponse } from './llm.js';
import { startHealthServer } from './health.js';
import { shouldSearch, searchFacts, formatSearchResultsForLLM } from './tavily.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('❌ TELEGRAM_BOT_TOKEN required.'); process.exit(1); }
if (!process.env.LLM_API_KEY && !process.env.NVIDIA_API_KEY) { console.error('❌ LLM_API_KEY required.'); process.exit(1); }
if (!process.env.TAVILY_API_KEY) { console.error('❌ TAVILY_API_KEY required.'); process.exit(1); }

const PORT = process.env.PORT || 3000;
startHealthServer(PORT);

const bot = new TelegramBot(token, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 10 } },
});

let botInfo = null;
bot.getMe().then((info) => {
  botInfo = info;
  console.log(`✅ Gahmood started: @${botInfo.username} (ID: ${botInfo.id})`);
  console.log('🤖 Ready. Mention or reply to talk.');
}).catch((err) => {
  console.error('❌ Failed:', err.message);
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

bot.on('message', async (msg) => {
  try {
    if (!botInfo) return;
    if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
    if (!msg.text || msg.text.length === 0) return;
    if (String(msg.from.id) === String(botInfo.id)) return;

    const chat_id = msg.chat.id;
    const user_id = msg.from.id;
    const username = msg.from.username || null;
    const first_name = msg.from.first_name || null;
    const text = msg.text;
    const telegram_msg_id = msg.message_id;
    const thread_id = msg.message_thread_id || null;
    const reply_to_user_id = msg.reply_to_message?.from?.id || null;
    const reply_to_msg_id = msg.reply_to_message?.message_id || null;

    // Store message + update local stats (NO AI CALL)
    storeMessage({ telegram_msg_id, chat_id, thread_id, user_id, username, first_name, text, reply_to_user_id, reply_to_msg_id });
    updateSpeakerStats(chat_id, user_id, username, first_name, text);

    // Skip command messages (handled by onText below)
    if (isCommand(text)) return;

    // Check if bot should respond
    const isReplyToBot = reply_to_user_id && String(reply_to_user_id) === String(botInfo.id);
    const mentioned = isBotMentioned(text);

    // Check for "learn" command: گاحمود یادبگیر که ...
    const learnMatch = text.match(/(?:قاهمد|گاحمود|گاهمود|شاهمود|gahmood|shahmood)\s*یاد\s*بگیر\s*که\s*(.+)/i);
    if (learnMatch) {
      const fact = learnMatch[1].trim();
      saveLearnedFact(chat_id, fact, first_name || username);
      const opts = { reply_to_message_id: telegram_msg_id };
      if (thread_id !== null) opts.message_thread_id = thread_id;
      await bot.sendMessage(chat_id, `اوکی، حفظ کردم.`, opts);
      console.log(`[Learn] ${first_name}: ${fact.substring(0, 80)}`);
      return;
    }

    if (!isReplyToBot && !mentioned) return; // Silent — just store

    console.log(`[Route] ${first_name}: "${text.substring(0, 60)}" | reply=${isReplyToBot} mention=${mentioned}`);

    try {
      const handler = isReplyToBot ? handleReplyToBot : handleDirectMention;
      const result = await handler({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id });
      if (result && result.text) {
        const opts = { reply_to_message_id: telegram_msg_id, disable_web_page_preview: true };
        if (thread_id !== null) opts.message_thread_id = thread_id;
        await bot.sendMessage(chat_id, result.text, opts);
        console.log(`[Sent] OK`);
      }
    } catch (err) {
      console.error('[Error]', err.message);
    }
  } catch (err) {
    console.error('[Bot]', err.message);
  }
});

// --- Commands ---

bot.onText(/\/gahmood_ask (.+)/, async (msg, match) => {
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  const chat_id = msg.chat.id;
  const thread_id = msg.message_thread_id || null;
  const question = match[1];
  const opts = { reply_to_message_id: msg.message_id };
  if (thread_id !== null) opts.message_thread_id = thread_id;

  await bot.sendChatAction(chat_id, 'typing');
  try {
    let searchContext = '';
    if (shouldSearch(question)) {
      const results = await searchFacts(question.substring(0, 200), { maxResults: 4 });
      searchContext = formatSearchResultsForLLM([results]);
    }
    let sysPrompt = 'تو قاهمد هستی. کوتاه و مستند جواب بده. فارسی حرف بزن.';
    if (searchContext) sysPrompt += '\n' + searchContext;
    const response = await generateResponse({
      systemPrompt: sysPrompt,
      messages: [{ role: 'user', content: question }],
      temperature: 0.8, maxTokens: 500,
    });
    await bot.sendMessage(chat_id, response, opts);
  } catch (err) {
    console.error('[Ask]', err.message);
    await bot.sendMessage(chat_id, 'الان نمی‌تونم.', opts);
  }
});

bot.on('polling_error', (err) => console.error('[Polling]', err.message));
process.on('SIGINT', () => { bot.stopPolling(); process.exit(0); });
process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
