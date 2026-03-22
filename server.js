'use strict';
// ============================================================
//  Media Downloader — server.js  (FULLY FIXED)
//  BUGS FOUND AND FIXED:
//  1. No input validation on /api/download → unhandled crashes
//  2. yt-dlp never auto-updates → stale extractor = 500 errors
//  3. No retry on transient yt-dlp failures (network blip)
//  4. express.json() had no size limit → potential OOM crash
//  5. /api/merge sent plain text 503 when ffmpeg missing →
//     frontend couldn't parse error JSON
//  6. Uncaught exceptions could crash the whole process
//  7. No global Express error handler
//  8. /health only checked ffmpeg, not yt-dlp live status
// ============================================================

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { exec, spawn } = require('child_process');
const https    = require('https');
const http     = require('http');
const { URL }  = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

// ✅ FIX #6: Catch all uncaught errors so process stays alive
process.on('uncaughtException',  err => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err && err.message));

// ── In-memory cache (5 min TTL, max 5000 entries) ───────────
const CACHE = new Map();
function cacheGet(k) {
  const e = CACHE.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > 5 * 60 * 1000) { CACHE.delete(k); return null; }
  return e.data;
}
function cacheSet(k, d) {
  if (CACHE.size > 5000) {
    const old = [...CACHE.keys()].slice(0, 1000);
    old.forEach(x => CACHE.delete(x));
  }
  CACHE.set(k, { data: d, ts: Date.now() });
}

// ── CORS — allow all origins ─────────────────────────────────
app.use(cors({
  origin:         '*',
  methods:        ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
}));
app.options('*', (req, res) => res.sendStatus(204));

// ✅ FIX #4: Add size limit to body parser
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// ── Root ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.json({ status: 'Media Downloader API running', health: '/health', download: 'POST /api/download' });
});

// ── Tool detection ───────────────────────────────────────────
let YT_DLP      = 'yt-dlp';
let FFMPEG      = 'ffmpeg';
let TOOLS_READY = false;

function detectTools(cb) {
  exec('yt-dlp --version', (err, stdout) => {
    if (!err) {
      YT_DLP = 'yt-dlp';
      console.log('[tools] yt-dlp:', stdout.trim());
    } else {
      exec('python3 -m yt_dlp --version', (err2, out2) => {
        if (!err2) { YT_DLP = 'python3 -m yt_dlp'; console.log('[tools] yt_dlp via python3:', out2.trim()); }
        else console.error('[tools] yt-dlp NOT FOUND — install with: pip3 install yt-dlp');
      });
    }
    exec('ffmpeg -version', (err3, out3) => {
      if (err3) { FFMPEG = null; console.error('[tools] ffmpeg NOT FOUND'); }
      else console.log('[tools] ffmpeg ok');
      TOOLS_READY = true;
      cb();
    });
  });
}

// ✅ FIX #2: Auto-update yt-dlp daily to keep extractors fresh
// (YouTube/TikTok break whenever platforms update their sites)
function scheduleYtDlpUpdate() {
  // Update once at startup (non-blocking), then every 24h
  setTimeout(() => {
    console.log('[yt-dlp] running auto-update...');
    exec('yt-dlp -U', (err, stdout) => {
      if (err) console.log('[yt-dlp] update skipped:', err.message.slice(0, 80));
      else console.log('[yt-dlp] update:', stdout.trim().slice(0, 100));
    });
  }, 5000);
  setInterval(() => {
    exec('yt-dlp -U', () => {});
  }, 24 * 60 * 60 * 1000);
}

