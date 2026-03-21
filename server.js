const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { exec, spawn } = require('child_process');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;
const TMP  = os.tmpdir();

// Cache
const CACHE = new Map();
function cacheGet(k){const e=CACHE.get(k);if(!e)return null;if(Date.now()-e.ts>5*60*1000){CACHE.delete(k);return null;}return e.data;}
function cacheSet(k,d){if(CACHE.size>2000){[...CACHE.keys()].slice(0,500).forEach(x=>CACHE.delete(x));}CACHE.set(k,{data:d,ts:Date.now()});}

app.use(cors({origin:'*'}));
app.use(express.json());
app.use(express.static(path.join(__dirname,'public'),{maxAge:'1d'}));

// Detect yt-dlp
let YT_DLP = 'yt-dlp';
function detectYtDlp(cb){
  exec('yt-dlp --version',err=>{
    if(!err){YT_DLP='yt-dlp';return cb('yt-dlp');}
    exec('python3 -m yt_dlp --version',err2=>{
      if(!err2){YT_DLP='python3 -m yt_dlp';return cb(YT_DLP);}
      cb(null);
    });
  });
}

// Fetch JSON
function fetchJSON(urlStr){
  return new Promise((resolve,reject)=>{
    const u=new URL(urlStr);
    const lib=u.protocol==='https:'?https:http;
    lib.get({hostname:u.hostname,path:u.pathname+u.search,
      headers:{'User-Agent':'Mozilla/5.0'},timeout:15000},
      res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});}
    ).on('error',reject).on('timeout',function(){this.destroy();reject(new Error('Timeout'));});
  });
}

// yt-dlp info
function ytDlpInfo(url){
  return new Promise((resolve,reject)=>{
    const parts=YT_DLP.split(' ');
    const proc=spawn(parts[0],[...parts.slice(1),
      '--dump-single-json','--no-playlist',
      '--no-check-certificates','--no-warnings',
      '--socket-timeout','30',
      '--add-header','User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '--add-header','Accept-Language:en-US,en;q=0.9',
      url
    ],{timeout:60000});
    let out='',err='';
    proc.stdout.on('data',d=>out+=d);
    proc.stderr.on('data',d=>err+=d);
    proc.on('close',code=>{
      if(code!==0)return reject(new Error(err.slice(0,400)||'yt-dlp exit '+code));
      try{resolve(JSON.parse(out));}catch(e){reject(new Error('Bad JSON'));}
    });
    proc.on('error',reject);
  });
}

