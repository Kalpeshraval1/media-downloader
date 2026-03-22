'use strict';
// ═══════════════════════════════════════════════════════════════════
//  Media Downloader — Production Server
//  Built for 90M–200M daily requests
//  Node.js + yt-dlp + ffmpeg
//
//  Architecture:
//    ┌──────────────────────────────────────────┐
//    │  Cloudflare Worker (CDN + KV Cache)      │
//    │    ↓ cache miss only                     │
//    │  THIS SERVER (Render / Railway)          │
//    │    ↓ in-memory LRU + request queue       │
//    │  yt-dlp → CDN URLs → returned to client │
//    └──────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════════════════

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const { exec, spawn } = require('child_process');
const https     = require('https');
const http      = require('http');
const { URL }   = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Environment ────────────────────────────────────────────────────
const MAX_CONCURRENT    = parseInt(process.env.MAX_CONCURRENT    || '4');   // parallel yt-dlp processes
const CACHE_TTL_MS      = parseInt(process.env.CACHE_TTL_MS      || '300000'); // 5 min
const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '3000');
const QUEUE_MAX         = parseInt(process.env.QUEUE_MAX         || '50');   // queue depth before 503
const REQ_TIMEOUT_MS    = parseInt(process.env.REQ_TIMEOUT_MS    || '55000'); // yt-dlp per-request timeout

// ── LRU Cache ──────────────────────────────────────────────────────
const CACHE_MAP  = new Map();
const CACHE_KEYS = [];   // insertion-order for LRU eviction

function cacheGet(k) {
  const e = CACHE_MAP.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { CACHE_MAP.delete(k); return null; }
  return e.data;
}

function cacheSet(k, d) {
  if (CACHE_MAP.has(k)) {
    CACHE_MAP.get(k).data = d;
    CACHE_MAP.get(k).ts   = Date.now();
    return;
  }
  if (CACHE_MAP.size >= CACHE_MAX_ENTRIES) {
    // Evict oldest 10%
    const evict = Math.floor(CACHE_MAX_ENTRIES * 0.1);
    for (const [key] of CACHE_MAP) {
      CACHE_MAP.delete(key);
      if (CACHE_MAP.size < CACHE_MAX_ENTRIES - evict) break;
    }
  }
  CACHE_MAP.set(k, { data: d, ts: Date.now() });
}

// ── Concurrency Queue ──────────────────────────────────────────────
let activeJobs = 0;
const jobQueue = [];   // { fn, resolve, reject, timer }

function runOrQueue(fn) {
  return new Promise((resolve, reject) => {
    if (activeJobs < MAX_CONCURRENT) {
      runJob(fn, resolve, reject);
    } else if (jobQueue.length >= QUEUE_MAX) {
      reject(Object.assign(new Error('Server busy – please retry in a few seconds'), { code: 503 }));
    } else {
      // Queue it with a 60s wait timeout
      const timer = setTimeout(() => {
        const idx = jobQueue.findIndex(j => j.resolve === resolve);
        if (idx !== -1) jobQueue.splice(idx, 1);
        reject(Object.assign(new Error('Queue timeout – server overloaded'), { code: 503 }));
      }, 60000);
      jobQueue.push({ fn, resolve, reject, timer });
    }
  });
}

function runJob(fn, resolve, reject) {
  activeJobs++;
  Promise.resolve()
    .then(() => fn())
    .then(resolve)
    .catch(reject)
    .finally(() => {
      activeJobs--;
      if (jobQueue.length > 0) {
        const next = jobQueue.shift();
        clearTimeout(next.timer);
        runJob(next.fn, next.resolve, next.reject);
      }
    });
}

