import TelegramBot from 'node-telegram-bot-api';
import db, { storeMessage, updateSpeakerStats, saveLearnedFact, getLearnedFacts } from './database.js';
import { handleReplyToBot, handleDirectMention } from './decision.js';
import { generateResponse } from './llm.js';
import { startHealthServer } from './health.js';
import { shouldSearch, searchFacts, formatSearchResultsForLLM } from './tavily.js';
import { handleCodeRequest } from './coder.js';

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

/**
 * Reply "حذف سکوت" to the last message from @The_usdt_hunter in a chat.
 * Triggered by typing "doit" in the group.
 */
async function sendDeployMessage(chat_id) {
  const TARGET_USERNAME = 'The_usdt_hunter';
  const DEPLOY_TEXT = 'operation failed';

  try {
    // Find the last message from @The_usdt_hunter in this chat
    const lastMsg = db.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ? AND username = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(chat_id, TARGET_USERNAME);

    if (!lastMsg) {
      console.log(`[DoIt] No message from @${TARGET_USERNAME} in chat ${chat_id}`);
      return false;
    }

    const opts = {
      reply_to_message_id: lastMsg.telegram_msg_id,
      disable_web_page_preview: true,
    };

    if (lastMsg.thread_id) {
      opts.message_thread_id = lastMsg.thread_id;
    }

    await bot.sendMessage(chat_id, DEPLOY_TEXT, opts);
    console.log(`[DoIt] Sent "${DEPLOY_TEXT}" to chat ${chat_id}, reply to msg ${lastMsg.telegram_msg_id}`);
    return true;
  } catch (err) {
    console.error(`[DoIt] Error:`, err.message);
    return false;
  }
}

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
    // Only process group/supergroup chats
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

// --- Private message handler for "doit" ---

bot.on('message', async (msg) => {
  try {
    if (!botInfo) return;
    // Only handle private chats
    if (msg.chat.type !== 'private') return;
    if (!msg.text || msg.text.length === 0) return;
    if (String(msg.from.id) === String(botInfo.id)) return;

    if (msg.text.trim().toLowerCase() === 'doit') {
      console.log(`[DoIt] Triggered by ${msg.from.first_name} in private chat`);
      const opts = { reply_to_message_id: msg.message_id };
      await bot.sendMessage(msg.chat.id, '⏳ الان می‌فرستم...', opts);

      // Find all group chats the bot knows about
      const chats = db.prepare(`SELECT DISTINCT chat_id FROM messages`).all();
      let sentCount = 0;

      for (const { chat_id } of chats) {
        const success = await sendDeployMessage(chat_id);
        if (success) sentCount++;
      }

      await bot.sendMessage(msg.chat.id, `✅ تو ${sentCount} گروه ارسال شد.`);
    }
  } catch (err) {
    console.error('[Private]', err.message);
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

// --- /shahcode — Code generator ---

// Store last project per user for editing
const userProjects = new Map(); // user_id -> { files, projectName }

bot.onText(/\/shahcode(?:\s+(.*))?/s, async (msg, match) => {
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  const chat_id = msg.chat.id;
  const thread_id = msg.message_thread_id || null;
  const user_id = msg.from.id;
  const first_name = msg.from.first_name || 'ناشناس';
  const promptText = match?.[1]?.trim();
  const opts = { reply_to_message_id: msg.message_id };
  if (thread_id !== null) opts.message_thread_id = thread_id;

  if (!promptText) {
    await bot.sendMessage(chat_id, 'نحوه استفاده:\n`/shahcode یه سایت فروشگاهی بساز`\n`/shahcode edit دکمه سبد خرید اضافه کن`\n`/shahcode list`', { ...opts, parse_mode: 'Markdown' });
    return;
  }

  // /shahcode list — show recent projects
  if (promptText.toLowerCase() === 'list') {
    const project = userProjects.get(user_id);
    if (!project) {
      await bot.sendMessage(chat_id, 'هنوز پروژه‌ای نساختی. `/shahcode <توضیح پروژه>` بزن.', { ...opts, parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chat_id, `آخرین پروژه تو: ${project.projectName} (${project.files.length} فایل)\nبرای تغییر: \`/shahcode edit <تغییر>\``, { ...opts, parse_mode: 'Markdown' });
    }
    return;
  }

  // /shahcode edit <changes>
  const isEdit = promptText.toLowerCase().startsWith('edit ');
  const actualPrompt = isEdit ? promptText.substring(5).trim() : promptText;

  if (isEdit && !userProjects.has(user_id)) {
    await bot.sendMessage(chat_id, 'اول یه پروژه بساز بعد edit کن. `/shahcode <توضیح پروژه>`', { ...opts, parse_mode: 'Markdown' });
    return;
  }

  await bot.sendChatAction(chat_id, 'typing');
  await bot.sendMessage(chat_id, `🛠 دارم کد می‌زنم... ${isEdit ? '(ویرایش)' : ''}`, opts);

  try {
    const previousFiles = isEdit ? userProjects.get(user_id).files : null;
    const result = await handleCodeRequest({
      chat_id, thread_id, prompt: actualPrompt, telegram_msg_id: msg.message_id, isEdit, previousFiles
    });

    if (result.error) {
      await bot.sendMessage(chat_id, `خطا: ${result.error}`, opts);
      return;
    }

    // Store for future edits
    userProjects.set(user_id, { files: result.files, projectName: result.projectName });

    // Send the zip file
    const caption = `📦 ${result.projectName}\n📁 ${result.fileCount} فایل\n👤 برای ${first_name}\n\nبرای تغییر: /shahcode edit <تغییر>`;
    await bot.sendDocument(chat_id, result.zipPath, { ...opts, caption });
    console.log(`[Code] Sent ${result.fileCount} files as zip to ${first_name}`);
  } catch (err) {
    console.error('[Code] Error:', err.message);
    await bot.sendMessage(chat_id, 'خطا تو ساخت پروژه. دوباره امتحان کن.', opts);
  }
});

bot.on('polling_error', (err) => console.error('[Polling]', err.message));
process.on('SIGINT', () => { bot.stopPolling(); process.exit(0); });
process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