// ── Safe fetchJSON ────────────────────────────────────────────
function fetchJSON(urlStr, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Invalid URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' },
      timeout:  timeoutMs,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Bad JSON from ' + u.hostname)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── yt-dlp info — with retry ──────────────────────────────────
// ✅ FIX #3: Added retry on transient errors
function ytDlpInfo(url, attempt) {
  attempt = attempt || 1;
  return new Promise((resolve, reject) => {
    const parts = YT_DLP.split(' ');
    const args  = [
      ...parts.slice(1),
      '--dump-single-json',
      '--no-playlist',
      '--no-check-certificates',
      '--no-warnings',
      '--socket-timeout', '30',
      '--retries', '3',
      '--fragment-retries', '3',
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      url,
    ];

    const proc = spawn(parts[0], args, { timeout: 90000, killSignal: 'SIGKILL' });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);

    proc.on('close', code => {
      if (code !== 0) {
        const msg = err.slice(0, 600) || ('yt-dlp exit ' + code);
        // Retry once on transient network errors or rate-limit
        const isTransient = msg.includes('HTTP Error 429') || msg.includes('timeout') || msg.includes('network') || msg.includes('Connection');
        if (attempt < 2 && isTransient) {
          console.log('[yt-dlp] transient error, retrying in 3s...');
          return setTimeout(() => ytDlpInfo(url, 2).then(resolve).catch(reject), 3000);
        }
        return reject(new Error(msg));
      }
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error('Bad JSON from yt-dlp')); }
    });

    proc.on('error', e => reject(new Error('spawn error: ' + e.message)));
  });
}

