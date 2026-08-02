import OpenAI from 'openai';

// Chat LLM client
const chatClient = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || 'https://api.hcnsec.cn/v1',
  apiKey: process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY || 'missing-key',
});
const CHAT_MODEL = process.env.MODEL_NAME || 'DeepSeek-V4-Pro';

// Code LLM client (separate API/model)
const codeClient = new OpenAI({
  baseURL: process.env.CODE_LLM_BASE_URL || process.env.LLM_BASE_URL || 'https://api.hcnsec.cn/v1',
  apiKey: process.env.CODE_LLM_API_KEY || process.env.LLM_API_KEY || 'missing-key',
});
const CODE_MODEL = process.env.CODE_MODEL_NAME || 'DeepSeek-V4-Pro';

console.log(`[LLM] Chat: ${CHAT_MODEL} @ ${process.env.LLM_BASE_URL || 'https://api.hcnsec.cn/v1'}`);
console.log(`[LLM] Code: ${CODE_MODEL} @ ${process.env.CODE_LLM_BASE_URL || 'default'}`);
console.log(`[LLM] Chat Key: ${!!(process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY)}`);
console.log(`[LLM] Code Key: ${!!(process.env.CODE_LLM_API_KEY || process.env.LLM_API_KEY)}`);
console.log(`[LLM] Tavily: ${!!process.env.TAVILY_API_KEY}`);

/**
 * Chat LLM call
 */
export async function generateResponse({ systemPrompt, messages, temperature = 0.8, maxTokens = 1024 }) {
  const maxRetries = 3;
  const baseDelay = 5000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const completion = await chatClient.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature,
        max_tokens: maxTokens,
      });
      return completion.choices[0]?.message?.content || '';
    } catch (err) {
      console.error(`[LLM] Chat error (attempt ${attempt + 1}):`, err.status, err.message);
      if (err.status === 429 && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, baseDelay * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return '';
}

/**
 * Code LLM call — uses separate API/model
 */
export async function generateCode({ systemPrompt, messages, temperature = 0.2, maxTokens = 16000 }) {
  const maxRetries = 3;
  const baseDelay = 5000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const completion = await codeClient.chat.completions.create({
        model: CODE_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature,
        max_tokens: maxTokens,
      });
      return completion.choices[0]?.message?.content || '';
    } catch (err) {
      console.error(`[LLM] Code error (attempt ${attempt + 1}):`, err.status, err.message);
      if (err.status === 429 && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, baseDelay * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return '';
}
