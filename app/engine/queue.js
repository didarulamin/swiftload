'use strict';
// Download list + queue + scheduler + persistence. No Electron imports, so it runs under plain node too.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Download, Limiter } = require('./download');
const { HlsDownload } = require('./hls');
const { MergeDownload, bytes } = require('./merge');
const { YtdlpDownload, isVideoSite, QUALITIES } = require('./ytdlp');

const CATEGORIES = {
  Compressed: /^(zip|rar|7z|r\d\d|arj|gz|tgz|bz2|xz|tar|sit|sitx|sea|ace|lzh)$/,
  Video: /^(avi|mpg|mpe|mpeg|asf|wmv|mov|qt|rm|rmvb|mp4|flv|m4v|webm|ogv|mkv|ts|3gp)$/,
  Music: /^(mp3|wav|wma|mpa|ra|aac|aif|aiff|m4a|ogg|flac|opus)$/,
  Documents: /^(doc|docx|pdf|ppt|pptx|pps|xls|xlsx|txt|rtf|epub|odt)$/,
  Programs: /^(exe|msi|apk|dmg|pkg|iso|img|bin|app)$/,
};

function categoryOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const [cat, re] of Object.entries(CATEGORIES)) if (re.test(ext)) return cat;
  return 'General';
}

// A copied piece of text worth offering as a download: one http(s) URL that points at a
// known file type, or a page on a yt-dlp video site.
function isDownloadLink(text) {
  const s = (text || '').trim();
  if (!s || /\s/.test(s) || s.length > 4096) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isVideoSite(u.href) || categoryOf(decodeURIComponent(path.posix.basename(u.pathname))) !== 'General';
  } catch {
    return false;
  }
}

const DEFAULTS = {
  baseDir: path.join(os.homedir(), 'Downloads'),
  connections: 8,
  maxActive: 3,
  speedLimit: 0, // KB/s, 0 = unlimited
  schedule: { enabled: false, start: '02:00', stop: '07:00' },
  watchClipboard: true,
};

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

