require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const os = require('os');
const express = require('express'); // Qo'shildi
const app = express(); // Qo'shildi

// ============================================================
//  🔑 TOKEN VA SOZLAMALAR
// ============================================================
const TOKEN = process.env.BOT_TOKEN;
const AUDD_API_KEY = process.env.AUDD_API_KEY || 'test'; // audd.io bepul

if (!TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi! .env faylini tekshiring!');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ============================================================
//  📦 XOLAT SAQLASH (userning harakatlari)
// ============================================================
const userStates = new Map();     // { chatId => { videoPath, tmpDir, searchResults, ... } }
const pendingCleanup = new Map(); // cleanup timers

// ============================================================
//  🔗 URL ANIQLOVCHILAR
// ============================================================
const PATTERNS = {
  instagram: /https?:\/\/(www\.)?instagram\.com\/(reel|p|stories|tv)\/([A-Za-z0-9_\-]+)/i,
  youtube:   /https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[A-Za-z0-9_\-]+/i,
};

function detectPlatform(text) {
  if (PATTERNS.instagram.test(text)) return 'instagram';
  if (PATTERNS.youtube.test(text))   return 'youtube';
  return null;
}

function extractUrl(text) {
  const matchIG  = text.match(/https?:\/\/[^\s]+instagram\.com[^\s]*/i);
  const matchYT  = text.match(/https?:\/\/[^\s]*(youtube\.com|youtu\.be)[^\s]*/i);
  return (matchIG || matchYT || [])[0] || null;
}

// ============================================================
//  📁 TEMP PAPKA BOSHQARUVCHISI
// ============================================================
function createTmpDir(prefix = 'yuklaidi') {
  const dir = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir, delayMs = 300000) {
  if (pendingCleanup.has(dir)) clearTimeout(pendingCleanup.get(dir));
  const timer = setTimeout(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    pendingCleanup.delete(dir);
  }, delayMs);
  pendingCleanup.set(dir, timer);
}

