import axios from 'axios';

const TAVILY_URL = 'https://api.tavily.com';

/**
 * Determine if a message needs real-time search.
 * Searches when the message contains factual claims, questions about events,
 * dates, statistics, or current/recent events.
 */
export function shouldSearch(text) {
  if (!text || text.length < 5) return false;

  // Always search for these patterns
  const searchTriggers = [
    // Years - recent events
    /202[0-9]/,
    // Questions
    /چطور|چجور|چرا|کجا|کی|کدوم|نمی‌دونم|نمیدونم|درسته|غلطه|اشتباهه|راستش|حق داره|مال کیه|کی بود|چی بود|چقدر| چند/,
    // Factual indicators
    /آمار|statistic|گزارش|report|طبق|according|منبع|source|news|خبر/,
    // Political/geopolitical
    /جنگ|war|تحریم|sanction|انتخاب|election|رئیس|president|دولت|حکومت|سیاست|معاهده|ترامپ|biden|Trump/,
    // Sports
    /گل|goal|بازی|match|فینال|final|لیگ|league|جام|cup|messi|ronaldo|رئال|بارسا|real madrid|barcelona/,
    // Economics
    /دلار|dollar|تورم|inflation|قیمت|price|بازار|market|کریپتو|crypto|bitcoin|بیت‌کوین/,
    // Science/tech
    /واکسن|vaccine|کرونا|covid|ai|هوش مصنوعی|spaceship|space|مریخ|mars/,
  ];

  for (const pattern of searchTriggers) {
    if (pattern.test(text)) return true;
  }

  return false;
}

/**
 * Search for real-time facts using Tavily API
 * @param {string} query - The search query
 * @param {Object} options - Search options
 * @returns {Object} - Search results with answer, sources, and raw results
 */
export async function searchFacts(query, options = {}) {
  const {
    maxResults = 5,
    searchDepth = 'advanced',
    includeAnswer = true,
    topic = 'general',
  } = options;

  try {
    const response = await axios.post(
      `${TAVILY_URL}/search`,
      {
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: maxResults,
        search_depth: searchDepth,
        include_answer: includeAnswer,
        topic,
      },
      {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const data = response.data;

    return {
      answer: data.answer || null,
      results: (data.results || []).map(r => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
      })),
      query,
    };
  } catch (err) {
    console.error('[Tavily] Search error:', err.message);
    return {
      answer: null,
      results: [],
      query,
      error: err.message,
    };
  }
}

/**
 * Batch search multiple queries
 * @param {string[]} queries
 * @returns {Object[]} - Array of search results
 */
export async function batchSearch(queries) {
  const results = await Promise.all(
    queries.map(q => searchFacts(q))
  );
  return results;
}

/**
 * Format search results for inclusion in LLM context
 * @param {Object[]} searchResults - Array of search result objects
 * @returns {string} - Formatted string for LLM context
 */
export function formatSearchResultsForLLM(searchResults) {
  let formatted = '=== REAL-TIME FACTS (via web search) ===\n\n';

  for (const result of searchResults) {
    if (result.error) {
      formatted += `Query: "${result.query}" - Search failed: ${result.error}\n\n`;
      continue;
    }

    formatted += `Query: "${result.query}"\n`;

    if (result.answer) {
      formatted += `Quick Answer: ${result.answer}\n`;
    }

    if (result.results.length > 0) {
      formatted += 'Sources:\n';
      for (const r of result.results.slice(0, 3)) {
        // Truncate content to keep context manageable
        const content = r.content.length > 500
          ? r.content.substring(0, 500) + '...'
          : r.content;
        formatted += `- ${r.title}: ${content}\n`;
        formatted += `  URL: ${r.url}\n`;
      }
    }

    formatted += '\n';
  }

  formatted += '=== END REAL-TIME FACTS ===\n';
  return formatted;
}
