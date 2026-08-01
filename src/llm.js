import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: process.env.NVIDIA_API_KEY || process.env.OPENAI_API_KEY || 'missing-key',
});

const MODEL = process.env.MODEL_NAME || 'deepseek-ai/deepseek-v4-pro';

console.log(`[LLM] Using model: ${MODEL}`);
console.log(`[LLM] API Key present: ${!!process.env.NVIDIA_API_KEY}`);
console.log(`[LLM] Tavily Key present: ${!!process.env.TAVILY_API_KEY}`);

/**
 * Main LLM call — generates Gahmood's responses
 */
export async function generateResponse({ systemPrompt, messages, temperature = 0.8, maxTokens = 1024 }) {
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      temperature,
      top_p: 0.95,
      max_tokens: maxTokens,
      extra_body: {
        chat_template_kwargs: { thinking: false },
      },
      stream: false,
    });

    return completion.choices[0]?.message?.content || '';
  } catch (err) {
    console.error('[LLM] API error:', err.status, err.message);
    if (err.response) {
      console.error('[LLM] Response body:', JSON.stringify(err.response.body || err.response.data || {}).substring(0, 500));
    }
    throw err;
  }
}

/**
 * Tension detection — analyzes if a conversation needs Gahmood's intervention
 * Returns: { shouldIntervene, reason, topic, tensionScore, disputedClaims }
 */
export async function detectTension({ recentMessages, botMentioned }) {
  // If directly mentioned, always intervene
  if (botMentioned) {
    return {
      shouldIntervene: true,
      reason: 'direct_mention',
      topic: detectTopic(recentMessages),
      tensionScore: 1.0,
      disputedClaims: [],
    };
  }

  const formattedMessages = recentMessages
    .slice(-15) // Last 15 messages for analysis
    .map(m => `${m.first_name || m.username || 'Unknown'}: ${m.text}`)
    .join('\n');

  const systemPrompt = `You are a conversation analysis AI. Analyze the following Telegram group chat messages and determine if there is a factual disagreement, argument, or dispute that would benefit from fact-based intervention.

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "shouldIntervene": boolean,
  "tensionScore": 0.0-1.0,
  "reason": "factual_dispute" | "heated_argument" | "misinformation" | "casual_chat" | "subjective_debate",
  "topic": "brief topic description in Persian",
  "topicCategory": "politics" | "sports" | "science" | "economics" | "history" | "social" | "other",
  "disputedClaims": ["list of specific factual claims that are being debated"],
  "keyParticipants": ["usernames or names of people arguing"]
}

Intervene when:
- Someone states a potentially incorrect fact that others dispute
- A factual argument is escalating (not just casual disagreement)
- Political, sports, or historical facts are being debated incorrectly
- DON'T intervene for: casual chat, jokes, personal opinions without factual claims, greetings

Tension score guide:
- 0.0-0.3: Casual chat, no intervention needed
- 0.3-0.5: Mild disagreement, monitor
- 0.5-0.7: Active factual dispute, consider intervening
- 0.7-1.0: Heated argument with misinformation, intervene immediately`;

  try {
    const response = await generateResponse({
      systemPrompt,
      messages: [{ role: 'user', content: formattedMessages }],
      temperature: 0.3,
      maxTokens: 512,
    });

    const cleaned = response.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned);

    // Override: if tension is below threshold, don't intervene
    const threshold = parseFloat(process.env.TENSION_THRESHOLD || '0.65');
    if (result.tensionScore < threshold) {
      result.shouldIntervene = false;
    }

    return result;
  } catch (err) {
    console.error('[LLM] Tension detection error:', err.message);
    return {
      shouldIntervene: false,
      reason: 'analysis_error',
      tensionScore: 0,
      topic: '',
      disputedClaims: [],
    };
  }
}

/**
 * Detects the general topic from recent messages (lightweight, no LLM call)
 */
