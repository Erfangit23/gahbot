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

  // Send last 50 messages with full speaker context for deep understanding
  const formattedMessages = recentMessages
    .slice(-50)
    .map(m => {
      const name = m.first_name || m.username || 'ناشناس';
      const time = new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${name}: ${m.text}`;
    })
    .join('\n');

  const systemPrompt = `You are an AI that deeply understands Persian Telegram group conversations. You read every message, understand who is saying what, the meaning behind their words, the tone, and the social dynamics.

Read the conversation carefully. Understand:
- What each person is saying and what they MEAN (not just literal words)
- The flow of conversation — who started a topic, who agreed, who disagreed
- Whether someone is stating a fact that could be wrong
- Whether two or more people have different views on something
- Whether the disagreement is factual (verifiable) or subjective (opinion)
- The emotional temperature — is it casual, tense, heated?
- Who is addressing whom

Then decide: would this conversation benefit from someone stepping in with verified facts and a balanced perspective?

Respond ONLY with valid JSON:
{
  "shouldIntervene": boolean,
  "tensionScore": 0.0-1.0,
  "reason": "factual_dispute" | "heated_argument" | "misinformation" | "casual_chat" | "subjective_debate" | "mild_disagreement",
  "topic": "موضوع بحث به فارسی",
  "topicCategory": "politics" | "sports" | "science" | "economics" | "history" | "social" | "other",
  "disputedClaims": ["ادعاهای مورد بحث به فارسی - فقط ادعاهای قابل بررسی"],
  "keyParticipants": ["اسم کسانی که بحث می‌کنند"],
  "conversationSummary": "خلاصه کوتاه اینکه چه می‌گذرد"
}

Tension score:
- 0.0-0.2: Casual chat, greetings, jokes, no disagreement
- 0.2-0.4: Someone states an opinion, others have different views but it's friendly
- 0.4-0.6: Real disagreement — people have different facts or views and are pushing back on each other
- 0.6-0.8: Active argument with likely wrong information being stated as fact
- 0.8-1.0: Heated argument, misinformation, multiple people arguing

Intervene when: tensionScore >= 0.4 AND there are factual claims that could be verified or corrected.
Do NOT intervene for: greetings, casual jokes, friendly banter, personal stories, or opinions that are clearly subjective with no factual claims.
NEVER intervene for: sports, football, soccer, or any sports-related discussions. If the topicCategory is "sports", always set shouldIntervene to false. The bot should ignore all sports conversations completely.`;

  try {
    const response = await generateResponse({
      systemPrompt,
      messages: [{ role: 'user', content: formattedMessages }],
      temperature: 0.3,
      maxTokens: 512,
    });

    const cleaned = response.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned);

    // Hard block: never intervene in sports
    if (result.topicCategory === 'sports' || result.topic === 'football' || result.topic === 'فوتبال' || result.topic === 'ورزش') {
      result.shouldIntervene = false;
    }

    // Override: if tension is below threshold, don't intervene
    const threshold = parseFloat(process.env.TENSION_THRESHOLD || '0.4');
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
