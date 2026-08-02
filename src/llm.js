import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || 'https://api.hcnsec.cn/v1',
  apiKey: process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY || 'missing-key',
});

const MODEL = process.env.MODEL_NAME || 'DeepSeek-V4-Pro';

console.log(`[LLM] Model: ${MODEL}`);
console.log(`[LLM] Base URL: ${process.env.LLM_BASE_URL || 'https://api.hcnsec.cn/v1'}`);
console.log(`[LLM] API Key present: ${!!(process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY)}`);

/**
 * Single LLM call with retry for rate limits
 */
export async function generateResponse({ systemPrompt, messages, temperature = 0.8, maxTokens = 1024 }) {
  const maxRetries = 3;
  const baseDelay = 5000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature,
        max_tokens: maxTokens,
      });
      return completion.choices[0]?.message?.content || '';
    } catch (err) {
      console.error(`[LLM] Error (attempt ${attempt + 1}/${maxRetries}):`, err.status, err.message);
      if (err.status === 429 && attempt < maxRetries - 1) {
        const delay = baseDelay * (attempt + 1);
        console.log(`[LLM] Rate limited, waiting ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  return '';
}
