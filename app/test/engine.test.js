'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Download, Limiter } = require('../engine/download');
const { categoryOf } = require('../engine/queue');

const DATA = crypto.randomBytes(6 * 1024 * 1024 + 123);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Serves DATA; /norange ignores Range; /slow dribbles so tests can pause mid-way.
const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const ranges = !req.url.startsWith('/norange');
  let start = 0, end = DATA.length - 1;
  const headers = { 'Content-Type': 'application/octet-stream', ETag: '"v1"' };
  if (ranges && m) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), end);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': DATA.length });
  }
  const body = DATA.subarray(start, end + 1);
  if (!req.url.startsWith('/slow')) return res.end(body);
  let off = 0;
  const t = setInterval(() => {
    if (res.destroyed || off >= body.length) { clearInterval(t); return res.end(); }
    res.write(body.subarray(off, off += 64 * 1024));
  }, 5);
  res.on('close', () => clearInterval(t));
});

let base, dir;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftload-'));
});
test.after(() => server.close());

function run(item, opts) {
  const d = new Download(item, { dirFor: () => dir, ...opts });
  return { d, done: new Promise((res, rej) => { d.on('done', res); d.on('error', rej); d.start(); }) };
}

test('segmented download is byte-exact', async () => {
  const item = { url: `${base}/file.bin` };
  const { done } = run(item, { connections: 8 });
  await done;
  assert.ok(item.segments.length > 1, 'used several connections');
  assert.strictEqual(sha(fs.readFileSync(item.file)), sha(DATA));
});

test('pause and resume from saved state', async () => {
  const item = { url: `${base}/slow/resume.bin` };
  const first = run(item, { connections: 4 });
  first.done.catch(() => {});
  while (first.d.done < DATA.length / 4) await new Promise((r) => setTimeout(r, 20));
  first.d.pause();
  await new Promise((r) => setTimeout(r, 100));
  const saved = JSON.parse(JSON.stringify(item)); // what the store would persist
  assert.ok(saved.segments.some((s) => s.pos <= s.end), 'paused before finishing');
  const second = run(saved, { connections: 4 });
  await second.done;
  assert.strictEqual(sha(fs.readFileSync(saved.file)), sha(DATA));
});

test('server without Range falls back to one connection', async () => {
  const item = { url: `${base}/norange/plain.bin` };
  await run(item, { connections: 8 }).done;
  assert.strictEqual(item.ranges, false);
  assert.strictEqual(item.segments.length, 1);
  assert.strictEqual(sha(fs.readFileSync(item.file)), sha(DATA));
});

test('speed limit holds the rate', async () => {
  const item = { url: `${base}/limited.bin` };
  const rate = 8 * 1024 * 1024; // 6 MB file at 8 MB/s ≈ 0.75s
  const t0 = Date.now();
  await run(item, { connections: 4, limiter: new Limiter(rate) }).done;
  const secs = (Date.now() - t0) / 1000;
  const expected = DATA.length / rate;
  assert.ok(secs > expected * 0.8 && secs < expected * 1.6, `took ${secs}s, expected ~${expected}s`);
});

test('existing file gets a unique name', async () => {
  const a = { url: `${base}/dupe.bin` }, b = { url: `${base}/dupe.bin` };
  await run(a).done;
  await run(b).done;
  assert.notStrictEqual(a.file, b.file);
  assert.match(path.basename(b.file), /^dupe \(1\)\.bin$/);
});

test('categories by extension', () => {
  assert.strictEqual(categoryOf('a.MP4'), 'Video');
  assert.strictEqual(categoryOf('x.tar.gz'), 'Compressed');
  assert.strictEqual(categoryOf('song.mp3'), 'Music');
  assert.strictEqual(categoryOf('setup.dmg'), 'Programs');
  assert.strictEqual(categoryOf('README'), 'General');
});