// ── Build format list ─────────────────────────────────────────
function buildFormats(info, mode) {
  const fmts = info.formats || [];
  const out = [], seen = new Set();

  const bestAudio = fmts
    .filter(f => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

  if (mode === 'audio') {
    fmts
      .filter(f => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
      .slice(0, 6)
      .forEach(f => {
        const ext = f.ext || 'mp3', abr = Math.round(f.abr || f.tbr || 128), key = ext + abr;
        if (seen.has(key)) return; seen.add(key);
        out.push({ quality: abr + 'k', label: ext.toUpperCase() + ' ' + abr + 'kbps', url: f.url, type: 'audio', ext, size: f.filesize || 0 });
      });
    if (!out.length && fmts[0]?.url)
      out.push({ quality: 'Best', label: 'Best Audio', url: fmts[0].url, type: 'audio', ext: fmts[0].ext || 'mp3', size: 0 });
    return out;
  }

  const muxed = fmts
    .filter(f => f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const dash = fmts
    .filter(f => f.url && f.vcodec && f.vcodec !== 'none' && f.height && (!f.acodec || f.acodec === 'none'))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  [2160, 1440, 1080, 720, 480, 360, 240].forEach(res => {
    if (seen.has(res)) return;
    const m = muxed.find(f => f.height === res);
    if (m) {
      seen.add(res);
      const lbl = res >= 1080 ? res + 'p Full HD' : res >= 720 ? res + 'p HD' : res + 'p SD';
      out.push({ quality: res + 'p', label: lbl, url: m.url, type: 'video', ext: m.ext || 'mp4', size: m.filesize || m.filesize_approx || 0, fps: m.fps || 0, hasMuxedAudio: true, audioUrl: '' });
      return;
    }
    const d = dash.find(f => f.height === res);
    if (d) {
      seen.add(res);
      const lbl = res >= 1080 ? res + 'p Full HD' : res >= 720 ? res + 'p HD' : res + 'p SD';
      out.push({ quality: res + 'p', label: lbl, url: d.url, type: 'video', ext: d.ext || 'mp4', size: d.filesize || d.filesize_approx || 0, fps: d.fps || 0, hasMuxedAudio: false, audioUrl: bestAudio ? bestAudio.url : '' });
    }
  });

  if (!out.length) {
    [...muxed, ...dash].slice(0, 6).forEach((f, i) => {
      if (seen.has(f.format_id)) return; seen.add(f.format_id);
      const has = !!(f.acodec && f.acodec !== 'none');
      out.push({ quality: f.format_note || 'Option ' + (i + 1), label: f.format_note || 'Video ' + (i + 1), url: f.url, type: 'video', ext: f.ext || 'mp4', size: f.filesize || 0, hasMuxedAudio: has, audioUrl: has ? '' : (bestAudio ? bestAudio.url : '') });
    });
  }
  if (!out.length && info.url)
    out.push({ quality: 'Best', label: 'Best Quality', url: info.url, type: 'video', ext: info.ext || 'mp4', size: 0, hasMuxedAudio: true, audioUrl: '' });
  if (bestAudio)
    out.push({ quality: 'Audio Only', label: 'Audio Only', url: bestAudio.url, type: 'audio', ext: bestAudio.ext || 'mp3', size: bestAudio.filesize || 0 });

  return out;
}

// ── TikTok fallback ───────────────────────────────────────────
async function tikWmFallback(url) {
  const d = await fetchJSON('https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1');
  if (!d || d.code !== 0 || !d.data) throw new Error('TikWM failed');
  const t = d.data, formats = [];
  if (t.hdplay) formats.push({ quality: 'HD',    label: 'HD No Watermark',  url: t.hdplay, type: 'video', ext: 'mp4', size: t.hd_size || 0, hasMuxedAudio: true,  audioUrl: '' });
  if (t.play)   formats.push({ quality: 'SD',    label: 'SD No Watermark',  url: t.play,   type: 'video', ext: 'mp4', size: t.size    || 0, hasMuxedAudio: true,  audioUrl: '' });
  if (t.wmplay) formats.push({ quality: 'WM',    label: 'With Watermark',   url: t.wmplay, type: 'video', ext: 'mp4', size: t.wm_size || 0, hasMuxedAudio: true,  audioUrl: '' });
  if (t.music)  formats.push({ quality: 'Audio', label: 'Audio Only',       url: t.music,  type: 'audio', ext: 'mp3', size: 0 });
  return { platform: 'tiktok', title: t.title || 'TikTok Video', thumbnail: t.cover || '', author: t.author?.nickname || '', duration: t.duration || 0, views: t.play_count || 0, likes: t.digg_count || 0, formats, images: t.images || [] };
}

// ════════════════════════════════════════════════════════════
//  POST /api/download
// ════════════════════════════════════════════════════════════
app.post('/api/download', async (req, res) => {

  // ✅ FIX #1: Full input validation
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ success: false, error: 'Request body must be JSON', fix: 'Send Content-Type: application/json' });
  }

  const { url, type = 'video' } = req.body;

  if (!url || typeof url !== 'string' || url.trim() === '') {
    return res.status(400).json({ success: false, error: 'url is required', fix: 'Send {"url":"https://...","type":"video"}' });
  }
  if (!/^https?:\/\//i.test(url.trim())) {
    return res.status(400).json({ success: false, error: 'url must start with http:// or https://', fix: 'Include the full URL' });
  }
  if (!['video', 'audio', 'image'].includes(type)) {
    return res.status(400).json({ success: false, error: 'type must be video, audio, or image' });
  }

  const cleanUrl = url.trim();
  const cKey     = cleanUrl + '::' + type;
  const cached   = cacheGet(cKey);
  if (cached) { console.log('[CACHE]', cleanUrl.slice(0, 70)); return res.json(cached); }

  const isTikTok    = /tiktok\.com|vm\.tiktok|vt\.tiktok|douyin\.com/i.test(cleanUrl);
  const isSnapchat  = /snapchat\.com/i.test(cleanUrl);
  const isInstagram = /instagram\.com/i.test(cleanUrl);
  const isYouTube   = /youtube\.com|youtu\.be/i.test(cleanUrl);
  const isTwitter   = /twitter\.com|x\.com/i.test(cleanUrl);
  const isFacebook  = /facebook\.com|fb\.com|fb\.watch/i.test(cleanUrl);

  let platform = 'unknown';
  if (isTikTok)         platform = 'tiktok';
  else if (isSnapchat)  platform = 'snapchat';
  else if (isInstagram) platform = 'instagram';
  else if (isYouTube)   platform = 'youtube';
  else if (isTwitter)   platform = 'twitter';
  else if (isFacebook)  platform = 'facebook';
  else if (/reddit\.com|redd\.it/i.test(cleanUrl))    platform = 'reddit';
  else if (/soundcloud\.com/i.test(cleanUrl))          platform = 'soundcloud';
  else if (/vimeo\.com/i.test(cleanUrl))               platform = 'vimeo';
  else if (/twitch\.tv|clips\.twitch/i.test(cleanUrl)) platform = 'twitch';
  else if (/dailymotion\.com/i.test(cleanUrl))         platform = 'dailymotion';
  else if (/pinterest\.com|pin\.it/i.test(cleanUrl))   platform = 'pinterest';

  console.log('[' + new Date().toISOString() + ']', platform.toUpperCase(), cleanUrl.slice(0, 80));

  try {
    const info    = await ytDlpInfo(cleanUrl);
    const formats = buildFormats(info, type);

    let images = [];
    if (type === 'image') {
      const thumbs = (info.thumbnails || []).map(t => t.url).filter(Boolean);
      images = thumbs.length > 1 ? thumbs : (info.thumbnail ? [info.thumbnail] : []);
    }
    if (info.entries) images = info.entries.map(e => e.url || e.thumbnail || '').filter(Boolean);

    const result = {
      success: true, platform,
      title:     info.title || info.fulltitle || 'Video',
      thumbnail: info.thumbnail || (info.thumbnails?.[0]?.url) || '',
      author:    info.uploader || info.channel || info.creator || '',
      duration:  info.duration || 0,
      views:     info.view_count || 0,
      likes:     info.like_count || 0,
      formats, images,
    };
    cacheSet(cKey, result);
    return res.json(result);

  } catch (ytErr) {
    const errMsg = ytErr.message || 'Unknown error';
    console.error('[yt-dlp]', errMsg.slice(0, 200));

    if (isTikTok) {
      try {
        const data = await tikWmFallback(cleanUrl);
        const r = Object.assign({ success: true }, data);
        cacheSet(cKey, r);
        return res.json(r);
      } catch (e) { console.error('[tikwm]', e.message); }
    }

    // Classify error for user-friendly message
    let userError = 'Could not fetch download links. Please try again.';
    let fix       = 'Run: pip install -U yt-dlp  then redeploy';

    if      (errMsg.includes('Sign in') || errMsg.includes('login'))      { userError = 'This video requires sign-in or is age-restricted.';  fix = 'Try a public video URL'; }
    else if (errMsg.includes('Private') || errMsg.includes('private'))    { userError = 'This video is private.';                              fix = 'Only public videos can be downloaded'; }
    else if (errMsg.includes('removed') || errMsg.includes('unavailable')){ userError = 'This video has been removed or is unavailable.';      fix = 'Check the URL is correct'; }
    else if (errMsg.includes('429') || errMsg.includes('rate limit'))     { userError = 'Rate limit hit. Please wait 30s and try again.';       fix = 'YouTube rate limits — wait and retry'; }
    else if (errMsg.includes('copyright') || errMsg.includes('blocked'))  { userError = 'This video is blocked due to copyright.';             fix = 'Try a different URL'; }
    else if (errMsg.includes('spawn error'))                               { userError = 'Server configuration error.';                         fix = 'yt-dlp may not be installed — redeploy'; }

    return res.status(500).json({ success: false, error: userError, detail: errMsg.slice(0, 400), platform, fix });
  }
});

