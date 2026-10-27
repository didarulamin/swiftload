'use strict';
// HLS (.m3u8) download: pick the highest-bandwidth variant, fetch segments in
// parallel, append them in order into one .ts (or .mp4 for fMP4) file.
// Not supported: encrypted streams, live streams, byte-range playlists.
// ponytail: separate audio renditions (#EXT-X-MEDIA) are ignored, so some sites give video-only; needs ffmpeg muxing.
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { Download, get, uniquePath, sleep, MAX_RETRIES } = require('./download');

// QuickTime can't play .ts, so remux to .mp4 when ffmpeg is installed (lossless, ~1s).
// Apps launched from Finder don't get the shell PATH, hence the fixed locations.
// Windows: winget/scoop/choco put tools on PATH.
function findBin(name) {
  const dirs = process.platform === 'win32' ? (process.env.PATH || '').split(';') : ['/opt/homebrew/bin', '/usr/local/bin'];
  return dirs.map((d) => path.join(d, process.platform === 'win32' ? `${name}.exe` : name)).find((p) => existsSync(p));
}

const FFMPEG = findBin('ffmpeg');

async function remux(ts) {
  if (!FFMPEG || !ts.endsWith('.ts')) return ts;
  const mp4 = await uniquePath(ts.replace(/\.ts$/, '.mp4'));
  const ok = await new Promise((r) => execFile(FFMPEG, ['-v', 'error', '-i', ts, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', mp4], (err) => r(!err)));
  if (!ok) { await fs.rm(mp4, { force: true }); return ts; } // keep the .ts
  await fs.rm(ts);
  return mp4;
}

function parse(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist');
  const abs = (u) => new URL(u, base).href;
  const out = { variants: [], segments: [], init: null, encrypted: false, ended: false, byterange: false };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF')) {
      const bw = /BANDWIDTH=(\d+)/.exec(l);
      if (lines[i + 1]) out.variants.push({ bw: bw ? Number(bw[1]) : 0, url: abs(lines[++i]) });
    } else if (l.startsWith('#EXT-X-KEY')) {
      if (!/METHOD=NONE/.test(l)) out.encrypted = true;
    } else if (l.startsWith('#EXT-X-MAP')) {
      const m = /URI="([^"]+)"/.exec(l);
      if (m) out.init = abs(m[1]);
    } else if (l.startsWith('#EXT-X-BYTERANGE')) out.byterange = true;
    else if (l === '#EXT-X-ENDLIST') out.ended = true;
    else if (!l.startsWith('#')) out.segments.push(abs(l));
  }
  return out;
}

class HlsDownload extends Download {
  get done() { return this.item.hlsBytes || 0; }

  async fetch(url) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await get(url, this.headers());
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        this.active.add(res);
        const chunks = [];
        for await (const c of res) {
          if (this.stopped) break;
          await this.limiter.take(c.length);
          chunks.push(c);
        }
        if (this.stopped) throw new Error('stopped');
        return Buffer.concat(chunks);
      } catch (err) {
        if (this.stopped || attempt >= MAX_RETRIES) throw err;
        await sleep(1000 * 2 ** attempt);
      } finally {
        if (res) { this.active.delete(res); res.destroy(); }
      }
    }
  }

  async playlist(url) {
    return parse((await this.fetch(url)).toString('utf8'), url);
  }

  async start() {
    this.stopped = this.paused = false;
    const it = this.item;
    try {
      let list = await this.playlist(it.mediaUrl || it.url);
      if (list.variants.length) {
        it.mediaUrl = list.variants.sort((a, b) => b.bw - a.bw)[0].url;
        list = await this.playlist(it.mediaUrl);
      }
      if (list.encrypted) throw new Error('Encrypted HLS streams are not supported');
      if (!list.ended) throw new Error('Live streams are not supported');
      if (list.byterange) throw new Error('Byte-range HLS playlists are not supported');
      if (!list.segments.length) throw new Error('Playlist has no segments');
      const parts = list.init ? [list.init, ...list.segments] : list.segments;

      if (!it.file) {
        const base = it.name || path.posix.basename(new URL(it.url).pathname) || 'video';
        it.name = base.replace(/\.(m3u8|ts|mp4)$/i, '') + (list.init ? '.mp4' : '.ts');
        it.dir = it.dir || this.dirFor(it.name);
        await fs.mkdir(it.dir, { recursive: true });
        it.file = await uniquePath(path.join(it.dir, it.name));
        it.hlsNext = 0;
        it.hlsBytes = 0;
        this.emit('meta');
      }
      it.hlsTotal = parts.length;

      this.fh = await fs.open(it.file + '.part', it.hlsNext ? 'r+' : 'w');
      await this.fh.truncate(it.hlsBytes); // drop anything written after the last saved part
      const pending = new Map(); // part index -> Promise<Buffer>
      let ahead = it.hlsNext;
      while (it.hlsNext < parts.length) {
        while (ahead < parts.length && ahead - it.hlsNext < this.connections) {
          const p = this.fetch(parts[ahead]);
          p.catch(() => {}); // awaited below in order
          pending.set(ahead++, p);
        }
        const buf = await pending.get(it.hlsNext);
        pending.delete(it.hlsNext);
        await this.fh.write(buf, 0, buf.length, it.hlsBytes);
        it.hlsBytes += buf.length;
        it.hlsNext++;
      }
      await this.fh.close();
      this.fh = null;
      it.size = it.hlsBytes;
      let final = await uniquePath(it.file);
      await fs.rename(it.file + '.part', final);
      final = await remux(final);
      it.size = (await fs.stat(final)).size;
      it.file = final;
      it.name = path.basename(final);
      this.emit('done');
    } catch (err) {
      if (this.fh) await this.fh.close().catch(() => {});
      this.fh = null;
      if (this.paused) return;
      this.stop();
      this.emit('error', err);
    }
  }
}

module.exports = { HlsDownload, parse, FFMPEG, findBin };
