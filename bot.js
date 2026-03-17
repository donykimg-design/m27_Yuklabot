require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const os = require('os');
const express = require('express');
const app = express();

// ============================================================
//  🔑 TOKEN VA SOZLAMALAR
// ============================================================
const TOKEN = process.env.BOT_TOKEN;
const AUDD_API_KEY = process.env.AUDD_API_KEY || 'test';

if (!TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi!');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ============================================================
//  📦 XOLAT SAQLASH
// ============================================================
const userStates = new Map();
const pendingCleanup = new Map();

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
  let url = (matchIG || matchYT || [])[0] || null;
  if (url && url.includes('instagram.com')) {
    url = url.split('?')[0]; // Trackerni tozalash
  }
  return url;
}

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
    const isAudio = extraArgs.includes('-x');
    const formatStr = isAudio 
      ? '-f "bestaudio/best"' 
      : '-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"';

    const cmd = `yt-dlp -o "${outputTemplate}" --no-playlist --max-filesize 49m --no-check-certificate --user-agent "${userAgent}" --geo-bypass --no-warnings --force-overwrites --no-part ${formatStr} ${extraArgs} "${url}"`;
    
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function getFirstFile(dir) {
  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

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
          artist: data.artist || data.creator || data.uploader || null
        });
      } catch (e) { resolve(null); }
    });
  });
}

function searchMusicYT(query, count = 5) {
  return new Promise((resolve, reject) => {
    const cmd = `yt-dlp "ytsearch${count}:${query} audio" --print "%(title)s|||%(duration_string)s|||%(webpage_url)s" --no-download --no-playlist`;
    exec(cmd, { timeout: 60000 }, (err, stdout) => {
      if (err) return resolve([]);
      const results = stdout.trim().split('\n').map(line => {
          const [title, duration, url] = line.split('|||');
          return title && url ? { title: title.trim(), duration: (duration || '?').trim(), url: url.trim() } : null;
        }).filter(Boolean);
      resolve(results);
    });
  });
}

async function recognizeMusicFromFile(filePath) {
  try {
    const form = new FormData();
    form.append('api_token', AUDD_API_KEY);
    form.append('return', 'spotify,apple_music');
    form.append('file', fs.createReadStream(filePath));
    const res = await axios.post('https://api.audd.io/', form, { headers: form.getHeaders(), timeout: 45000 });
    return res.data && res.data.result ? res.data.result : null;
  } catch (e) { return null; }
}

function extractAudioClip(videoPath, outPath, duration = 30) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${videoPath}" -t ${duration} -vn -ar 22050 -ac 1 -b:a 64k "${outPath}" -y -loglevel error`;
    exec(cmd, { timeout: 60000 }, (err) => {
      if (err) reject(err);
      else resolve(outPath);
    });
  });
}

function extractFullAudio(videoPath, outPath) {
    return new Promise((resolve, reject) => {
      const cmd = `ffmpeg -i "${videoPath}" -vn -ab 128k -ar 44100 -y "${outPath}"`;
      exec(cmd, { timeout: 120000 }, (err) => {
        if (err) reject(err);
        else resolve(outPath);
      });
    });
  }

function downloadAudioMP3(url, outputTemplate) {
  return ytDlpDownload(url, outputTemplate, '-x --audio-format mp3 --audio-quality 0');
}

