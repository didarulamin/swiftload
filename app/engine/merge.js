'use strict';
// Sites that stream video and audio as separate files (DASH-style, e.g. Facebook):
// download both tracks with the normal engine, then mux losslessly with ffmpeg.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Download, uniquePath } = require('./download');
const { FFMPEG } = require('./hls');

const bytes = (t) => (t.segments || []).reduce((n, s) => n + (s.pos - s.start), 0);

class MergeDownload extends EventEmitter {
  constructor(item, opts = {}) {
    super();
    this.item = item;
    this.opts = opts;
    this.ffmpeg = opts.ffmpeg === undefined ? FFMPEG : opts.ffmpeg;
  }

  get done() { return (this.item.tracks || []).reduce((n, t) => n + bytes(t), 0); }

  pause() {
    this.paused = true;
    this.current?.pause();
  }

  async start() {
    this.paused = false;
    const it = this.item;
    try {
      if (!this.ffmpeg) throw new Error('Merging video and audio needs ffmpeg (brew install ffmpeg)');
      const base = (it.name || 'video').replace(/\.\w{2,4}$/, '');
      it.name = `${base}.mp4`;
      it.dir = it.dir || (this.opts.dirFor || (() => process.cwd()))(it.name);
      it.tracks = it.tracks || [
        { url: it.url, name: `${base}.video.tmp`, dir: it.dir, headers: it.headers },
        { url: it.audioUrl, name: `${base}.audio.tmp`, dir: it.dir, headers: it.headers },
      ];
      for (const t of it.tracks) {
        if (t.complete) continue;
        await new Promise((resolve, reject) => {
          const dl = (this.current = new Download(t, this.opts));
          dl.on('done', resolve);
          dl.on('error', reject);
          dl.start().then(() => { if (this.paused) resolve(); }); // pause ends start() without an event
        });
        if (this.paused) return;
        t.complete = true;
      }
      const out = await uniquePath(path.join(it.dir, it.name));
      const [v, a] = it.tracks.map((t) => t.file);
      await new Promise((resolve, reject) => execFile(this.ffmpeg,
        ['-v', 'error', '-i', v, '-i', a, '-map', '0', '-map', '1', '-c', 'copy', '-movflags', '+faststart', out],
        (err, _out, stderr) => (err ? reject(new Error(`ffmpeg: ${stderr.trim().split('\n').pop() || err.message}`)) : resolve())));
      for (const t of it.tracks) await fs.rm(t.file, { force: true });
      it.file = out;
      it.name = path.basename(out);
      it.size = (await fs.stat(out)).size;
      this.emit('done');
    } catch (err) {
      if (!this.paused) this.emit('error', err);
    }
  }
}

module.exports = { MergeDownload, bytes };