// Build formats - always prefer muxed, attach audioUrl for DASH
function buildFormats(info,mode){
  const fmts=info.formats||[];
  const out=[],seen=new Set();

  const bestAudio=fmts
    .filter(f=>f.url&&f.acodec&&f.acodec!=='none'&&(!f.vcodec||f.vcodec==='none'))
    .sort((a,b)=>(b.abr||b.tbr||0)-(a.abr||a.tbr||0))[0];

  if(mode==='audio'){
    fmts.filter(f=>f.url&&f.acodec&&f.acodec!=='none'&&(!f.vcodec||f.vcodec==='none'))
      .sort((a,b)=>(b.abr||b.tbr||0)-(a.abr||a.tbr||0))
      .slice(0,5)
      .forEach(f=>{
        const ext=f.ext||'mp3',abr=Math.round(f.abr||f.tbr||128),key=ext+abr;
        if(seen.has(key))return;seen.add(key);
        out.push({quality:abr+'k',label:ext.toUpperCase()+' '+abr+'kbps',url:f.url,type:'audio',ext,size:f.filesize||0});
      });
    if(!out.length&&fmts[0]?.url)
      out.push({quality:'Best',label:'Best Audio',url:fmts[0].url,type:'audio',ext:fmts[0].ext||'mp3',size:0});
    return out;
  }

  const muxed=fmts
    .filter(f=>f.url&&f.vcodec&&f.vcodec!=='none'&&f.acodec&&f.acodec!=='none'&&f.height)
    .sort((a,b)=>(b.height||0)-(a.height||0));

  const dash=fmts
    .filter(f=>f.url&&f.vcodec&&f.vcodec!=='none'&&f.height&&(!f.acodec||f.acodec==='none'))
    .sort((a,b)=>(b.height||0)-(a.height||0));

  [2160,1440,1080,720,480,360,240].forEach(res=>{
    if(seen.has(res))return;
    const m=muxed.find(f=>f.height===res);
    if(m){
      seen.add(res);
      const lbl=res>=1080?res+'p Full HD':res>=720?res+'p HD':res+'p SD';
      out.push({quality:res+'p',label:lbl,url:m.url,type:'video',
        ext:m.ext||'mp4',size:m.filesize||m.filesize_approx||0,fps:m.fps||0,
        hasMuxedAudio:true,audioUrl:''});
      return;
    }
    const d=dash.find(f=>f.height===res);
    if(d){
      seen.add(res);
      const lbl=res>=1080?res+'p Full HD':res>=720?res+'p HD':res+'p SD';
      out.push({quality:res+'p',label:lbl,url:d.url,type:'video',
        ext:d.ext||'mp4',size:d.filesize||d.filesize_approx||0,fps:d.fps||0,
        hasMuxedAudio:false,audioUrl:bestAudio?bestAudio.url:''});
    }
  });

  if(!out.length){
    [...muxed,...dash].slice(0,5).forEach((f,i)=>{
      if(seen.has(f.format_id))return;seen.add(f.format_id);
      const has=!!(f.acodec&&f.acodec!=='none');
      out.push({quality:f.format_note||'Option '+(i+1),label:f.format_note||'Video '+(i+1),
        url:f.url,type:'video',ext:f.ext||'mp4',size:f.filesize||0,
        hasMuxedAudio:has,audioUrl:has?'':(bestAudio?bestAudio.url:'')});
    });
  }
  if(!out.length&&info.url)
    out.push({quality:'Best',label:'Best Quality',url:info.url,type:'video',
      ext:info.ext||'mp4',size:0,hasMuxedAudio:true,audioUrl:''});
  if(bestAudio)
    out.push({quality:'Audio Only',label:'Audio Only',url:bestAudio.url,
      type:'audio',ext:bestAudio.ext||'mp3',size:bestAudio.filesize||0});
  return out;
}

// TikTok fallback - no watermark
async function tikWmFallback(url){
  const d=await fetchJSON('https://www.tikwm.com/api/?url='+encodeURIComponent(url)+'&hd=1');
  if(!d||d.code!==0||!d.data)throw new Error('TikWM failed');
  const t=d.data,formats=[];
  if(t.hdplay)formats.push({quality:'HD',label:'HD No Watermark',url:t.hdplay,type:'video',ext:'mp4',size:t.hd_size||0,hasMuxedAudio:true,audioUrl:''});
  if(t.play)  formats.push({quality:'SD',label:'SD No Watermark', url:t.play,  type:'video',ext:'mp4',size:t.size||0,   hasMuxedAudio:true,audioUrl:''});
  if(t.wmplay)formats.push({quality:'WM',label:'With Watermark',  url:t.wmplay,type:'video',ext:'mp4',size:t.wm_size||0,hasMuxedAudio:true,audioUrl:''});
  if(t.music) formats.push({quality:'Audio',label:'Audio Only',   url:t.music, type:'audio',ext:'mp3',size:0});
  return{platform:'tiktok',title:t.title||'TikTok Video',thumbnail:t.cover||'',
    author:t.author?.nickname||'',duration:t.duration||0,
    views:t.play_count||0,likes:t.digg_count||0,formats,images:t.images||[]};
}

// Snapchat no-watermark via snapinsta/snapdl APIs
async function snapFallback(url){
  try{
    const d=await fetchJSON('https://snapinsta.app/api/?url='+encodeURIComponent(url));
    if(d&&d.url)return{url:d.url,watermark:false};
  }catch(e){}
  return null;
}