// ============================================================
//  🔢 INLINE KLAVIATURA YARATUVCHILAR
// ============================================================
function makeDownloadKeyboard(chatId) {
  return {
    inline_keyboard: [
      [{ text: '🎵 Audiosini yuklash', callback_data: `music:extract:${chatId}` }],
      [{ text: '🔍 Musiqasini yuklash', callback_data: `music:find:${chatId}` }]
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
    results.length > 0 ? [{ text: '🎬 Video (YouTube)', url: results[0].url }] : [],
    numButtons,
  ].filter(r => r.length > 0);
  return { inline_keyboard: rows };
}

// ============================================================
//  💬 MATNLAR
// ============================================================
const TEXTS = {
  start: (name) => `👋 Salom, <b>${name}</b>!\nMen @m27_yuklabot — faqat link yuboring!`,
  unsupported: `❓ Noma'lum format!`,
};

// ============================================================
//  📩 XABAR ISHLOVCHISI
// ============================================================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  if (text === '/start') return bot.sendMessage(chatId, TEXTS.start(msg.from?.first_name || 'Foydalanuvchi'), { parse_mode: 'HTML' });

  const platform = detectPlatform(text);
  const url      = extractUrl(text);
  if (!platform || !url) return;

  const loadMsg = await bot.sendMessage(chatId, `⏳ Yuklanmoqda...`, { parse_mode: 'HTML' });
  const tmpDir = createTmpDir('video');
  const outTemplate = path.join(tmpDir, 'media.%(ext)s');

  try {
    await ytDlpDownload(url, outTemplate, '--no-warnings --geo-bypass');
    const mediaFile = getFirstFile(tmpDir);
    if (!mediaFile) throw new Error('Fayl topilmadi');

    const metadata = await getVideoMetadata(url);
    const trackInfo = metadata ? (metadata.track ? `${metadata.track} - ${metadata.artist}` : metadata.title) : null;

    const isVideo = !['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(path.extname(mediaFile).toLowerCase());
    const caption = `@m27_yuklabot✅`;

    await bot.deleteMessage(chatId, loadMsg.message_id);

    if (isVideo) {
      await bot.sendVideo(chatId, mediaFile, { caption, parse_mode: 'HTML', reply_markup: makeDownloadKeyboard(chatId), supports_streaming: true });
    } else {
      await bot.sendPhoto(chatId, mediaFile, { caption, parse_mode: 'HTML', reply_markup: makeDownloadKeyboard(chatId) });
    }

    userStates.set(chatId.toString(), { videoPath: mediaFile, isVideo, tmpDir, url, platform, trackInfo });
    cleanupDir(tmpDir, 600_000);
  } catch (err) {
    bot.editMessageText('❌ Xatolik!', { chat_id: chatId, message_id: loadMsg.message_id });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id.toString();
  const data   = query.data;

  if (data.startsWith('music:extract:')) {
    await bot.answerCallbackQuery(query.id, { text: '🎵 Audiodini kesib olish...' });
    const state = userStates.get(chatId);
    if (!state) return bot.sendMessage(chatId, '❌ Eskirgan.');

    const mp3Path = path.join(state.tmpDir, 'audio.mp3');
    try {
        await extractFullAudio(state.videoPath, mp3Path);
        await bot.sendAudio(chatId, mp3Path, { caption: `@m27_yuklabot✅`, parse_mode: 'HTML' });
    } catch (e) { bot.sendMessage(chatId, '❌ Xato!'); }
  }

  if (data.startsWith('music:find:')) {
    await bot.answerCallbackQuery(query.id, { text: '🔍 Qidirilmoqda...' });
    const state = userStates.get(chatId);
    if (!state) return bot.sendMessage(chatId, '❌ Eskirgan.');

    const searchMsg = await bot.sendMessage(chatId, '🔍 Qidirilmoqda...');
    try {
      let recognized = null;
      let searchQuery = state.trackInfo || 'trending music';

      if (state.isVideo && AUDD_API_KEY !== 'test' && !state.trackInfo) {
        const clipPath = path.join(state.tmpDir, 'clip.mp3');
        try {
          await extractAudioClip(state.videoPath, clipPath, 30);
          recognized = await recognizeMusicFromFile(clipPath);
          if (recognized) searchQuery = `${recognized.artist} - ${recognized.title}`;
        } catch (e) {}
      }

      const results = await searchMusicYT(searchQuery, 5);
      state.searchResults = results;

      let txt = `🎵 <b>Topilgan qo'shiqlar:</b>\n\n`;
      results.forEach((r, i) => { txt += `${i+1}. ${r.title}\n`; });
      await bot.editMessageText(txt, { chat_id: chatId, message_id: searchMsg.message_id, parse_mode: 'HTML', reply_markup: makeMusicResultsKeyboard(chatId, results, !!recognized) });
    } catch (err) { bot.editMessageText('❌ Xato!', { chat_id: chatId, message_id: searchMsg.message_id }); }
  }

  if (data.startsWith('music:dl:')) {
    const parts = data.split(':');
    const index = parseInt(parts[3]);
    const dlType = parts[4];
    const state = userStates.get(chatId);
    const results = state?.searchResults;
    if (!results || !results[index]) return;

    const dlMsg = await bot.sendMessage(chatId, `⏳ Yuklanmoqda...`);
    const tmpDir = createTmpDir('music');
    const outTemplate = path.join(tmpDir, 'music.%(ext)s');

    try {
      if (dlType === 'audio') {
        await downloadAudioMP3(results[index].url, outTemplate);
        await bot.sendAudio(chatId, getFirstFile(tmpDir), { caption: `@m27_yuklabot✅`, parse_mode: 'HTML' });
      } else {
        await ytDlpDownload(results[index].url, outTemplate, '-f "best[height<=480]"');
        await bot.sendVideo(chatId, getFirstFile(tmpDir), { caption: `@m27_yuklabot✅`, parse_mode: 'HTML' });
      }
      await bot.deleteMessage(chatId, dlMsg.message_id);
      cleanupDir(tmpDir, 60_000);
    } catch (err) { bot.sendMessage(chatId, '❌'); }
  }
});

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Server: ${PORT}`));
