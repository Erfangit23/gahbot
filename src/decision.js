import { getRecentMessages, storeBotReply } from './database.js';
import { generateResponse } from './llm.js';
import { shouldSearch, searchFacts, formatSearchResultsForLLM } from './tavily.js';
import { buildSystemPrompt } from './persona.js';
import { formatUserProfiles } from './userProfiles.js';
import { buildLocalContext } from './memory.js';

/**
 * Handle when someone mentions the bot or replies to it.
 * ONE API call total. All context is built locally.
 */
export async function handleInteraction({ chat_id, thread_id, user_id, username, first_name, text, telegram_msg_id, isReply }) {
  // Build all context locally (NO AI calls)
  const localContext = buildLocalContext(chat_id, thread_id);

  // Get user profiles for active participants
  const recentMessages = getRecentMessages(chat_id, thread_id, 15);
  const recentUsernames = recentMessages.map(m => m.username).filter(Boolean);
  if (username) recentUsernames.push(username);
  const userProfileContext = formatUserProfiles([...new Set(recentUsernames)]);

  // Search for real-time facts only if the message needs it
  let searchContext = '';
  if (shouldSearch(text)) {
    console.log(`[Search] ${text.substring(0, 80)}`);
    try {
      const results = await searchFacts(text.substring(0, 200), { maxResults: 4 });
      searchContext = formatSearchResultsForLLM([results]);
    } catch (e) {
      console.error('[Search] Error:', e.message);
    }
  }

  // Build system prompt
  const systemPrompt = buildSystemPrompt({ searchContext, localContext, userProfileContext });

  // Build conversation — last few messages for context
  const conversationMessages = recentMessages
    .slice(-8)
    .map(m => ({
      role: 'user',
      content: `${m.first_name || m.username || 'ناشناس'}: ${m.text}`,
    }));

  // Add the current message
  const label = isReply ? `(در جواب تو)` : '';
  conversationMessages.push({
    role: 'user',
    content: `${first_name || username || 'ناشناس'} ${label}: ${text}`,
  });

  // ONE API call
  const response = await generateResponse({
    systemPrompt,
    messages: conversationMessages,
    temperature: 0.8,
    maxTokens: 500,
  });

  if (!response || response.trim().length === 0) return null;

  storeBotReply({ chat_id, thread_id, trigger_msg_id: telegram_msg_id, reply_text: response, topic: 'response' });
  return { text: response };
}

// Keep exports for backwards compat
export async function handleReplyToBot(opts) {
  return handleInteraction({ ...opts, isReply: true });
}

export async function handleDirectMention(opts) {
  return handleInteraction({ ...opts, isReply: false });
}

export async function processMessage() { return null; }