// ================================================================
//  POST /api/download
// ================================================================
app.post('/api/download',async(req,res)=>{
  const{url,type='video'}=req.body;
  if(!url)return res.status(400).json({error:'URL required'});

  const cKey=url+'::'+type;
  const cached=cacheGet(cKey);
  if(cached){console.log('[CACHE] '+url.slice(0,60));return res.json(cached);}

  let platform='unknown';
  const isTikTok=/tiktok\.com|vm\.tiktok|vt\.tiktok|douyin\.com/i.test(url);
  const isSnap  =/snapchat\.com|snap\.com/i.test(url);
  if(isTikTok)                                           platform='tiktok';
  else if(isSnap)                                        platform='snapchat';
  else if(/instagram\.com/i.test(url))                  platform='instagram';
  else if(/youtube\.com|youtu\.be/i.test(url))          platform='youtube';
  else if(/twitter\.com|x\.com/i.test(url))             platform='twitter';
  else if(/facebook\.com|fb\.com|fb\.watch/i.test(url)) platform='facebook';
  else if(/reddit\.com|redd\.it/i.test(url))            platform='reddit';
  else if(/soundcloud\.com/i.test(url))                 platform='soundcloud';
  else if(/vimeo\.com/i.test(url))                      platform='vimeo';
  else if(/twitch\.tv|clips\.twitch/i.test(url))        platform='twitch';
  else if(/dailymotion\.com/i.test(url))                platform='dailymotion';

  console.log('['+new Date().toISOString()+'] '+platform.toUpperCase()+' '+url.slice(0,70));

  try{
    const info=await ytDlpInfo(url);
    const formats=buildFormats(info,type);
    let images=[];
    if(type==='image'){
      const thumbs=(info.thumbnails||[]).map(t=>t.url).filter(Boolean);
      images=thumbs.length>1?thumbs:(info.thumbnail?[info.thumbnail]:[]);
    }
    if(info.entries)images=info.entries.map(e=>e.url||e.thumbnail||'').filter(Boolean);

    const result={success:true,platform,
      title:info.title||info.fulltitle||'Video',
      thumbnail:info.thumbnail||(info.thumbnails&&info.thumbnails[0]&&info.thumbnails[0].url)||'',
      author:info.uploader||info.channel||info.creator||'',
      duration:info.duration||0,views:info.view_count||0,likes:info.like_count||0,
      formats,images};
    cacheSet(cKey,result);
    return res.json(result);
  }catch(ytErr){
    console.log('  yt-dlp: '+ytErr.message.slice(0,100));
    if(isTikTok){
      try{const data=await tikWmFallback(url);const r=Object.assign({success:true},data);cacheSet(cKey,r);return res.json(r);}
      catch(e){console.log('  tikwm: '+e.message);}
    }
    return res.status(500).json({success:false,error:'Could not fetch download links',
      detail:ytErr.message.slice(0,300),fix:'Run: pip install -U yt-dlp'});
  }
});

