'use strict';
// Page URLs on video sites (YouTube, Facebook, Instagram, TikTok) go through a user-installed
// yt-dlp (`brew install yt-dlp` / `winget install yt-dlp.yt-dlp`).
// yt-dlp does all site-specific work; we only build the command and read its progress.
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { FFMPEG, findBin } = require('./hls');

const YTDLP = findBin('yt-dlp');

// Base domains; subdomains (www., m., vm., web., music.) are allowed too.
const DOMAINS = ['youtube.com', 'youtu.be', 'facebook.com', 'fb.watch', 'instagram.com', 'tiktok.com'];
const QUALITIES = ['best', '1080', '720', '480', 'mp3'];

function isVideoSite(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && DOMAINS.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

const UNITS = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, KB: 1e3, MB: 1e6, GB: 1e9 };
const toBytes = (s) => {
  const m = /([\d.]+)\s*([KMG]?i?B)/.exec(s || '');
  return m ? Math.round(Number(m[1]) * (UNITS[m[2]] || 1)) : 0;
};

// One line of `yt-dlp --newline` output -> progress event, or null.
function parseProgress(line) {
  const m = line.match(/^\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*(\S+))?(?:.*?\bat\s+(\S+))?(?:.*?\bETA\s+(\S+))?/);
  if (m) return { stage: 'download', percent: Number(m[1]), total: m[2], speed: m[3], eta: m[4] };
  if (line.startsWith('[Merger]')) return { stage: 'merging' };
  if (line.startsWith('[ExtractAudio]')) return { stage: 'converting' };
  return null;
}

const TITLE = 'SWIFTLOAD_TITLE ';
const FILE = 'SWIFTLOAD_FILE ';

function buildArgs(item, { connections = 8, speedLimit = 0, ffmpeg = FFMPEG } = {}) {
  const q = item.ytdlp.quality;
  const a = [
    '--newline', '--progress', '--no-playlist', '--no-warnings',
    '-N', String(connections),
    '-o', path.join(item.dir, '%(title).150B.%(ext)s'),
    '--print', `before_dl:${TITLE}%(title)s`,
    '--print', `after_move:${FILE}%(filepath)s`,
  ];
  if (speedLimit) a.push('--limit-rate', `${speedLimit}K`);
  if (ffmpeg) a.push('--ffmpeg-location', ffmpeg);
  if (q === 'mp3') a.push('-x', '--audio-format', 'mp3');
  else a.push('-f', 'bv*+ba/b', '-S', `${q === 'best' ? '' : `res:${q},`}vcodec:h264,acodec:m4a`, '--merge-output-format', 'mp4');
  a.push('--', item.url);
  return a;
}

class YtdlpDownload extends EventEmitter {
  constructor(item, opts = {}) {
    super();
    this.item = item;
    this.opts = opts;
    this.bin = opts.bin === undefined ? YTDLP : opts.bin;
  }

  get done() { return 0; } // progress lives in item.yt; byte counts reset per track

  pause() {
    this.paused = true;
    this.child?.kill('SIGINT'); // rerunning the same command continues the .part files
  }

  async start() {
    this.paused = false;
    const it = this.item;
    try {
      if (!this.bin) throw new Error(process.platform === 'win32' ? 'Needs yt-dlp (winget install yt-dlp)' : 'Needs yt-dlp (brew install yt-dlp)');
      it.dir = it.dir || (this.opts.dirFor || (() => process.cwd()))(it.ytdlp.quality === 'mp3' ? 'audio.mp3' : 'video.mp4');
      await fs.mkdir(it.dir, { recursive: true });
      const child = (this.child = spawn(this.bin, buildArgs(it, this.opts), { stdio: ['ignore', 'pipe', 'pipe'] }));
      let file = null, lastError = '';
      const onLine = (line) => {
        if (line.startsWith(TITLE)) { it.name = line.slice(TITLE.length).trim(); return; }
        if (line.startsWith(FILE)) { file = line.slice(FILE.length).trim(); return; }
        if (line.startsWith('ERROR:')) { lastError = line.slice(6).trim(); return; }
        const p = parseProgress(line);
        if (!p) return;
        const prev = it.yt || { part: 0 };
        // A new track (video, then audio) restarts at a low percent.
        const part = p.stage === 'download' && prev.stage === 'download' && p.percent + 50 < prev.percent ? prev.part + 1 : prev.part;
        it.yt = { ...p, part, speedBps: toBytes(p.speed) };
      };
      readline.createInterface({ input: child.stdout }).on('line', onLine);
      readline.createInterface({ input: child.stderr }).on('line', onLine);
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      this.child = null;
      if (this.paused) return;
      if (code !== 0 || !file) throw new Error(lastError || `yt-dlp exited with code ${code}`);
      it.file = file;
      it.name = path.basename(file);
      it.size = (await fs.stat(file)).size;
      it.yt = { stage: 'done', percent: 100 };
      this.emit('done');
    } catch (err) {
      this.child = null;
      if (!this.paused) this.emit('error', err);
    }
  }
}

module.exports = { YtdlpDownload, isVideoSite, parseProgress, buildArgs, QUALITIES, YTDLP };
