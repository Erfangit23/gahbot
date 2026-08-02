/**
 * Pre-configured user profiles.
 */

export const USER_PROFILES = {
  'MhmdAmnMara30': {
    name: 'مراث',
    info: 'هول‌ترین نفر گروه. ۱۵ سالشه. جق میزنه و به همین معروفه. پورن میبینه. عاشق آنا دی آرماسه. یه همسایه بالینی داره شبیه خودش. عاشق پزشکیه و میخواد پولدار بشه.',
    relationships: 'با عرفان (@The_usdt_hunter) دوستیه و میخواد باهاش برن دبی. با دانیال (@danial_vzf) سر سهند حرف داره. سهند همکلاسی گیتار دانیاله و مراث میخواد باهاش باشه. ایلار و رها رو دوست داره.',
  },
  'The_usdt_hunter': {
    name: 'عرفان',
    info: '۱۵ سالشه. شبیه مراثه ولی تنوع طلبه. عاشق سیدنی سوییینیه. ترید کرده. برنامه‌نویسی پایتون قویه. گیم نداره.',
    relationships: 'دوست قدیمی ماسلر (@MASELARMSV). با مراث (@MhmdAmnMara30) دوستیه.',
  },
  'danial_vzf': {
    name: 'دانیال',
    info: 'استاد و مالک گروه. پسر مخ گیتار الکتریکه. موسیقی فنه. کراش دوالیپاست. اوپن‌مinded — جق بده، سیگار بده، اذار رسوندن بده.',
    relationships: 'با مراث سر سهند حرف دارن.',
  },
  'AVP_1st': {
    name: 'آیمان',
    info: 'بهش میگن کیشی. مسیحیه و جیزس میگه. هیتلر فنه و ضد یهوده. سکسو دوست داره. تکیه‌کلام: پیندا، کعدیر، پیندیرم.',
    relationships: 'دوست صمیمی آرتین.',
  },
  'MASELARMSV': {
    name: 'ماسلر',
    info: 'شجاع‌ترین و نترس‌ترین. اهل کالی لینوکس و هک. میخواد مهاجرت کنه. ترامپ فنه. ضد جمهوری اسلامی. فکر می‌کنه مراث همیشه چرت میگه.',
    relationships: 'دوست صمیمی عرفان.',
  },
  'Artinmomenikia': {
    name: 'آرتین',
    info: 'درس‌خوان و مودب. ضد سکس. مسیحیه. میخواد مهاجرت کنه. موسیقی و اسپاتیفای. ریاضی دوست داره.',
    relationships: 'دوست صمیمی آیمان.',
  },
};

export function getUserProfile(username) {
  if (!username) return null;
  const clean = username.replace('@', '').toLowerCase();
  for (const [key, val] of Object.entries(USER_PROFILES)) {
    if (key.toLowerCase() === clean) return val;
  }
  return null;
}

export function formatUserProfiles(usernames) {
  let formatted = '';
  for (const username of usernames) {
    const profile = getUserProfile(username);
    if (profile) {
      formatted += `- @${username} (${profile.name}): ${profile.info}`;
      if (profile.relationships) formatted += ` | ${profile.relationships}`;
      formatted += '\n';
    }
  }
  return formatted ? `\n## افراد گروه که می‌شناسی:\n${formatted}\nطبیعی استفاده کن، هی تکرار نکن.\n` : '';
}
