# 📥 m27_yuklabot — Telegram Bot

Instagram va YouTube yuklovchi + Musiqa tanib oluvchi bot!

## ✨ Imkoniyatlar

| Feature | Holat |
|---|---|
| Instagram Reels | ✅ |
| Instagram Post (rasm) | ✅ |
| Instagram Stories | ✅ |
| YouTube Video | ✅ |
| YouTube Shorts | ✅ |
| Musiqa tanib olish (AudD) | ✅ |
| Musiqa yuklab olish (MP3) | ✅ |
| Music YouTube video | ✅ |

---

## 🚀 O'rnatish

### 1. Talablar

- **Node.js** v18+ → [nodejs.org](https://nodejs.org)
- **yt-dlp** → [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **ffmpeg** → [ffmpeg.org](https://ffmpeg.org) *(musiqa klip uchun)*

### 2. yt-dlp o'rnatish

```bash
# Windows (winget)
winget install yt-dlp

# yoki pip orqali
pip install yt-dlp

# macOS / Linux
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp
```

### 3. ffmpeg o'rnatish

```bash
# Windows
winget install ffmpeg

# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg
```

### 4. Bot tokenini olish

1. Telegramda **@BotFather** ga yozing
2. `/newbot` buyrug'ini yuboring
3. Bot nomini kiriting
4. Tokenni oling

### 5. AudD API kaliti (musiqa tanish uchun)

1. [audd.io](https://audd.io) saytiga kiring
2. Ro'yxatdan o'ting (bepul!)
3. API kalitni oling
4. Oyiga **300 so'rov** bepul

### 6. .env fayli yarating

```bash
cp .env.example .env
# Keyin .env faylini oching va TOKEN ingizni kiriting
```

`.env` fayli:
```
BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxyz
AUDD_API_KEY=siz_ning_audd_kalit
```

### 7. Paketlarni o'rnatish va ishga tushirish

```bash
npm install
npm start
```

---

## 🌐 Bepul Serverga Deploy (24/7)

### Railway.app (Eng oson!)

1. [railway.app](https://railway.app) → GitHub bilan login
2. **New Project** → **Deploy from GitHub Repo**
3. Bu papkani GitHub ga push qiling
4. Railway da **Variables** bo'limiga:
   - `BOT_TOKEN` = tokeningiz
   - `AUDD_API_KEY` = audd kalitingiz
5. Deploy → Bot 24/7 ishlaydi! ✅

> ⚠️ Railway da yt-dlp va ffmpeg o'rnatish uchun `Procfile` va `nixpacks.toml` kerak (quyida ko'ring)

### Nixpacks konfiguratsiyasi (Railway uchun)

`nixpacks.toml` fayli:
```toml
[phases.setup]
nixPkgs = ["yt-dlp", "ffmpeg"]
```

---

## 📱 Foydalanish

1. Botga Instagram yoki YouTube linkini yuboring
2. Bot videoni/rasmni yuboradi
3. **🎵 Qo'shiqni yuklab olish** tugmasini bosing
4. Bot musiqa tanib, 5 ta variant ko'rsatadi
5. Raqamni bosib MP3 yuklab oling!

---

## 🔧 Muammolar va yechimlar

| Muammo | Yechim |
|---|---|
| `yt-dlp not found` | yt-dlp ni to'g'ri o'rnating |
| Instagram yuklanmaydi | Cookie fayl kerak bo'lishi mumkin |
| Musiqa tanilmaydi | AudD API kalitini tekshiring |
| Fayl juda katta | 49 MB dan katta fayllar yuklanmaydi |

---

Made with ❤️ by m27_yuklabot