class Manager extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.settings = { ...DEFAULTS, ...state.settings, schedule: { ...DEFAULTS.schedule, ...state.settings?.schedule } };
    this.items = (state.items || []).map((it) => (it.status === 'downloading' ? { ...it, status: 'queued' } : it));
    this.running = new Map(); // id -> Download
    this.speeds = new Map(); // id -> { done, speed }
    this.limiter = new Limiter(this.settings.speedLimit * 1024);
    this.timer = setInterval(() => this.tick(), 1000);
    this.pump();
  }

  add({ url, name, referer, cookie, hls, audioUrl, quality }) {
    const u = new URL(url); // throws on garbage
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https links are supported');
    const item = { id: crypto.randomUUID(), url: u.href, name: name || null, headers: { referer, cookie }, size: -1, status: 'queued', added: Date.now() };
    if (isVideoSite(u.href)) {
      if (quality && !QUALITIES.includes(quality)) throw new Error('Unknown quality');
      item.ytdlp = { quality: quality || 'best' };
    } else if (hls || /\.m3u8$/i.test(u.pathname)) item.hls = true;
    if (audioUrl) {
      const a = new URL(audioUrl);
      if (a.protocol !== 'http:' && a.protocol !== 'https:') throw new Error('Only http and https links are supported');
      item.audioUrl = a.href;
    }
    this.items.unshift(item);
    this.pump();
    this.save();
    return item.id;
  }

  find(id) { return this.items.find((i) => i.id === id); }

  pause(id) {
    const it = this.find(id);
    if (!it) return;
    this.running.get(id)?.pause();
    this.running.delete(id);
    if (it.status === 'downloading' || it.status === 'queued') it.status = 'paused';
    this.pump();
    this.save();
  }

  resume(id) {
    const it = this.find(id);
    if (it && (it.status === 'paused' || it.status === 'error')) { it.status = 'queued'; it.error = null; }
    this.pump();
    this.save();
  }

  // Pause everything first, then save once; pausing one by one would let pump() start the next queued item.
  pauseAll() {
    for (const dl of this.running.values()) dl.pause();
    this.running.clear();
    for (const it of this.items) if (it.status === 'downloading' || it.status === 'queued') it.status = 'paused';
    this.save();
  }

  resumeAll() {
    for (const it of this.items) if (it.status === 'paused' || it.status === 'error') { it.status = 'queued'; it.error = null; }
    this.pump();
    this.save();
  }

  clearFinished() {
    this.items = this.items.filter((it) => it.status !== 'done');
    this.save();
  }

  // Same link and options as a new item; the old entry and file stay untouched.
  redownload(id) {
    const it = this.find(id);
    if (!it) return null;
    return this.add({
      url: it.url, name: it.ytdlp ? null : it.name, referer: it.headers?.referer, cookie: it.headers?.cookie,
      hls: it.hls, audioUrl: it.audioUrl, quality: it.ytdlp?.quality,
    });
  }

  remove(id, deleteFile) {
    const it = this.find(id);
    if (!it) return;
    this.pause(id);
    this.items = this.items.filter((i) => i !== it);
    if (deleteFile) for (const x of [it, ...(it.tracks || [])]) if (x.file) for (const f of [x.file, x.file + '.part']) fs.rmSync(f, { force: true });
    this.save();
  }

  setSettings(s) {
    this.settings = { ...this.settings, ...s, schedule: { ...this.settings.schedule, ...s.schedule } };
    this.limiter.rate = this.settings.speedLimit * 1024;
    this.save();
    this.pump();
  }

  inWindow() {
    const { enabled, start, stop } = this.settings.schedule;
    if (!enabled) return true;
    const d = new Date(), now = d.getHours() * 60 + d.getMinutes(), a = minutes(start), b = minutes(stop);
    return a <= b ? now >= a && now < b : now >= a || now < b;
  }

  pump() {
    if (!this.inWindow()) return;
    for (const it of this.items.slice().reverse()) { // oldest first
      if (this.running.size >= this.settings.maxActive) break;
      if (it.status === 'queued') this.startItem(it);
    }
  }

  startItem(it) {
    it.status = 'downloading';
    const dl = new (it.ytdlp ? YtdlpDownload : it.audioUrl ? MergeDownload : it.hls ? HlsDownload : Download)(it, {
      connections: this.settings.connections,
      speedLimit: this.settings.speedLimit, // yt-dlp enforces its own limit
      limiter: this.limiter,
      dirFor: (name) => path.join(this.settings.baseDir, categoryOf(name)),
    });
    this.running.set(it.id, dl);
    const finish = (status, err) => {
      if (this.running.get(it.id) !== dl) return;
      this.running.delete(it.id);
      it.status = status;
      it.error = err ? err.message : null;
      if (status === 'done') it.finished = Date.now();
      this.save();
      this.emit('finished', it);
      this.pump();
    };
    dl.on('done', () => finish('done'));
    dl.on('error', (err) => finish('error', err));
    dl.start();
  }

  tick() {
    // Scheduler: outside the window, push running downloads back to the queue.
    if (!this.inWindow()) {
      for (const [id, dl] of this.running) { dl.pause(); this.running.delete(id); this.find(id).status = 'queued'; }
    } else this.pump();
    for (const [id, dl] of this.running) {
      const prev = this.speeds.get(id), done = dl.done;
      this.speeds.set(id, { done, speed: prev ? Math.max(0, done - prev.done) : 0 });
    }
    for (const id of this.speeds.keys()) if (!this.running.has(id)) this.speeds.delete(id);
    if (this.running.size) this.save();
    this.emit('update', this.snapshot());
  }

  snapshot() {
    return {
      settings: this.settings,
      items: this.items.map((it) => ({
        id: it.id, url: it.url, name: it.name, size: it.tracks && it.status !== 'done' ? (it.tracks.length === 2 && it.tracks.every((t) => t.size > 0) ? it.tracks[0].size + it.tracks[1].size : -1) : it.size, status: it.status, error: it.error, file: it.file, added: it.added,
        category: it.name ? categoryOf(it.name) : 'General',
        done: it.status === 'done' ? it.size : it.tracks ? it.tracks.reduce((n, t) => n + bytes(t), 0) : it.hls ? it.hlsBytes || 0 : bytes(it),
        parts: it.hls && it.hlsTotal ? [it.hlsNext || 0, it.hlsTotal] : null,
        yt: it.ytdlp ? it.yt || null : null,
        speed: it.ytdlp ? (it.status === 'downloading' && it.yt?.speedBps) || 0 : this.speeds.get(it.id)?.speed || 0,
      })),
    };
  }

  save() {
    const items = this.items.map(({ ...it }) => ({ ...it, segments: it.segments?.map(({ start, pos, end }) => ({ start, pos, end: end === Infinity ? null : end })) }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ settings: this.settings, items }));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  close() {
    clearInterval(this.timer);
    for (const dl of this.running.values()) dl.pause();
    for (const it of this.items) if (it.status === 'downloading') it.status = 'queued';
    this.save();
  }
}

module.exports = { Manager, categoryOf, isDownloadLink };