// ════════════════════════════════════════════════════════════
//  GET /api/merge — ffmpeg merges DASH video+audio
// ════════════════════════════════════════════════════════════
app.get('/api/merge', (req, res) => {
  const { videoUrl, audioUrl, filename = 'video.mp4' } = req.query;

  if (!videoUrl || !audioUrl) {
    // ✅ FIX #5: Return JSON not plain text
    return res.status(400).json({ error: 'videoUrl and audioUrl query params required' });
  }

  try { new URL(videoUrl); new URL(audioUrl); }
  catch (e) { return res.status(400).json({ error: 'Invalid videoUrl or audioUrl' }); }

  if (!FFMPEG) {
    return res.status(503).json({ error: 'ffmpeg is not installed on this server' });
  }

  const safeFile = (filename || 'video.mp4').replace(/[^\w\s\-\.]/g, '').slice(0, 100) || 'video.mp4';

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeFile + '"');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '-i', videoUrl,
    '-i', audioUrl,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ], { timeout: 300000, killSignal: 'SIGKILL' });

  ff.stdout.pipe(res);

  let ffErr = '';
  ff.stderr.on('data', d => {
    ffErr += d.toString();
    const line = d.toString().trim();
    if (line.length > 0 && !line.includes('frame=') && !line.includes('size='))
      console.log('[ffmpeg]', line.slice(0, 120));
  });

  ff.on('close', code => {
    if (code !== 0) console.error('[ffmpeg exit]', code, ffErr.slice(-200));
  });

  ff.on('error', err => {
    console.error('[ffmpeg spawn]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'ffmpeg error: ' + err.message });
  });

  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (e) {} });
  res.on('close', () => { try { ff.kill('SIGKILL'); } catch (e) {} });
});

