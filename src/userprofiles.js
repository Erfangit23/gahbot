/**
 * Pre-configured user profiles for Gahmood.
 * The bot knows these things about group members but uses them naturally —
 * not mentioning them in every response, just as background context.
 */

export const USER_PROFILES = {
  'MhmdAmnMara30': {
    name: 'مراث',
    info: 'هول‌ترین نفر گروه. اسم واقعیش مراثه نه محمد. بهش میگن جقیه با نمکه. خیلی پورن میبینه. عاشق آنا دی آرماسه. یه همسایه بالایی داره شبیه خودش که اونم دوست داره. ۱۵ سالشه. جق میزنه و به همین معروفه. عاشق پزشکیه و میخواد پولدار بشه.',
    relationships: 'دوستی خوبی با عرفان (@The_usdt_hunter) داره. باهاش میخواد برن دبی یا ایران پول بدن دختر سکس کنن. با دانیال (@danial_vzf) سر سهند حرف داره. سهند همکلاسی گیتار دانیاله و شبیه فمبویاست و مراث میخواد باهاش باشه. ایلار و رها هم خوشگلن و عرفانم دوسشون داره.',
  },
  'The_usdt_hunter': {
    name: 'عرفان',
    info: '۱۵ سالشه. شخصتش شبیه مراثه ولی تنوع طلبه و دختر فن باز. عاشق سیدنی سوییینیه. ترید کرده. برنامه‌نویسی پایتون خیلی قویه ولی گیم اینا اصلا نداره.',
    relationships: 'دوستی خیلی قدیمی و خفنی با ماسلر (@MASELARMSV) داره. با مراث (@MhmdAmnMara30) دوستیه و باهاش میخواد برن دبی. ایلار و رها رو دوست داره.',
  },
  'danial_vzf': {
    name: 'دانیال',
    info: 'استاد وظیفه و مالک گروه. همه بهش احترام میذارن و استاد صداش میزنن. پسر مخ گیتار الکتریکه و موسیقی فنه. عاشق و کراش دوالیپاست. عقیده‌ش اوپن‌مindedه — جق زدن بده، سیگار بده، به دختر مردم اذار رسوندن بده.',
    relationships: 'با مراث (@MhmdAmnMara30) سر سهند حرف دارن. سهند همکلاسی گیتارشه.',
  },
  'AVP_1st': {
    name: 'آیمان',
    info: 'بهش میگن کیشی (به معنی مرد واقعی به ترکی). تکیه‌کلام‌هاش: پیندا (به فرد بد و کصشر میگن)، کعدیر (یعنی سیکتیره، جهنم شو برو)، پیندیرم (همون معنی). مسیحیه و خیلی جیزس جیزس میگه. سکسو دوست داره. خیلی هیتلر فنه و ضد یهوده.',
    relationships: 'دوست صمیمی آرتینه (@Artinmomenikia).',
  },
  'MASELARMSV': {
    name: 'ماسلر',
    info: 'عجیب‌ترین فرد گروه. شجاع‌ترین و نترس‌ترینه. اهل کالی لینوکس و هکه. میخواد مهاجرت کنه و ایرانو اصلا دوست نداره. میخواد پولدار بشه. ترامپ فنه و طرفشو نگه میداره ولی از جمهوری اسلامی ایران شدید بدش میاد.',
    relationships: 'دوست صمیمی عرفان (@The_usdt_hunter). عقیده داره مراث همیشه کصخلع و چرت میگه.',
  },
  'Artinmomenikia': {
    name: 'آرتین',
    info: 'درس‌خوان و مودب. ضد سکس. مسیحیه. میخواد مهاجرت کنه. اهل موسیقی و اسپاتیفای. ریاضی رو خیلی دوست داره ولی حوصله‌ش با برنامه‌نویسی نمیکشه.',
    relationships: 'دوست صمیمی آیمان (@AVP_1st).',
  },
};

/**
 * Get user profile by username
 */
export function getUserProfile(username) {
  if (!username) return null;
  const clean = username.replace('@', '').toLowerCase();
  for (const [key, val] of Object.entries(USER_PROFILES)) {
    if (key.toLowerCase() === clean) return val;
  }
  return null;
}

/**
 * Format user profiles for system prompt
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
