// ════════════════════════════════════════════════════════════
//  ALL-IN-ONE MEDIA DOWNLOADER — Node.js + yt-dlp
//  UNLIMITED · FREE · DIRECT DOWNLOAD · ALL PLATFORMS
//
//  INSTALL:
//    npm install
//    pip install yt-dlp      (or: pip3 install yt-dlp)
//    node server.js
//
//  DEPLOY FREE: railway.app / render.com / cyclic.sh
// ════════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { exec, spawn } = require('child_process');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Detect yt-dlp binary ─────────────────────────────────
let YT_DLP = 'yt-dlp';
function detectYtDlp(cb) {
  exec('yt-dlp --version', err => {
    if (!err) { YT_DLP = 'yt-dlp'; return cb('yt-dlp'); }
    exec('python3 -m yt_dlp --version', err2 => {
      if (!err2) { YT_DLP = 'python3 -m yt_dlp'; return cb(YT_DLP); }
      exec('python -m yt_dlp --version', err3 => {
        if (!err3) { YT_DLP = 'python -m yt_dlp'; return cb(YT_DLP); }
        cb(null);
      });
    });
  });
}

// ── Simple HTTPS fetch ────────────────────────────────────
function fetchJSON(urlStr, hdrs = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...hdrs },
      timeout:  15000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ════════════════════════════════════════════════════════════
//  yt-dlp: Get JSON info for any URL
//  Supports: TikTok, YouTube, Instagram, Twitter, Facebook,
//  Reddit, Vimeo, SoundCloud, Twitch, Dailymotion + 1000 more
// ════════════════════════════════════════════════════════════
function ytDlpInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-check-certificates',
      '--no-warnings',
      '--socket-timeout', '30',
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      url
    ];
    const cmdParts = YT_DLP.split(' ');
    const proc = spawn(cmdParts[0], [...cmdParts.slice(1), ...args], { timeout: 60000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.slice(0, 300) || `Exit ${code}`));
      try { resolve(JSON.parse(stdout)); }
      catch(e) { reject(new Error('JSON parse error')); }
    });
    proc.on('error', reject);
  });
}