// ============================================================
//  ⬇️  VIDEO/RASM YUKLOVCHI (yt-dlp)
// ============================================================
function ytDlpDownload(url, outputTemplate, extraArgs = '') {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  return new Promise((resolve, reject) => {
    // Agar extraArgs ichida '-x' bo'lsa, demak bu musiqa (audio)
    const isAudio = extraArgs.includes('-x');
    
    // Video va Audio uchun alohida formatlar
    const formatStr = isAudio 
      ? '-f "bestaudio/best"' 
      : '-f "bestvideo[ext=mp4][filesize<45M]+bestaudio[ext=m4a]/best[ext=mp4][filesize<45M]/best"';

    const cmd = `yt-dlp -o "${outputTemplate}" --no-playlist --max-filesize 49m --no-check-certificate --user-agent "${userAgent}" ${formatStr} ${extraArgs} "${url}"`;
    
    console.log('[yt-dlp] CMD:', cmd);
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[yt-dlp] ERROR:', stderr);
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function getFirstFile(dir) {
  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

// ============================================================
//  📊 METADATA OLISH (yt-dlp)
// ============================================================
function getVideoMetadata(url) {
  return new Promise((resolve) => {
    const cmd = `yt-dlp --dump-json --no-playlist --no-check-certificate "${url}"`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const data = JSON.parse(stdout);
        return resolve({
          title: data.title,
          track: data.track || null,
          artist: data.artist || data.creator || data.uploader || null,
          webpage_url: data.webpage_url
        });
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// ============================================================
//  🔍 MUSIQA QIDIRISH (YouTube ytsearch)
// ============================================================
function searchMusicYT(query, count = 5) {
  return new Promise((resolve, reject) => {
    const cmd = `yt-dlp "ytsearch${count}:${query} audio" --print "%(title)s|||%(duration_string)s|||%(webpage_url)s" --no-download --no-playlist`;
    exec(cmd, { timeout: 60000 }, (err, stdout) => {
      if (err) return resolve([]);
      const results = stdout
        .trim()
        .split('\n')
        .map(line => {
          const [title, duration, url] = line.split('|||');
          return title && url ? { title: title.trim(), duration: (duration || '?').trim(), url: url.trim() } : null;
        })
        .filter(Boolean);
      resolve(results);
    });
  });
}

// ============================================================
//  🎵 MUSIQA TANIB OLISH (AudD API)
// ============================================================
async function recognizeMusicFromFile(filePath) {
  try {
    const form = new FormData();
    form.append('api_token', AUDD_API_KEY);
    form.append('return', 'spotify,apple_music');
    form.append('file', fs.createReadStream(filePath));

    const res = await axios.post('https://api.audd.io/', form, {
      headers: form.getHeaders(),
      timeout: 45000,
    });
    if (res.data && res.data.result) return res.data.result;
    return null;
  } catch (e) {
    console.error('[AudD] Error:', e.message);
    return null;
  }
}

// Video fayldan 30 soniyalik audio kesib olish (ffmpeg orqali)
function extractAudioClip(videoPath, outPath, duration = 30) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${videoPath}" -t ${duration} -vn -ar 22050 -ac 1 -b:a 64k "${outPath}" -y -loglevel error`;
    exec(cmd, { timeout: 60000 }, (err) => {
      if (err) reject(err);
      else resolve(outPath);
    });
  });
}

// Butun videoni MP3 ga aylantirish
function extractFullAudio(videoPath, outPath) {
    return new Promise((resolve, reject) => {
      const cmd = `ffmpeg -i "${videoPath}" -vn -ab 128k -ar 44100 -y "${outPath}"`;
      exec(cmd, { timeout: 120000 }, (err) => {
        if (err) reject(err);
        else resolve(outPath);
      });
    });
  }

// ============================================================
//  🎧 AUDIO YUKLOVCHI
// ============================================================
function downloadAudioMP3(url, outputTemplate) {
  return ytDlpDownload(url, outputTemplate, '-x --audio-format mp3 --audio-quality 0');
}

// ============================================================
//  🔢 INLINE KLAVIATURA YARATUVCHILAR
// ============================================================
function makeDownloadKeyboard(chatId) {
  return {
    inline_keyboard: [
      [{ text: '🎵 Musiqasini (MP3) yuklash', callback_data: `music:extract:${chatId}` }],
      [{ text: '🔍 Musiqa tanib olish', callback_data: `music:find:${chatId}` }]
    ]
  };
}

function makeMusicResultsKeyboard(chatId, results, recognized) {
  const numButtons = results.map((_, i) => ({
    text: `${i + 1}`,
    callback_data: `music:dl:${chatId}:${i}:audio`
  }));

  const rows = [
    recognized ? [{ text: '📄 Qo\'shiq so\'zlari', callback_data: `music:lyrics:${chatId}` }] : [],
    [{ text: '🎬 Video (YouTube)', callback_data: `music:dl:${chatId}:0:video` }],
    numButtons,
  ].filter(r => r.length > 0);

  return { inline_keyboard: rows };
}

// ============================================================
//  💬 MATNLAR
// ============================================================
const TEXTS = {
  start: (name) =>
    `👋 Salom, <b>${name}</b>!\n\n` +
    `Men <b>@m27_yuklabot</b> — videolar va musiqa yuklovchi bot!\n\n` +
    `📥 <b>Nimalar yuklay olaman:</b>\n` +
    `• 📱 Instagram Reels (video)\n` +
    `• 📸 Instagram Post (rasm)\n` +
    `• 🎭 Instagram Stories\n` +
    `• 🎥 YouTube Video & Shorts\n` +
    `• 🎵 Video ichidagi musiqa\n\n` +
    `➡️ Faqat <b>link yuboring!</b>`,

  help:
    `📖 <b>Yordam</b>\n\n` +
    `1️⃣ Instagram yoki YouTube linkini yuboring\n` +
    `2️⃣ Bot videoni/rasmni yuklaydi\n` +
    `3️⃣ <b>"🎵 Qo'shiqni yuklab olish"</b> ni bosing\n` +
    `4️⃣ Bot musiqa tanib, natijalarni ko'rsatadi\n` +
    `5️⃣ Raqamni bosib yuklab oling!\n\n` +
    `⚠️ <b>Cheklovlar:</b>\n` +
    `• Maksimal fayl hajmi: 49 MB\n` +
    `• Shaxsiy (private) sahifalar yuklanmaydi`,

  unsupported:
    `❓ Noma'lum format!\n\n` +
    `Quyidagi linklar qabul qilinadi:\n` +
    `• instagram.com/reel/...\n` +
    `• instagram.com/p/...\n` +
    `• instagram.com/stories/...\n` +
    `• youtube.com/watch?v=...\n` +
    `• youtu.be/...\n` +
    `• youtube.com/shorts/...`,
};

// ============================================================
//  📩 XABAR ISHLOVCHISI
// ============================================================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  const name   = msg.from?.first_name || 'Foydalanuvchi';

  // --- Buyruqlar ---
  if (text === '/start') {
    return bot.sendMessage(chatId, TEXTS.start(name), { parse_mode: 'HTML' });
  }
  if (text === '/help') {
    return bot.sendMessage(chatId, TEXTS.help, { parse_mode: 'HTML' });
  }

  // --- URL tekshiruvi ---
  const platform = detectPlatform(text);
  const url      = extractUrl(text);

  if (!platform || !url) {
    return bot.sendMessage(chatId, TEXTS.unsupported, { parse_mode: 'HTML' });
  }

  // --- Yuklash boshlash ---
  const loadMsg = await bot.sendMessage(chatId, `⏳ <b>${platform === 'instagram' ? 'Instagram' : 'YouTube'}</b> yuklanmoqda...`, { parse_mode: 'HTML' });

  const tmpDir = createTmpDir('video');
  const outTemplate = path.join(tmpDir, 'media.%(ext)s');

  try {
    // Instagram Storiyalari va Postlar uchun qo'shimcha argumentlar
    const extraArgs = '--no-warnings --geo-bypass';
    await ytDlpDownload(url, outTemplate, extraArgs);
    const mediaFile = getFirstFile(tmpDir);

    if (!mediaFile) throw new Error('Fayl topilmadi');

    // Metama'lumotlarni olish (musiqa nomini topish uchun)
    const metadata = await getVideoMetadata(url);
    const trackInfo = metadata ? (metadata.track ? `${metadata.track} - ${metadata.artist}` : metadata.title) : null;

    const ext  = path.extname(mediaFile).toLowerCase();
    const isVideo = !['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
    const fileSize = fs.statSync(mediaFile).size;
    
    let caption = `👆 <b>@m27_yuklabot</b>`;
    if (trackInfo) {
        caption = `🎵 <b>Musiqa:</b> ${trackInfo}\n\n` + caption;
    }

    await bot.deleteMessage(chatId, loadMsg.message_id);

    let sentMsg;
    if (isVideo) {
      sentMsg = await bot.sendVideo(chatId, mediaFile, {
        caption,
        parse_mode: 'HTML',
        reply_markup: makeDownloadKeyboard(chatId),
        supports_streaming: true,
      });
    } else {
      sentMsg = await bot.sendPhoto(chatId, mediaFile, {
        caption,
        parse_mode: 'HTML',
        reply_markup: makeDownloadKeyboard(chatId),
      });
    }

    // Xolatni saqlash
    userStates.set(`${chatId}`, {
      videoPath: mediaFile,
      isVideo,
      tmpDir,
      url,
      platform,
      searchResults: null,
      recognized: null,
      trackInfo: trackInfo // Saqlab qo'yamiz
    });

    cleanupDir(tmpDir, 600_000); // 10 daqiqadan keyin o'chirish

  } catch (err) {
    console.error('[Download Error]', err.message);
    const errText =
      err.message.includes('Sign in') || err.message.includes('login')
        ? '🔒 Bu post shaxsiy yoki kirish talab etiladi!'
        : err.message.includes('filesize')
        ? '❌ Fayl juda katta (49 MB dan oshadi)!'
        : '❌ Yuklashda xatolik yuz berdi!\n\nLink to\'g\'ri va ochiq ekanligini tekshiring.';

    try {
      await bot.editMessageText(errText, { chat_id: chatId, message_id: loadMsg.message_id });
    } catch (_) {
      await bot.sendMessage(chatId, errText);
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ============================================================
//  🎛️  INLINE TUGMALAR ISHLOVCHISI
// ============================================================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;

  // ───────────────────────────────────────────────
  //  🎵 MUSIQA AJRATIB OLISH (ffmpeg orqali direkt)
  // ───────────────────────────────────────────────
  if (data.startsWith('music:extract:')) {
    await bot.answerCallbackQuery(query.id, { text: '🎵 Musiqa tayyorlanmoqda...' });

    const state = userStates.get(`${chatId}`);
    if (!state || !state.videoPath) {
      return bot.sendMessage(chatId, '❌ Fayl topilmadi yoki eskirgan. Linkni qayta yuboring.');
    }

    const loadMsg = await bot.sendMessage(chatId, '⏳ Videodan audio ajratib olinmoqda...');
    const mp3Path = path.join(state.tmpDir, 'audio.mp3');

    try {
      await extractFullAudio(state.videoPath, mp3Path);
      const stats = fs.statSync(mp3Path);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

      await bot.deleteMessage(chatId, loadMsg.message_id);
      await bot.sendAudio(chatId, mp3Path, {
        caption: `🎵 <b>Videodan olingan musiqa</b>\n📦 ${sizeMB} MB\n\n👆 @m27_yuklabot`,
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error('[Extract Error]', err);
      await bot.editMessageText('❌ Musiqa ajratishda xatolik yuz berdi.', {
        chat_id: chatId,
        message_id: loadMsg.message_id
      });
    }
  }

  // ───────────────────────────────────────────────
  //  🔍 MUSIQA TOPISH (AudD + Search)
  // ───────────────────────────────────────────────
  if (data.startsWith('music:find:')) {
    await bot.answerCallbackQuery(query.id, { text: '🎵 Musiqa qidirilmoqda...' });

    const state = userStates.get(`${chatId}`);
    if (!state) {
      return bot.sendMessage(chatId, '❌ Fayl eskirgan. Linkni qayta yuboring.');
    }

    const searchMsg = await bot.sendMessage(chatId, '🔍 Musiqa tanib olinmoqda...');

    try {
      let recognized = null;
      let searchQuery = '';

      // 1. Videoni tanib olish (ffmpeg bilan clip kesib → AudD ga yuborish)
      if (state.isVideo && AUDD_API_KEY !== 'test') {
        const clipPath = path.join(state.tmpDir, 'clip.mp3');
        try {
          await extractAudioClip(state.videoPath, clipPath, 30);
          recognized = await recognizeMusicFromFile(clipPath);
        } catch (e) {
          console.log('[Recognize] ffmpeg/AudD xato:', e.message);
        }
      }

      if (recognized) {
        searchQuery = `${recognized.artist} - ${recognized.title}`;
        state.recognized = recognized;
        await bot.editMessageText(
          `🎧 <b>${recognized.artist} — ${recognized.title}</b>\n\n🔍 O'xshash qo'shiqlar qidirlmoqda...`,
          { chat_id: chatId, message_id: searchMsg.message_id, parse_mode: 'HTML' }
        );
      } else if (state.trackInfo) {
        // Metadata orqali topilgan musiqa nomi bilan qidirish
        searchQuery = state.trackInfo;
        await bot.editMessageText(
            `🎵 <b>${searchQuery}</b> topildi. Tozalasini qidiryapman...`,
            { chat_id: chatId, message_id: searchMsg.message_id, parse_mode: 'HTML' }
          );
      } else {
        // AudD ham, Metadata ham yo'q bo'lsa
        searchQuery = state.platform === 'youtube'
          ? `site:${state.url}`
          : 'trending music mix';
        await bot.editMessageText(
          '🔍 Musiqa nomi topilmadi. O\'xshashlarini qidiryapman...',
          { chat_id: chatId, message_id: searchMsg.message_id }
        );
      }

      // 2. YouTube search
      const results = await searchMusicYT(searchQuery, 5);
      state.searchResults = results;

      if (results.length === 0) {
        return bot.editMessageText('❌ Musiqa topilmadi.',
          { chat_id: chatId, message_id: searchMsg.message_id });
      }

      // 3. Natijalarni ko'rsatish
      let txt = recognized
        ? `🎧 <b>${recognized.artist} — ${recognized.title}</b>\n\n`
        : `🎵 <b>Topilgan qo'shiqlar:</b>\n\n`;

      results.forEach((r, i) => {
        txt += `${i + 1}. <i>${r.title}</i> ${r.duration}\n`;
      });

      await bot.editMessageText(txt, {
        chat_id: chatId,
        message_id: searchMsg.message_id,
        parse_mode: 'HTML',
        reply_markup: makeMusicResultsKeyboard(chatId, results, !!recognized),
      });

    } catch (err) {
      console.error('[Music Find Error]', err);
      await bot.editMessageText('❌ Musiqa topishda xatolik!',
        { chat_id: chatId, message_id: searchMsg.message_id });
    }
  }

  // ───────────────────────────────────────────────
  //  ⬇️  MUSIQA YUKLASH (audio yoki video)
  // ───────────────────────────────────────────────
  if (data.startsWith('music:dl:')) {
    const parts   = data.split(':');
    const index   = parseInt(parts[3]);
    const dlType  = parts[4]; // 'audio' | 'video'

    const state = userStates.get(`${chatId}`);
    const results = state?.searchResults;

    if (!results || !results[index]) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Xatolik yuz berdi!' });
    }

    await bot.answerCallbackQuery(query.id, { text: `⏳ "${results[index].title}" yuklanmoqda...` });

    const dlMsg = await bot.sendMessage(chatId,
      `⏳ <b>${results[index].title}</b> yuklanmoqda...`, { parse_mode: 'HTML' });

    const tmpDir = createTmpDir('music');
    const outTemplate = path.join(tmpDir, 'music.%(ext)s');

    try {
      if (dlType === 'audio') {
        await downloadAudioMP3(results[index].url, outTemplate);
        const audioFile = getFirstFile(tmpDir);
        if (!audioFile) throw new Error('Audio fayl topilmadi');

        const sizeMB = (fs.statSync(audioFile).size / 1024 / 1024).toFixed(1);

        await bot.deleteMessage(chatId, dlMsg.message_id);
        await bot.sendAudio(chatId, audioFile, {
          caption: `🎵 <b>${results[index].title}</b>\n📦 ${sizeMB} MB\n\n👆 @m27_yuklabot`,
          parse_mode: 'HTML',
          title: results[index].title,
        });
      } else {
        // Video yuklab yuborish
        await ytDlpDownload(results[index].url, outTemplate, '-f "best[height<=480][ext=mp4]/best[height<=480]"');
        const videoFile = getFirstFile(tmpDir);
        if (!videoFile) throw new Error('Video fayl topilmadi');

        const sizeMB = (fs.statSync(videoFile).size / 1024 / 1024).toFixed(1);

        await bot.deleteMessage(chatId, dlMsg.message_id);
        await bot.sendVideo(chatId, videoFile, {
          caption: `🎬 <b>${results[index].title}</b>\n📦 ${sizeMB} MB\n\n👆 @m27_yuklabot`,
          parse_mode: 'HTML',
          supports_streaming: true,
        });
      }

      cleanupDir(tmpDir, 60_000);

    } catch (err) {
      console.error('[Audio DL Error]', err.message);
      await bot.editMessageText('❌ Yuklab bo\'lmadi. Qayta urinib ko\'ring.',
        { chat_id: chatId, message_id: dlMsg.message_id });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ───────────────────────────────────────────────
  //  📄 QOSHIQ SO'ZLARI (Lyrics)
  // ───────────────────────────────────────────────
  if (data.startsWith('music:lyrics:')) {
    const state = userStates.get(`${chatId}`);
    const rec   = state?.recognized;

    if (!rec) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Musiqa tanib olinmadi!' });
    }

    await bot.answerCallbackQuery(query.id);
    const artist  = encodeURIComponent(rec.artist || '');
    const title   = encodeURIComponent(rec.title  || '');
    const lyricsUrl = `https://genius.com/search?q=${artist}+${title}`;

    await bot.sendMessage(chatId,
      `📄 <b>${rec.artist} — ${rec.title}</b>\n\n` +
      `Qo'shiq so'zlarini ko'rish uchun:\n🔗 <a href="${lyricsUrl}">Genius.com</a>`,
      { parse_mode: 'HTML', disable_web_page_preview: false }
    );
  }
});

// ============================================================
//  🛡️  XATO ISHLOVCHISI
// ============================================================
bot.on('polling_error', (err) => console.error('[Polling Error]', err.message));
bot.on('error',         (err) => console.error('[Bot Error]',     err.message));

// ============================================================
//  🌐 HEALTH CHECK SERVER (Server o'chib qolmasligi uchun)
// ============================================================
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running 24/7! 🚀'));
app.listen(PORT, () => {
    console.log(`📡 Health Check server running on port ${PORT}`);
});

console.log('');
console.log('🤖 ═══════════════════════════════════');
console.log('   @m27_yuklabot ishga tushdi!');
console.log('═══════════════════════════════════');
console.log('');
console.log('✅ Instagram Reels/Post/Story → ✓');
console.log('✅ YouTube Video/Shorts        → ✓');
console.log('✅ Musiqa tanib olish (AudD)   → ✓');
console.log('✅ Musiqa yuklab olish          → ✓');
console.log('');
