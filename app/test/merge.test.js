'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MergeDownload } = require('../engine/merge');
const { FFMPEG } = require('../engine/hls');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftload-merge-'));
let server, base;

test.before(async () => {
  if (!FFMPEG) return;
  // Real 2s video-only and audio-only tracks, like a DASH site serves them.
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=25', '-c:v', 'libx264', '-an', path.join(dir, 'v.mp4')]);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:a', 'aac', '-vn', path.join(dir, 'a.m4a')]);
  server = http.createServer((req, res) => {
    const data = fs.readFileSync(path.join(dir, req.url === '/v' ? 'v.mp4' : 'a.m4a'));
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { 'Content-Length': data.length - start, ...(m && { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` }) });
    res.end(data.subarray(start));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

function run(item, opts = {}) {
  const d = new MergeDownload(item, { dirFor: () => path.join(dir, 'out'), ...opts });
  return new Promise((res, rej) => { d.on('done', res); d.on('error', rej); d.start(); });
}

test('video + audio tracks merge into one mp4', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  const item = { url: `${base}/v`, audioUrl: `${base}/a`, name: 'Clip' };
  await run(item);
  assert.strictEqual(path.basename(item.file), 'Clip.mp4');
  const streams = execFileSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', item.file]).toString().split('\n').filter(Boolean).sort();
  assert.deepStrictEqual(streams, ['audio', 'video']);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(item.file)), ['Clip.mp4'], 'temp tracks removed');
});

test('clear error without ffmpeg', async () => {
  await assert.rejects(run({ url: 'http://127.0.0.1:1/v', audioUrl: 'http://127.0.0.1:1/a' }, { ffmpeg: null }), /needs ffmpeg/);
});
