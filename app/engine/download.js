'use strict';
// Segmented HTTP(S) downloader:
// probe on one connection, add connections by splitting the largest
// remaining segment, resume with Range + If-Range.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const MIN_SPLIT = 512 * 1024; // don't split segments smaller than 2x this
const MAX_RETRIES = 5;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared virtual-clock limiter: each take() reserves a time slot, so all
// segment streams together stay under `rate` bytes/s. rate 0 = unlimited.
class Limiter {
  constructor(rate = 0) { this.rate = rate; this.next = 0; }
  async take(n) {
    if (!this.rate) return;
    const now = Date.now();
    this.next = Math.max(this.next, now);
    const wait = this.next - now;
    this.next += (n / this.rate) * 1000;
    if (wait > 0) await sleep(wait);
  }
}

function get(url, headers, redirects = 10) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error(`Unsupported protocol ${u.protocol}`));
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new Error('Too many redirects'));
        return resolve(get(new URL(res.headers.location, u).href, headers, redirects - 1));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Connection timed out')));
  });
}

function filenameFrom(res, url) {
  const cd = res.headers['content-disposition'] || '';
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  let name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : '';
  if (!name) { try { name = decodeURIComponent(path.posix.basename(new URL(url).pathname)); } catch { name = ''; } }
  name = name.replace(/[/\\:\0]/g, '_').trim();
  return name || 'download';
}

async function uniquePath(p) {
  const { dir, name, ext } = path.parse(p);
  for (let i = 0; ; i++) {
    const candidate = i ? path.join(dir, `${name} (${i})${ext}`) : p;
    try { await fs.access(candidate); } catch { return candidate; }
  }
}

// item: persisted plain object { url, dir?, name?, file?, size, segments, etag, lastModified, headers }
// opts.dirFor(name) picks the folder when item.dir is unset.
class Download extends EventEmitter {
  constructor(item, { connections = 8, limiter = new Limiter(), dirFor } = {}) {
    super();
    this.item = item;
    this.connections = connections;
    this.limiter = limiter;
    this.dirFor = dirFor || (() => process.cwd());
    this.active = new Set(); // live responses
    this.stopped = false;
  }

  get done() {
    const segs = this.item.segments || [];
    return segs.reduce((n, s) => n + (s.pos - s.start), 0);
  }

  headers(extra = {}) {
    const h = { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...extra };
    const { referer, cookie } = this.item.headers || {};
    if (referer) h.Referer = referer;
    if (cookie) h.Cookie = cookie;
    return h;
  }

  async start() {
    this.stopped = this.paused = false;
    const it = this.item;
    try {
      let first = null;
      if (!it.segments) first = await this.probe();
      else if (!it.ranges) { // can't resume without range support: start over
        it.segments = null;
        first = await this.probe();
      }
      this.fh = await fs.open(it.file + '.part', first ? 'w' : 'r+');
      if (it.size > 0 && first) await this.fh.truncate(it.size);
      for (const s of it.segments) s.busy = false;
      this.workers = new Set();
      if (first) this.spawn(it.segments[0], first);
      this.fill();
      while (this.workers.size) await Promise.all([...this.workers]); // workers may spawn workers
      await this.fh.close();
      this.fh = null;
      if (this.paused) return;
      const incomplete = it.segments.some((s) => s.pos <= s.end && s.end !== Infinity);
      if (incomplete) throw this.lastError || new Error('Download incomplete');
      const final = await uniquePath(it.file);
      await fs.rename(it.file + '.part', final);
      it.file = final;
      it.name = path.basename(final);
      this.emit('done');
    } catch (err) {
      if (this.fh) await this.fh.close().catch(() => {});
      this.fh = null;
      this.stop();
      this.emit('error', err);
    }
  }

  async probe() {
    const it = this.item;
    const res = await get(it.url, this.headers({ Range: 'bytes=0-' }));
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode}`);
    }
    const total = /\/(\d+)$/.exec(res.headers['content-range'] || '');
    it.ranges = res.statusCode === 206;
    it.size = total ? Number(total[1]) : Number(res.headers['content-length'] || -1);
    it.etag = res.headers.etag || null;
    it.lastModified = res.headers['last-modified'] || null;
    it.name = it.name || filenameFrom(res, it.url);
    it.dir = it.dir || this.dirFor(it.name);
    await fs.mkdir(it.dir, { recursive: true });
    it.file = await uniquePath(path.join(it.dir, it.name));
    it.segments = [{ start: 0, pos: 0, end: it.size > 0 ? it.size - 1 : Infinity }];
    this.emit('meta');
    return res;
  }

  // Open connections up to the limit: resume unfinished segments first, then split.
  fill() {
    if (this.stopped || !this.item.ranges) return;
    for (const s of this.item.segments) {
      if (this.workers.size >= this.connections) break;
      if (s.pos <= s.end && !s.busy) this.spawn(s);
    }
    while (this.workers.size < this.connections && this.split()) {}
  }

  split() {
    if (!(this.item.size > 0)) return false;
    let big = null;
    for (const s of this.item.segments) if (s.busy && s.end - s.pos > (big ? big.end - big.pos : 2 * MIN_SPLIT)) big = s;
    if (!big) return false;
    const mid = big.pos + Math.floor((big.end - big.pos + 1) / 2);
    const seg = { start: mid, pos: mid, end: big.end };
    big.end = mid - 1; // the running stream stops itself when it reaches this
    this.item.segments.push(seg);
    this.spawn(seg);
    return true;
  }

  spawn(seg, res) {
    seg.busy = true;
    const w = this.work(seg, res).finally(() => {
      seg.busy = false;
      this.workers.delete(w);
      if (!this.stopped) this.fill();
    });
    this.workers.add(w);
  }

  async work(seg, res) {
    const it = this.item;
    for (let attempt = 0; seg.pos <= seg.end && !this.stopped; attempt++) {
      try {
        if (!res) {
          const h = it.ranges ? { Range: `bytes=${seg.pos}-${seg.end === Infinity ? '' : seg.end}` } : {};
          if (it.ranges && (it.etag || it.lastModified)) h['If-Range'] = it.etag || it.lastModified;
          res = await get(it.url, this.headers(h));
          if (it.ranges && res.statusCode === 200) { res.resume(); throw Object.assign(new Error('File changed on server, restart the download'), { fatal: true }); }
          if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
        }
        this.active.add(res);
        for await (const chunk of res) {
          if (this.stopped) break;
          const n = Math.min(chunk.length, seg.end - seg.pos + 1);
          if (n <= 0) break;
          await this.limiter.take(n);
          await this.fh.write(chunk, 0, n, seg.pos);
          seg.pos += n;
          if (seg.pos > seg.end) break;
        }
        this.active.delete(res);
        res.destroy();
        res = null;
        if (seg.end === Infinity && !this.stopped) { seg.end = seg.pos - 1; it.size = seg.pos; } // unknown size: EOF = done
      } catch (err) {
        if (res) { this.active.delete(res); res.destroy(); res = null; }
        this.lastError = err;
        if (err.fatal || !it.ranges || attempt >= MAX_RETRIES) { this.stop(); return; }
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  pause() {
    this.paused = true;
    this.stop();
  }

  stop() {
    this.stopped = true;
    for (const r of this.active) r.destroy();
    this.active.clear();
  }
}

module.exports = { Download, Limiter, filenameFrom, get, uniquePath, sleep, MAX_RETRIES };