// ================================================================
//  GET /api/merge  — ffmpeg merges video+audio into one stream
//  Used for DOWNLOAD of DASH videos (YouTube 1080p+)
//  ?videoUrl=...&audioUrl=...&filename=...
// ================================================================
app.get('/api/merge',(req,res)=>{
  const{videoUrl,audioUrl,filename='video.mp4'}=req.query;
  if(!videoUrl||!audioUrl)return res.status(400).send('videoUrl and audioUrl required');

  console.log('[MERGE] '+filename);

  res.setHeader('Content-Type','video/mp4');
  res.setHeader('Content-Disposition','attachment; filename="'+filename+'"');
  res.setHeader('Access-Control-Allow-Origin','*');

  // Stream ffmpeg output directly to response — no temp files needed
  // -i videoUrl -i audioUrl -c copy -movflags faststart -f mp4 pipe:1
  const ff=spawn('ffmpeg',[
    '-hide_banner','-loglevel','error',
    '-i',videoUrl,
    '-i',audioUrl,
    '-c:v','copy',   // copy video stream — no re-encode, fast
    '-c:a','aac',    // encode audio to AAC for MP4 compatibility
    '-b:a','192k',
    '-movflags','frag_keyframe+empty_moov', // allows streaming output
    '-f','mp4',
    'pipe:1'         // output to stdout
  ],{timeout:300000});

  ff.stdout.pipe(res);

  ff.stderr.on('data',d=>{
    const msg=d.toString();
    if(!msg.includes('frame=')&&!msg.includes('size='))
      console.log('[ffmpeg] '+msg.trim().slice(0,120));
  });

  ff.on('close',code=>{
    if(code!==0&&!res.headersSent){
      res.status(500).send('ffmpeg error code '+code);
    }
  });
  ff.on('error',err=>{
    console.log('[ffmpeg error] '+err.message);
    if(!res.headersSent)res.status(500).send('ffmpeg not available: '+err.message);
  });

  req.on('close',()=>ff.kill('SIGKILL'));
});

// ================================================================
//  GET /api/stream  — proxy single stream (preview + direct dl)
// ================================================================
app.get('/api/stream',(req,res)=>{
  const{url,filename}=req.query;
  if(!url)return res.status(400).send('url required');

  let parsed;
  try{parsed=new URL(url);}catch(e){return res.status(400).send('Invalid URL');}

  const lib=parsed.protocol==='https:'?https:http;
  const reqHeaders={
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept':'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
    'Accept-Language':'en-US,en;q=0.9',
    'Accept-Encoding':'identity',
    'Referer':parsed.protocol+'//'+parsed.hostname+'/',
    'Origin':parsed.protocol+'//'+parsed.hostname,
    'Connection':'keep-alive',
  };
  if(req.headers['range'])reqHeaders['Range']=req.headers['range'];

  const opts={
    hostname:parsed.hostname,
    port:parsed.port||(parsed.protocol==='https:'?443:80),
    path:parsed.pathname+parsed.search,
    method:'GET',headers:reqHeaders,timeout:60000,
  };

  const proxyReq=lib.request(opts,upstream=>{
    const ct=upstream.headers['content-type']||'video/mp4';
    const resHeaders={
      'Content-Type':ct,
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'Range',
      'Accept-Ranges':'bytes',
      'Content-Disposition':filename?'attachment; filename="'+filename+'"':'inline',
    };
    if(upstream.headers['content-length'])resHeaders['Content-Length']=upstream.headers['content-length'];
    if(upstream.headers['content-range']) resHeaders['Content-Range'] =upstream.headers['content-range'];
    res.writeHead(upstream.statusCode===206?206:200,resHeaders);
    upstream.pipe(res);
    req.on('close',()=>upstream.destroy());
    res.on('close',()=>upstream.destroy());
  });
  proxyReq.on('error',err=>{if(!res.headersSent)res.status(502).send(err.message);});
  proxyReq.on('timeout',()=>{proxyReq.destroy();if(!res.headersSent)res.status(504).send('Timeout');});
  proxyReq.end();
});

// Health
app.get('/health',(req,res)=>{
  detectYtDlp(cmd=>{
    exec('ffmpeg -version',(err,stdout)=>{
      res.json({
        ok:true,
        ytDlp:cmd||'NOT INSTALLED',
        ffmpeg:err?'NOT INSTALLED':stdout.split('\n')[0],
        cacheEntries:CACHE.size,
        uptime:Math.floor(process.uptime())+'s',
        memMB:Math.round(process.memoryUsage().heapUsed/1024/1024)
      });
    });
  });
});

detectYtDlp(cmd=>{
  if(cmd)console.log('yt-dlp: '+cmd);
  else console.warn('WARNING: yt-dlp not found!');
  app.listen(PORT,()=>console.log('Server on port '+PORT));
});
