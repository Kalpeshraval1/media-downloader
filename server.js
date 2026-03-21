// ════════════════════════════════════════════════════════════
//  ALL-IN-ONE MEDIA DOWNLOADER — Production Server
//  Optimized for high traffic — CDN-direct downloads
//  No file buffering in RAM — instant redirect to CDN
// ════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { exec, spawn } = require('child_process');
const https    = require('https');
const http     = require('http');
const { URL }  = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── In-memory cache: url → {data, ts} ────────────────────
// Avoids re-calling yt-dlp for same URL within 8 minutes
const CACHE     = new Map();
const CACHE_TTL = 8 * 60 * 1000; // 8 min (CDN URLs expire)
const MAX_CACHE = 5000;           // max entries to avoid mem leak

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { CACHE.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) {
  if (CACHE.size >= MAX_CACHE) {
    // Evict oldest 500 entries
    const keys = [...CACHE.keys()].slice(0, 500);
    keys.forEach(k => CACHE.delete(k));
  }
  CACHE.set(key, { data, ts: Date.now() });
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',        // Cache static files for 1 day
  etag: true,
}));

// ── Detect yt-dlp ─────────────────────────────────────────
let YT_DLP = 'yt-dlp';
function detectYtDlp(cb) {
  exec('yt-dlp --version', err => {
    if (!err) { YT_DLP = 'yt-dlp'; return cb('yt-dlp'); }
    exec('python3 -m yt_dlp --version', err2 => {
      if (!err2) { YT_DLP = 'python3 -m yt_dlp'; return cb(YT_DLP); }
      exec('python -m yt_dlp --version', err3 => {
        YT_DLP = err3 ? 'yt-dlp' : 'python -m yt_dlp';
        cb(err3 ? null : YT_DLP);
      });
    });
  });
}

// ── fetchJSON ──────────────────────────────────────────────
function fetchJSON(urlStr, hdrs = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    lib.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...hdrs },
      timeout:  15000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject).on('timeout', function(){ this.destroy(); reject(new Error('Timeout')); }).end();
  });
}

// ── yt-dlp info ────────────────────────────────────────────
function ytDlpInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json', '--no-playlist',
      '--no-check-certificates', '--no-warnings',
      '--socket-timeout', '30',
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      url
    ];
    const parts = YT_DLP.split(' ');
    const proc  = spawn(parts[0], [...parts.slice(1), ...args], { timeout: 60000 });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.slice(0, 300) || `Exit ${code}`));
      try { resolve(JSON.parse(out)); } catch(e) { reject(new Error('JSON parse error')); }
    });
    proc.on('error', reject);
  });
}