function detectTopic(messages) {
  const text = messages.map(m => m.text).join(' ').toLowerCase();
  const topics = {
    'فوتبال|سوکت|تیم|بازی|لیگ|جام|گل|world cup|worldcup|messi|ronaldo|messi|رئال|بارسا': 'football',
    'سیاست|دولت|رئیس جمهور|انتخاب|جنگ|تحریم|آمریکا|ایران|سیاسی|حکومت|ترامپ|biden|war|sanction': 'politics',
    'اقتصاد|دلار|تورم|بازار|کریپتو|bitcoin|بیت کوین|ارز|قیمت': 'economics',
    'علم|فیزیک|شیمی|بیولوژی|واکسن|کرونا|space|space|هوش مصنوعی|ai': 'science',
    'تاریخ|جنگ جهانی|امپراتوری|تمدن|قدیم|historical': 'history',
  };

  for (const [pattern, topic] of Object.entries(topics)) {
    if (new RegExp(pattern, 'i').test(text)) return topic;
  }
  return 'general';
}

/**
 * Analyzes a speaker's tone from their message history
 */
export async function analyzeSpeakerTone({ messages, speakerName }) {
  if (messages.length < 3) {
    return { style: 'unknown', formality: 'unknown', humor: 'unknown', aggression: 'unknown' };
  }

  const formattedMessages = messages
    .slice(-20)
    .map(m => m.text)
    .join('\n');

  const systemPrompt = `Analyze the speaking style of the Telegram user based on their messages. Respond ONLY with valid JSON:
{
  "style": "formal" | "casual" | "slang_heavy" | "mixed",
  "formality": "high" | "medium" | "low",
  "humor": "high" | "medium" | "low" | "none",
  "aggression": "high" | "medium" | "low" | "none",
  "swearing": "frequent" | "occasional" | "rare" | "none",
  "persian_style": "short_bursts" | "long_paragraphs" | "mixed",
  "typical_greetings": ["list of common phrases they use"],
  "vocabulary_level": "simple" | "moderate" | "advanced"
}`;

  try {
    const response = await generateResponse({
      systemPrompt,
      messages: [{ role: 'user', content: `User: ${speakerName}\n\nMessages:\n${formattedMessages}` }],
      temperature: 0.2,
      maxTokens: 256,
    });

    const cleaned = response.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[LLM] Tone analysis error:', err.message);
    return { style: 'unknown', formality: 'unknown', humor: 'unknown', aggression: 'unknown' };
  }
}

/**
 * Generates the group's overall tone from a sample of messages
 */
export async function analyzeGroupTone({ messages }) {
  if (messages.length < 5) {
    return { overallVibe: 'unknown', commonSlang: [], formality: 'unknown' };
  }

  // Take a diverse sample
  const sample = [];
  const step = Math.max(1, Math.floor(messages.length / 30));
  for (let i = 0; i < messages.length && sample.length < 30; i += step) {
    sample.push(messages[i]);
  }

  const formattedMessages = sample
    .map(m => `${m.first_name || m.username || 'User'}: ${m.text}`)
    .join('\n');

  const systemPrompt = `Analyze the overall communication style of this Telegram group chat. Respond ONLY with valid JSON:
{
  "overallVibe": "casual" | "formal" | "chaotic" | "intellectual" | "mixed",
  "commonSlang": ["list of frequently used slang words or phrases"],
  "formality": "high" | "medium" | "low",
  "humorLevel": "high" | "medium" | "low",
  "swearingFrequency": "frequent" | "occasional" | "rare",
  "discussionStyle": "heated" | "calm" | "playful" | "analytical" | "mixed",
  "commonTopics": ["list of topics that come up frequently"]
}`;

  try {
    const response = await generateResponse({
      systemPrompt,
      messages: [{ role: 'user', content: formattedMessages }],
      temperature: 0.2,
      maxTokens: 256,
    });

    const cleaned = response.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[LLM] Group tone analysis error:', err.message);
    return { overallVibe: 'unknown', commonSlang: [], formality: 'unknown' };
  }
}