// ════════════════════════════════════════════════════════════
//  GET /api/stream — proxy a single media stream
// ════════════════════════════════════════════════════════════
app.get('/api/stream', (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  let parsed;
  try { parsed = new URL(url); }
  catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  const lib        = parsed.protocol === 'https:' ? https : http;
  const reqHeaders = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Referer':         parsed.protocol + '//' + parsed.hostname + '/',
    'Origin':          parsed.protocol + '//' + parsed.hostname,
  };
  if (req.headers['range']) reqHeaders['Range'] = req.headers['range'];

  const opts = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers:  reqHeaders,
    timeout:  60000,
  };

  const proxyReq = lib.request(opts, upstream => {
    const ct = upstream.headers['content-type'] || 'video/mp4';
    const resHeaders = {
      'Content-Type':              ct,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Accept-Ranges':             'bytes',
      'Content-Disposition':       filename ? 'attachment; filename="' + filename + '"' : 'inline',
    };
    if (upstream.headers['content-length']) resHeaders['Content-Length'] = upstream.headers['content-length'];
    if (upstream.headers['content-range'])  resHeaders['Content-Range']  = upstream.headers['content-range'];
    res.writeHead(upstream.statusCode === 206 ? 206 : 200, resHeaders);
    upstream.pipe(res);
    upstream.on('error', () => { if (!res.headersSent) res.end(); });
    req.on('close', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
  });

  proxyReq.on('error', err => { if (!res.headersSent) res.status(502).json({ error: err.message }); });
  proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).json({ error: 'Stream timeout' }); });
  proxyReq.end();
});

// ── Health ────────────────────────────────────────────────────
// ✅ FIX #8: Check yt-dlp live version not just cached string
app.get('/health', (req, res) => {
  exec('yt-dlp --version', (yerr, yout) => {
    exec('ffmpeg -version', (ferr, fout) => {
      res.json({
        ok:         true,
        ytDlp:      yerr ? 'NOT FOUND' : (yout || '').trim(),
        ffmpeg:     ferr ? 'NOT INSTALLED' : (fout || '').split('\n')[0].slice(0, 60),
        cache:      CACHE.size,
        uptime:     Math.floor(process.uptime()) + 's',
        memMB:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        platform:   process.platform,
        node:       process.version,
        toolsReady: TOOLS_READY,
        ts:         new Date().toISOString(),
      });
    });
  });
});

// ✅ FIX #7: Global Express error handler
app.use((err, req, res, next) => {
  console.error('[express error]', err.message);
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: 'Internal server error', detail: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
detectTools(() => {
  console.log('[server] yt-dlp:', YT_DLP);
  console.log('[server] ffmpeg:', FFMPEG || 'NOT FOUND');
  scheduleYtDlpUpdate();
  app.listen(PORT, '0.0.0.0', () => console.log('[server] listening on port', PORT));
});
