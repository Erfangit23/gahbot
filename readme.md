# Gahmood Bot (قاهمد)

ربات تلگرامی که مثل یه آدم واقعی وارد بحث‌های گروه میشه و بر اساس آمار دقیق و اطلاعات درست نظر میده.

## ویژگی‌ها

- **تشخیص خودکار بحث و اختلاف نظر** — ربات همه پیام‌ها رو می‌خونه و وقتی بفهمه بحث شروع شده، خودش وارد میشه
- **اطلاعات واقعی و به‌روز** — از Tavily API برای جستجوی لحظه‌ای استفاده می‌کنه (نه فقط اطلاعات آموزش مدل)
- **شخصیت انسانی** — منطقی مثل قاضی، بامزه، +18، صاحب نظر
- **یادگیری لحن** — هم لحن کلی گروه رو یاد می‌گیره، هم لحن هر شخص رو
- **حافظه دائمی** — همه پیام‌های گروه رو ذخیره می‌کنه و بهشون ارجاع میده
- **طرفدار حق** — به کسی که حق داره می‌پیچه، ولی اشتباهاتشو هم میگه

## راه‌اندازی

### ۱. ساخت ربات تلگرام

1. به [@BotFather](https://t.me/BotFather) پیام بده
2. `/newbot` رو بزن و اسم `Gahmood` رو انتخاب کن
3. توکن رو کپی کن
4. `/setprivacy` → `Disable` رو بزن تا ربات همه پیام‌ها رو ببینه
5. ربات رو به گروه اضافه کن و **ادمین** کن

### ۲. گرفتن API Key ها

**NVIDIA NIM (برای DeepSeek V4 Pro):**
1. به [build.nvidia.com](https://build.nvidia.com) برو
2. ثبت‌نام کن
3. API Key بگیر

**Tavily (برای جستجوی لحظه‌ای):**
1. به [tavily.com](https://tavily.com) برو
2. ثبت‌نام کن (۱۰۰۰ جستجوی رایگان در ماه)
3. API Key بگیر

### ۳. تنظیم محیط

```bash
# فایل .env بساز
cp .env.example .env

# مقادیر رو پر کن
TELEGRAM_BOT_TOKEN=your_token
NVIDIA_API_KEY=your_key
TAVILY_API_KEY=your_key
```

### ۴. نصب و اجرا

```bash
npm install
npm start
```

## استقرار روی Railway

1. ریپو رو به GitHub پوش کن
2. توی [Railway](https://railway.app) ریپو رو connect کن
3. متغیرهای محیطی رو توی Railway تنظیم کن:
   - `TELEGRAM_BOT_TOKEN`
   - `NVIDIA_API_KEY`
   - `TAVILY_API_KEY`
4. Deploy کن

**نکته:** برای ذخیره‌سازی دائمی SQLite روی Railway، یه Volume mount کن به مسیر `data/`.

## دستورات

| دستور | کاربرد |
|---|---|
| `/gahmood_tone` | تحلیل لحن گروه و اعضا |
| `/gahmood_stats` | آمار گروه |
| `/gahmood_ask <سوال>` | سوال مستقیم از قاهمد |
| `@Gahmood` یا `قاهمد` | منشن کردن ربات تو بحث |

## معماری

```
Telegram Group → Railway App (Node.js)
                      ↓
              Message Router (receives all messages)
                      ↓
              Tension Detector (LLM analyzes conversation)
                      ↓ (if intervention needed)
              Tavily Search (fact-check disputed claims)
                      ↓
              DeepSeek V4 Pro (generate human-like response)
                      ↓
              Telegram API (send reply)
```

## تنظیمات

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `TENSION_THRESHOLD` | 0.65 | حداقل امتیاز تنش برای ورود به بحث |
| `COOLDOWN_MS` | 30000 | فاصله زمانی بین جواب‌ها (میلی‌ثانیه) |
| `MAX_HISTORY_MESSAGES` | 50 | تعداد پیام‌های اخیر برای context |
| `MODEL_NAME` | deepseek-ai/deepseek-v4-pro | مدل NVIDIA NIM |