// ── Middleware ─────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Request logger
app.use((req, res, next) => {
  if (req.path !== '/health') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} | queue:${jobQueue.length} active:${activeJobs}`);
  }
  next();
});

// ── Static frontend ────────────────────────────────────────────────
app.get('/', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.json({ status: 'Media Downloader API', version: '3.0', health: '/health' });
});

// ── Tool detection ─────────────────────────────────────────────────
let YT_DLP = 'yt-dlp';
let FFMPEG  = 'ffmpeg';

function detectTools(cb) {
  exec('yt-dlp --version', (err) => {
    if (!err) { YT_DLP = 'yt-dlp'; }
    else {
      exec('python3 -m yt_dlp --version', (err2) => {
        if (!err2) YT_DLP = 'python3 -m yt_dlp';
        else console.warn('[WARN] yt-dlp not found! Install: pip3 install yt-dlp');
      });
    }
  });
  exec('ffmpeg -version', (err3) => {
    if (err3) { FFMPEG = null; console.warn('[WARN] ffmpeg not found'); }
    cb();
  });
}

// ── HTTP helper ────────────────────────────────────────────────────
function fetchJSON(urlStr, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch(e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: timeoutMs,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Bad JSON from ' + urlStr)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout: ' + urlStr)); });
  });
}

// ── yt-dlp wrapper ─────────────────────────────────────────────────
const YT_DLP_ARGS_BASE = [
  '--dump-single-json',
  '--no-playlist',
  '--no-check-certificates',
  '--no-warnings',
  '--quiet',
  '--socket-timeout', '25',
  '--retries', '2',
  '--fragment-retries', '2',
  '--extractor-retries', '2',
  '--ignore-errors',
  '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  '--add-header', 'Accept-Language:en-US,en;q=0.9',
  '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
];

function ytDlpInfo(url, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const parts = YT_DLP.split(' ');
    const args  = [...parts.slice(1), ...YT_DLP_ARGS_BASE, ...extraArgs, url];
    const proc  = spawn(parts[0], args, { timeout: REQ_TIMEOUT_MS });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.slice(0, 600) || 'yt-dlp exit ' + code));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error('yt-dlp returned invalid JSON')); }
    });
    proc.on('error', e => reject(new Error('spawn error: ' + e.message)));
  });
}

// ── Build format list ──────────────────────────────────────────────
function buildFormats(info, mode) {
  const fmts = info.formats || [];
  const out  = [], seen = new Set();

  const bestAudio = fmts
    .filter(f => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

  // Audio mode
  if (mode === 'audio') {
    fmts
      .filter(f => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
      .slice(0, 6)
      .forEach(f => {
        const ext = f.ext || 'mp3', abr = Math.round(f.abr || f.tbr || 128), key = ext + '-' + abr;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          quality: abr + 'k', label: ext.toUpperCase() + ' ' + abr + 'kbps',
          url: f.url, type: 'audio', ext, size: f.filesize || 0
        });
      });
    if (!out.length && fmts[0]?.url)
      out.push({ quality: 'Best', label: 'Best Audio', url: fmts[0].url, type: 'audio', ext: fmts[0].ext || 'mp3', size: 0 });
    return out;
  }

  // Video mode
  const muxed = fmts
    .filter(f => f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const dash = fmts
    .filter(f => f.url && f.vcodec && f.vcodec !== 'none' && f.height && (!f.acodec || f.acodec === 'none'))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  [4320, 2160, 1440, 1080, 720, 480, 360, 240].forEach(res => {
    if (seen.has(res)) return;
    const lbl = res >= 2160 ? res + 'p 4K' : res >= 1440 ? res + 'p 2K' : res >= 1080 ? res + 'p HD' : res >= 720 ? res + 'p HD' : res + 'p';
    const m = muxed.find(f => f.height === res);
    if (m) {
      seen.add(res);
      out.push({ quality: res + 'p', label: lbl, url: m.url, type: 'video',
        ext: m.ext || 'mp4', size: m.filesize || m.filesize_approx || 0,
        fps: m.fps || 0, hasMuxedAudio: true, audioUrl: '' });
      return;
    }
    const d = dash.find(f => f.height === res);
    if (d) {
      seen.add(res);
      out.push({ quality: res + 'p', label: lbl, url: d.url, type: 'video',
        ext: d.ext || 'mp4', size: d.filesize || d.filesize_approx || 0,
        fps: d.fps || 0, hasMuxedAudio: false, audioUrl: bestAudio ? bestAudio.url : '' });
    }
  });

  if (!out.length) {
    [...muxed, ...dash].slice(0, 5).forEach((f, i) => {
      if (seen.has(f.format_id)) return;
      seen.add(f.format_id);
      const has = !!(f.acodec && f.acodec !== 'none');
      out.push({
        quality: f.format_note || 'Option ' + (i + 1),
        label: f.format_note || 'Video ' + (i + 1),
        url: f.url, type: 'video', ext: f.ext || 'mp4', size: f.filesize || 0,
        fps: f.fps || 0, hasMuxedAudio: has,
        audioUrl: has ? '' : (bestAudio ? bestAudio.url : '')
      });
    });
  }

  if (!out.length && info.url)
    out.push({ quality: 'Best', label: 'Best Quality', url: info.url, type: 'video',
      ext: info.ext || 'mp4', size: 0, hasMuxedAudio: true, audioUrl: '' });

  if (bestAudio)
    out.push({ quality: 'Audio Only', label: 'Audio Only', url: bestAudio.url,
      type: 'audio', ext: bestAudio.ext || 'mp3', size: bestAudio.filesize || 0 });

  return out;
}

// ── TikTok no-watermark fallback ───────────────────────────────────
async function tikWmFallback(url) {
  const d = await fetchJSON('https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1');
  if (!d || d.code !== 0 || !d.data) throw new Error('TikWM failed');
  const t = d.data, formats = [];
  if (t.hdplay) formats.push({ quality: 'HD',    label: 'HD No Watermark',  url: t.hdplay, type: 'video', ext: 'mp4', size: t.hd_size  || 0, hasMuxedAudio: true, audioUrl: '' });
  if (t.play)   formats.push({ quality: 'SD',    label: 'SD No Watermark',  url: t.play,   type: 'video', ext: 'mp4', size: t.size     || 0, hasMuxedAudio: true, audioUrl: '' });
  if (t.wmplay) formats.push({ quality: 'WM',    label: 'With Watermark',   url: t.wmplay, type: 'video', ext: 'mp4', size: t.wm_size  || 0, hasMuxedAudio: true, audioUrl: '' });
  if (t.music)  formats.push({ quality: 'Audio', label: 'Audio Only',       url: t.music,  type: 'audio', ext: 'mp3', size: 0 });
  return {
    platform: 'tiktok', title: t.title || 'TikTok Video', thumbnail: t.cover || '',
    author: t.author?.nickname || '', duration: t.duration || 0,
    views: t.play_count || 0, likes: t.digg_count || 0,
    formats, images: t.images || []
  };
}

// ── Detect platform ────────────────────────────────────────────────
function detectPlatform(url) {
  if (/tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url)) return 'tiktok';
  if (/snapchat\.com/i.test(url))      return 'snapchat';
  if (/instagram\.com/i.test(url))     return 'instagram';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/twitter\.com|x\.com/i.test(url))   return 'twitter';
  if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) return 'facebook';
  if (/reddit\.com|redd\.it/i.test(url))  return 'reddit';
  if (/soundcloud\.com/i.test(url))        return 'soundcloud';
  if (/vimeo\.com/i.test(url))             return 'vimeo';
  if (/twitch\.tv|clips\.twitch/i.test(url)) return 'twitch';
  if (/dailymotion\.com/i.test(url))       return 'dailymotion';
  if (/pinterest\.com|pin\.it/i.test(url)) return 'pinterest';
  return 'unknown';
}

// ══════════════════════════════════════════════════════════════════
//  POST /api/download
// ══════════════════════════════════════════════════════════════════
app.post('/api/download', async (req, res) => {
  // Validate input
  const { url, type = 'video' } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }
  if (!['video', 'audio', 'image'].includes(type)) {
    return res.status(400).json({ success: false, error: 'Invalid type' });
  }
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch(e) {
    return res.status(400).json({ success: false, error: 'Invalid URL format' });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ success: false, error: 'Only http/https URLs allowed' });
  }

  // Cache check
  const cKey = url + '::' + type;
  const cached = cacheGet(cKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }
  res.setHeader('X-Cache', 'MISS');

  const platform = detectPlatform(url);
  console.log(`[${new Date().toISOString()}] ${platform.toUpperCase()} type=${type} ${url.slice(0, 80)}`);

  // Throttle: don't accept more work than we can handle
  try {
    const result = await runOrQueue(async () => {
      // First try yt-dlp
      try {
        const info = await ytDlpInfo(url);
        const formats = buildFormats(info, type);

        let images = [];
        if (type === 'image') {
          const thumbs = (info.thumbnails || []).filter(t => t.url).map(t => t.url);
          images = thumbs.length > 1 ? thumbs : (info.thumbnail ? [info.thumbnail] : []);
        }
        if (info.entries) {
          images = info.entries.map(e => e.url || e.thumbnail || '').filter(Boolean);
        }

        return {
          success: true, platform,
          title:     info.title || info.fulltitle || 'Video',
          thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || '',
          author:    info.uploader || info.channel || info.creator || '',
          duration:  info.duration || 0,
          views:     info.view_count || 0,
          likes:     info.like_count || 0,
          formats, images
        };

      } catch (ytErr) {
        console.warn(`  yt-dlp failed: ${ytErr.message.slice(0, 200)}`);

        // TikTok fallback to TikWM API
        if (platform === 'tiktok') {
          const data = await tikWmFallback(url);
          return Object.assign({ success: true }, data);
        }

        throw ytErr;
      }
    });

    cacheSet(cKey, result);
    return res.json(result);

  } catch (err) {
    const code    = err.code === 503 ? 503 : 500;
    const message = err.message || 'Download failed';
    console.error(`  Error [${code}]: ${message.slice(0, 200)}`);

    const fix =
      message.includes('Sign in')  ? 'This video requires login' :
      message.includes('Private')  ? 'This video is private' :
      message.includes('removed')  ? 'This video has been removed' :
      message.includes('busy')     ? 'Server busy — please retry in a few seconds' :
      message.includes('timeout')  ? 'Request timed out — please retry' :
      'Try updating yt-dlp: pip3 install -U yt-dlp';

    return res.status(code).json({
      success: false,
      error: fix,
      detail: message.slice(0, 300),
      platform,
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  GET /api/merge  — ffmpeg server-side DASH merge
// ══════════════════════════════════════════════════════════════════
app.get('/api/merge', (req, res) => {
  const { videoUrl, audioUrl, filename = 'video.mp4' } = req.query;
  if (!videoUrl || !audioUrl)
    return res.status(400).json({ error: 'videoUrl and audioUrl required' });
  if (!FFMPEG)
    return res.status(503).json({ error: 'ffmpeg not available on this server' });

  const safeFilename = (filename || 'video.mp4').replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 100);

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');  // Nginx: disable buffering

  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', videoUrl,
    '-i', audioUrl,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  ], { timeout: 300000 });

  ff.stdout.pipe(res);

  let ffErr = '';
  ff.stderr.on('data', d => {
    ffErr += d.toString();
    const line = d.toString().trim();
    if (line && !line.includes('frame=') && !line.includes('size='))
      console.log('[ffmpeg]', line.slice(0, 120));
  });

  ff.on('close', code => {
    if (code !== 0) {
      console.error(`[ffmpeg] exit ${code}: ${ffErr.slice(-200)}`);
      if (!res.headersSent) res.status(500).json({ error: 'ffmpeg failed' });
    }
  });

  ff.on('error', e => {
    console.error('[ffmpeg spawn]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

  req.on('close', () => { try { ff.kill('SIGKILL'); } catch(_) {} });
});

// ══════════════════════════════════════════════════════════════════
//  GET /api/stream  — proxy stream (for CORS-blocked CDNs)
// ══════════════════════════════════════════════════════════════════
app.get('/api/stream', (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  let parsed;
  try { parsed = new URL(url); } catch(e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const lib = parsed.protocol === 'https:' ? https : http;
  const reqHeaders = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Referer':         parsed.protocol + '//' + parsed.hostname + '/',
    'Origin':          parsed.protocol + '//' + parsed.hostname,
  };
  if (req.headers['range']) reqHeaders['Range'] = req.headers['range'];

  const proxyReq = lib.request({
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET', headers: reqHeaders, timeout: 60000,
  }, upstream => {
    const resHeaders = {
      'Content-Type':                 upstream.headers['content-type'] || 'video/mp4',
      'Access-Control-Allow-Origin':  '*',
      'Accept-Ranges':                'bytes',
      'Content-Disposition': filename ? `attachment; filename="${filename}"` : 'inline',
    };
    if (upstream.headers['content-length']) resHeaders['Content-Length'] = upstream.headers['content-length'];
    if (upstream.headers['content-range'])  resHeaders['Content-Range']  = upstream.headers['content-range'];
    res.writeHead(upstream.statusCode === 206 ? 206 : 200, resHeaders);
    upstream.pipe(res);
    req.on('close', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
  });

  proxyReq.on('error', e => { if (!res.headersSent) res.status(502).json({ error: e.message }); });
  proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).json({ error: 'Timeout' }); });
  proxyReq.end();
});

// ── Health ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:        true,
    version:   '3.0',
    ytDlp:     YT_DLP || 'not found',
    ffmpeg:    FFMPEG  || 'not found',
    cache:     CACHE_MAP.size,
    active:    activeJobs,
    queued:    jobQueue.length,
    maxConc:   MAX_CONCURRENT,
    uptime:    Math.floor(process.uptime()) + 's',
    memMB:     Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    node:      process.version,
    platform:  process.platform,
  });
});

// ── 404 / Error handlers ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, req, res, next) => {
  console.error('[unhandled]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Graceful shutdown ──────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[SIGTERM] Shutting down gracefully...');
  process.exit(0);
});
process.on('uncaughtException',  e => console.error('[uncaughtException]',  e.message));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

// ── Start ──────────────────────────────────────────────────────────
detectTools(() => {
  console.log(`[START] yt-dlp=${YT_DLP} ffmpeg=${FFMPEG || 'NOT FOUND'} port=${PORT}`);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[READY] Server listening on port ${PORT}`);
  });
});