// ── Build formats — separate muxed vs DASH ─────────────────
function buildFormats(info, mode) {
  const fmts = info.formats || [];
  const out  = [];
  const seen = new Set();

  // Best audio stream for DASH pairing
  const bestAudio = fmts
    .filter(f => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a,b) => (b.abr||b.tbr||0) - (a.abr||a.tbr||0))[0];

  if (mode === 'audio') {
    fmts
      .filter(f => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a,b) => (b.abr||b.tbr||0) - (a.abr||a.tbr||0))
      .slice(0, 5)
      .forEach(f => {
        const ext = f.ext || 'mp3';
        const abr = Math.round(f.abr || f.tbr || 128);
        const key = `${ext}${abr}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ quality:`${abr}k`, label:`${ext.toUpperCase()} ${abr}kbps`, url:f.url, type:'audio', ext, size:f.filesize||0 });
      });
    if (!out.length && fmts[0]?.url)
      out.push({ quality:'Best', label:'Best Audio', url:fmts[0].url, type:'audio', ext:fmts[0].ext||'mp3', size:0 });
    return out;
  }

  // Prefer muxed (video+audio in one stream) — works without DASH tricks
  const muxed = fmts
    .filter(f => f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.height)
    .sort((a,b) => (b.height||0) - (a.height||0));

  // DASH video-only (YouTube high quality — needs audio paired)
  const dash = fmts
    .filter(f => f.url && f.vcodec && f.vcodec !== 'none' && f.height && (!f.acodec || f.acodec === 'none'))
    .sort((a,b) => (b.height||0) - (a.height||0));

  [2160,1440,1080,720,480,360,240].forEach(res => {
    if (seen.has(res)) return;
    const m = muxed.find(f => f.height === res);
    if (m) {
      seen.add(res);
      const lbl = res>=1080?`${res}p Full HD`:res>=720?`${res}p HD`:`${res}p SD`;
      out.push({ quality:`${res}p`, label:lbl, url:m.url, type:'video', ext:m.ext||'mp4',
        size:m.filesize||m.filesize_approx||0, fps:m.fps||0, hasMuxedAudio:true, audioUrl:'' });
      return;
    }
    const d = dash.find(f => f.height === res);
    if (d) {
      seen.add(res);
      const lbl = res>=1080?`${res}p Full HD`:res>=720?`${res}p HD`:`${res}p SD`;
      out.push({ quality:`${res}p`, label:lbl, url:d.url, type:'video', ext:d.ext||'mp4',
        size:d.filesize||d.filesize_approx||0, fps:d.fps||0, hasMuxedAudio:false,
        audioUrl:bestAudio?.url||'' });
    }
  });

  if (!out.length) {
    [...muxed,...dash].slice(0,5).forEach((f,i) => {
      if (seen.has(f.format_id)) return;
      seen.add(f.format_id);
      const has = !!(f.acodec && f.acodec !== 'none');
      out.push({ quality:f.format_note||`Option ${i+1}`, label:f.format_note||`Video ${i+1}`,
        url:f.url, type:'video', ext:f.ext||'mp4', size:f.filesize||0,
        hasMuxedAudio:has, audioUrl:has?'':(bestAudio?.url||'') });
    });
  }
  if (!out.length && info.url)
    out.push({ quality:'Best', label:'Best Quality', url:info.url, type:'video', ext:info.ext||'mp4', size:0, hasMuxedAudio:true, audioUrl:'' });

  if (bestAudio)
    out.push({ quality:'Audio Only', label:'Audio Only', url:bestAudio.url, type:'audio', ext:bestAudio.ext||'mp3', size:bestAudio.filesize||0 });

  return out;
}

// ── TikTok fallback ────────────────────────────────────────
async function tikWmFallback(url) {
  const d = await fetchJSON(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
  if (!d || d.code !== 0 || !d.data) throw new Error('TikWM error');
  const t = d.data;
  const formats = [];
  if (t.hdplay) formats.push({ quality:'HD',    label:'HD No Watermark',    url:t.hdplay, type:'video', ext:'mp4', size:t.hd_size||0, hasMuxedAudio:true, audioUrl:'' });
  if (t.play)   formats.push({ quality:'SD',    label:'SD No Watermark',    url:t.play,   type:'video', ext:'mp4', size:t.size||0,    hasMuxedAudio:true, audioUrl:'' });
  if (t.wmplay) formats.push({ quality:'WM',    label:'With Watermark',     url:t.wmplay, type:'video', ext:'mp4', size:t.wm_size||0, hasMuxedAudio:true, audioUrl:'' });
  if (t.music)  formats.push({ quality:'Audio', label:'Audio Only (MP3)',   url:t.music,  type:'audio', ext:'mp3', size:0 });
  return { platform:'tiktok', title:t.title||'TikTok Video', thumbnail:t.cover||'',
    author:t.author?.nickname||'', duration:t.duration||0,
    views:t.play_count||0, likes:t.digg_count||0, formats, images:t.images||[] };
}

// ════════════════════════════════════════════════════════════
//  POST /api/download  — Main endpoint (cached)
// ════════════════════════════════════════════════════════════
app.post('/api/download', async (req, res) => {
  const { url, type = 'video' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  // Cache key
  const cKey = `${url}::${type}`;
  const cached = cacheGet(cKey);
  if (cached) {
    console.log(`[CACHE HIT] ${url.slice(0,60)}`);
    return res.json(cached);
  }

  let platform = 'unknown';
  const isTikTok    = /tiktok\.com|vm\.tiktok|vt\.tiktok|douyin\.com/i.test(url);
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

  console.log(`[${new Date().toISOString()}] ${platform.toUpperCase()} ${url.slice(0,70)}`);

  try {
    const info    = await ytDlpInfo(url);
    const formats = buildFormats(info, type);

    // Extract images (carousels, slideshows)
    let images = [];
    if (type === 'image') {
      const thumbs = (info.thumbnails||[]).map(t=>t.url).filter(Boolean);
      images = thumbs.length > 1 ? thumbs : (info.thumbnail ? [info.thumbnail] : []);
    }
    if (info.entries) {
      images = info.entries.map(e=>e.url||e.thumbnail||'').filter(Boolean);
    }

    const result = { success:true, platform,
      title:     info.title||info.fulltitle||'Video',
      thumbnail: info.thumbnail||info.thumbnails?.[0]?.url||'',
      author:    info.uploader||info.channel||info.creator||'',
      duration:  info.duration||0, views:info.view_count||0, likes:info.like_count||0,
      formats, images };

    cacheSet(cKey, result);
    return res.json(result);

  } catch (ytErr) {
    console.log(`  yt-dlp error: ${ytErr.message.slice(0,100)}`);
    if (isTikTok) {
      try {
        const data = await tikWmFallback(url);
        const result = { success:true, ...data };
        cacheSet(cKey, result);
        return res.json(result);
      } catch(e) { console.log(`  tikwm error: ${e.message}`); }
    }
    return res.status(500).json({ success:false, error:'Could not fetch download links',
      detail:ytErr.message.slice(0,200), fix:'Run: pip install -U yt-dlp' });
  }
});

// ════════════════════════════════════════════════════════════
//  GET /api/stream  — Lightweight RANGE-AWARE proxy
//  Only used for preview playback — downloads go direct to CDN
// ════════════════════════════════════════════════════════════
app.get('/api/stream', (req, res) => {
  const { url, filename, ref } = req.query;
  if (!url) return res.status(400).send('URL required');
  try {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':         ref || `${parsed.protocol}//${parsed.hostname}/`,
        'Accept':          '*/*',
        'Accept-Encoding': 'identity',
        ...(req.headers.range ? { 'Range': req.headers.range } : {}),
      },
      timeout: 30000,
    };
    const proxy = lib.request(opts, upstream => {
      const ct  = upstream.headers['content-type'] || 'application/octet-stream';
      let ext = 'mp4';
      if (ct.includes('audio')) ext = 'mp3';
      else if (ct.includes('webm')) ext = 'webm';
      else if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
      else if (ct.includes('png')) ext = 'png';

      // For preview (no filename param) — stream inline, no download header
      if (filename) {
        res.setHeader('Content-Disposition', `attachment; filename="${filename||'download.'+ext}"`);
      } else {
        res.setHeader('Content-Disposition', 'inline');
      }
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      // Pass through range headers for smooth seeking
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      if (upstream.headers['content-range'])  res.setHeader('Content-Range',  upstream.headers['content-range']);
      if (upstream.headers['accept-ranges'])  res.setHeader('Accept-Ranges',  'bytes');
      res.status(upstream.statusCode || 200);
      upstream.pipe(res);
    });
    proxy.on('error', e => { if (!res.headersSent) res.status(502).send(e.message); });
    proxy.on('timeout', () => { proxy.destroy(); if (!res.headersSent) res.status(504).send('Timeout'); });
    proxy.end();
  } catch(e) { res.status(400).send('Invalid URL'); }
});

// ── GET /api/resolve — returns signed CDN URL for direct download
// Client downloads directly from CDN — zero server bandwidth used
app.get('/api/resolve', (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  // Return the URL + proper filename so client can do window.open() direct download
  res.json({ url, filename: filename || 'download' });
});

// ── Health ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  detectYtDlp(cmd => res.json({
    ok: true, ytDlp: cmd || 'NOT INSTALLED',
    cacheSize: CACHE.size,
    uptime: Math.floor(process.uptime()) + 's',
    memory: Math.round(process.memoryUsage().heapUsed/1024/1024) + 'MB'
  }));
});

// ── Start ──────────────────────────────────────────────────
detectYtDlp(cmd => {
  if (cmd) console.log(`\n✅ yt-dlp: ${cmd}`);
  else     console.warn(`\n⚠️  yt-dlp NOT found! Install: pip install yt-dlp\n`);
  app.listen(PORT, () => {
    console.log(`\n🚀 Server: http://localhost:${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/health\n`);
  });
});
