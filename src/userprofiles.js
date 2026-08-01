/**
 * Pre-configured user profiles for Gahmood.
 * The bot knows these things about group members but uses them naturally —
 * not mentioning them in every response, just as background context.
 * 
 * To add/edit users, update this file and redeploy.
 */

export const USER_PROFILES = {
  'MhmdAmnMara30': {
    name: 'محمد',
    info: 'یه جقیه با نمکه بهش مراث میگن. خیلی پزشکی رو دوست داره. میخواد خیلی پولدار بشه بره دبی دخترارو بکنه. اهل عشق و حاله.',
    relationships: 'با عرفان (@The_usdt_hunter) رابطه خوبی داره',
  },
  'The_usdt_hunter': {
    name: 'عرفان',
    info: 'علاقه‌مند به کریپتو و تردینگ.',
    relationships: 'با محمد (@MhmdAmnMara30) رابطه خوبی داره',
  },
  // Add more users here:
  // 'username': {
  //   name: 'اسم',
  //   info: 'اطلاعات',
  //   relationships: 'روابط',
  // },
};

/**
 * Get user profile by username or user ID
 */
export function getUserProfile(username, userId) {
  if (username) {
    // Try exact username match (without @)
    const clean = username.replace('@', '').toLowerCase();
    for (const [key, val] of Object.entries(USER_PROFILES)) {
      if (key.toLowerCase() === clean) return val;
    }
  }
  return null;
}

/**
 * Format user profiles for system prompt (only for active participants)
 */
export function formatUserProfiles(usernames) {
  let formatted = '';
  for (const username of usernames) {
    const profile = getUserProfile(username);
    if (profile) {
      formatted += `\n- @${username} (${profile.name}): ${profile.info}`;
      if (profile.relationships) {
        formatted += ` | ${profile.relationships}`;
      }
      formatted += '\n';
    }
  }
  return formatted ? `\n## اطلاعات اعضای گروه که می‌شناسی:\n${formatted}\nاین اطلاعات رو طبیعی استفاده کن — مثل یه دوست که گروه رو می‌شناسه. هی تکرارشون نکن، فقط وقتی مرتبطه استفاده کن.\n` : '';
}