// ── Build clean format list from yt-dlp output ───────────
function buildFormats(info, mode) {
  const fmts = info.formats || [];
  const out  = [];
  const seen = new Set();

  if (mode === 'audio') {
    const audioFmts = fmts
      .filter(f => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a,b) => (b.abr||b.tbr||0) - (a.abr||a.tbr||0));
    audioFmts.slice(0, 4).forEach(f => {
      const ext = f.ext || 'mp3';
      const abr = Math.round(f.abr || f.tbr || 128);
      const key = `${ext}${abr}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ quality:`${abr}k`, label:`${ext.toUpperCase()} ${abr}kbps`, url:f.url, type:'audio', ext, size:f.filesize||0 });
    });
    if (!out.length && fmts[0]?.url) {
      out.push({ quality:'Best', label:'Best Audio', url:fmts[0].url, type:'audio', ext:fmts[0].ext||'mp3', size:0 });
    }
    return out;
  }

  // Video formats by resolution
  const videoFmts = fmts
    .filter(f => f.url && f.vcodec && f.vcodec !== 'none' && f.height)
    .sort((a,b) => (b.height||0) - (a.height||0));

  [2160,1440,1080,720,480,360,240].forEach(res => {
    const f = videoFmts.find(f => f.height === res);
    if (f && !seen.has(res)) {
      seen.add(res);
      const label = res >= 1080 ? `${res}p Full HD` : res >= 720 ? `${res}p HD` : `${res}p SD`;
      out.push({ quality:`${res}p`, label, url:f.url, type:'video', ext:f.ext||'mp4', size:f.filesize||f.filesize_approx||0, fps:f.fps||0 });
    }
  });

  if (!out.length) {
    videoFmts.slice(0,5).forEach((f,i) => {
      if (seen.has(f.format_id)) return;
      seen.add(f.format_id);
      out.push({ quality:f.format_note||`Option ${i+1}`, label:f.format_note||`Video ${i+1}`, url:f.url, type:'video', ext:f.ext||'mp4', size:f.filesize||0 });
    });
  }

  if (!out.length && info.url) {
    out.push({ quality:'Best', label:'Best Quality', url:info.url, type:'video', ext:info.ext||'mp4', size:0 });
  }

  // Add best audio-only option
  const bestAudio = fmts.find(f => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  if (bestAudio) {
    out.push({ quality:'Audio Only', label:'Audio Only (MP3)', url:bestAudio.url, type:'audio', ext:bestAudio.ext||'mp3', size:bestAudio.filesize||0 });
  }

  return out;
}

// ── TikTok fallback via tikwm.com ────────────────────────
async function tikWmFallback(url) {
  const d = await fetchJSON(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
  if (!d || d.code !== 0 || !d.data) throw new Error('TikWM error');
  const t = d.data;
  const formats = [];
  if (t.hdplay) formats.push({ quality:'HD',    label:'HD (No Watermark)',    url:t.hdplay, type:'video', ext:'mp4', size:t.hd_size||0 });
  if (t.play)   formats.push({ quality:'SD',    label:'SD (No Watermark)',    url:t.play,   type:'video', ext:'mp4', size:t.size||0 });
  if (t.wmplay) formats.push({ quality:'WM',    label:'Original (Watermark)', url:t.wmplay, type:'video', ext:'mp4', size:t.wm_size||0 });
  if (t.music)  formats.push({ quality:'Audio', label:'Audio Only (MP3)',     url:t.music,  type:'audio', ext:'mp3', size:0 });
  return {
    platform:'tiktok', title:t.title||'TikTok Video', thumbnail:t.cover||'',
    author:t.author?.nickname||'', duration:t.duration||0,
    views:t.play_count||0, likes:t.digg_count||0, formats, images:t.images||[]
  };
}

// ════════════════════════════════════════════════════════════
//  API ENDPOINT: POST /api/download
// ════════════════════════════════════════════════════════════
app.post('/api/download', async (req, res) => {
  const { url, type = 'video' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const isTikTok = /tiktok\.com|vm\.tiktok|vt\.tiktok|douyin\.com/i.test(url);
  let platform   = 'unknown';
  if (isTikTok)                                              platform = 'tiktok';
  else if (/instagram\.com/i.test(url))                     platform = 'instagram';
  else if (/youtube\.com|youtu\.be/i.test(url))             platform = 'youtube';
  else if (/twitter\.com|x\.com/i.test(url))                platform = 'twitter';
  else if (/facebook\.com|fb\.com|fb\.watch/i.test(url))    platform = 'facebook';
  else if (/reddit\.com|redd\.it/i.test(url))               platform = 'reddit';
  else if (/soundcloud\.com/i.test(url))                    platform = 'soundcloud';
  else if (/vimeo\.com/i.test(url))                         platform = 'vimeo';
  else if (/pinterest\.com|pin\.it/i.test(url))             platform = 'pinterest';
  else if (/twitch\.tv|clips\.twitch/i.test(url))           platform = 'twitch';
  else if (/dailymotion\.com/i.test(url))                   platform = 'dailymotion';

  console.log(`[${new Date().toISOString()}] ${platform.toUpperCase()} - ${url.slice(0,80)}`);

  // ── Try yt-dlp first ────────────────────────────────────
  try {
    const info    = await ytDlpInfo(url);
    const formats = buildFormats(info, type);
    return res.json({
      success:   true, platform,
      title:     info.title || info.fulltitle || 'Video',
      thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || '',
      author:    info.uploader || info.channel || info.creator || '',
      duration:  info.duration || 0,
      views:     info.view_count || 0,
      likes:     info.like_count || 0,
      formats,
      images:    [],
    });
  } catch (ytErr) {
    console.log(`  yt-dlp error: ${ytErr.message.slice(0,100)}`);

    // ── TikTok fallback ──────────────────────────────────
    if (isTikTok) {
      try {
        const data = await tikWmFallback(url);
        return res.json({ success: true, ...data });
      } catch (tkErr) {
        console.log(`  tikwm error: ${tkErr.message}`);
      }
    }

    return res.status(500).json({
      success: false,
      error:   'Could not fetch download links',
      detail:  ytErr.message.slice(0, 200),
      fix:     'Run: pip install -U yt-dlp'
    });
  }
});

// ════════════════════════════════════════════════════════════
//  STREAM PROXY: GET /api/stream?url=...&filename=...
//  Pipes any CDN file through Node.js — avoids all CORS
// ════════════════════════════════════════════════════════════
app.get('/api/stream', (req, res) => {
  const { url, filename, ref } = req.query;
  if (!url) return res.status(400).send('URL required');

  try {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    ref || `${parsed.protocol}//${parsed.hostname}/`,
        'Accept':     '*/*',
        'Accept-Encoding': 'identity',
        ...(req.headers.range ? { 'Range': req.headers.range } : {}),
      },
      timeout: 30000,
    };

    const proxyReq = lib.request(reqOpts, upstream => {
      const ct  = upstream.headers['content-type'] || 'application/octet-stream';
      let ext   = 'mp4';
      if (ct.includes('audio/mpeg'))  ext = 'mp3';
      else if (ct.includes('audio/')) ext = 'mp3';
      else if (ct.includes('webm'))   ext = 'webm';
      else if (ct.includes('jpeg'))   ext = 'jpg';
      else if (ct.includes('png'))    ext = 'png';

      const fname = filename || `download.${ext}`;
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      if (upstream.headers['content-range'])  res.setHeader('Content-Range',  upstream.headers['content-range']);
      if (upstream.headers['accept-ranges'])  res.setHeader('Accept-Ranges',  upstream.headers['accept-ranges']);
      res.status(upstream.statusCode || 200);
      upstream.pipe(res);
    });

    proxyReq.on('error', e => { if (!res.headersSent) res.status(502).send(e.message); });
    proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).send('Timeout'); });
    proxyReq.end();

  } catch(e) {
    res.status(400).send('Invalid URL');
  }
});

// ── Health check ─────────────────────────────────────────
app.get('/health', (req, res) => {
  detectYtDlp(cmd => res.json({ ok: true, ytDlp: cmd || 'NOT INSTALLED — run: pip install yt-dlp' }));
});

// ── Start ────────────────────────────────────────────────
detectYtDlp(cmd => {
  if (cmd) console.log(`\n✅ yt-dlp found: ${cmd}`);
  else     console.warn(`\n⚠️  yt-dlp NOT found!\n   Install: pip install yt-dlp\n   or:      pip3 install yt-dlp\n`);
  app.listen(PORT, () => {
    console.log(`\n🚀 Server ready: http://localhost:${PORT}`);
    console.log(`   Health:       http://localhost:${PORT}/health\n`);
  });
});
