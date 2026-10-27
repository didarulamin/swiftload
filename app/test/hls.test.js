'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { HlsDownload } = require('../engine/hls');

const SEGS = Array.from({ length: 12 }, () => crypto.randomBytes(200 * 1024));
const ALL = Buffer.concat(SEGS);
const media = (extra = '', end = '#EXT-X-ENDLIST') =>
  ['#EXTM3U', '#EXT-X-TARGETDURATION:4', extra, ...SEGS.flatMap((_, i) => ['#EXTINF:4,', `seg${i}.ts`]), end].join('\n');

const server = http.createServer((req, res) => {
  const u = req.url;
  const send = (body, delay = 0) => setTimeout(() => res.end(body), delay);
  if (u === '/master.m3u8') return send('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nlow/media.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nhi/media.m3u8\n');
  if (u === '/hi/media.m3u8' || u === '/slow/media.m3u8') return send(media());
  if (u === '/low/media.m3u8') return send(media().replace(/seg/g, 'wrong'));
  if (u === '/enc.m3u8') return send(media('#EXT-X-KEY:METHOD=AES-128,URI="k"'));
  if (u === '/live.m3u8') return send(media('', ''));
  const m = /^\/(hi|slow)\/seg(\d+)\.ts$/.exec(u);
  if (m) return send(SEGS[Number(m[2])], m[1] === 'slow' ? 60 : 0);
  res.writeHead(404).end();
});

let base, dir;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftload-hls-'));
});
test.after(() => server.close());

function run(item) {
  const d = new HlsDownload(item, { connections: 4, dirFor: () => dir });
  return { d, done: new Promise((res, rej) => { d.on('done', res); d.on('error', rej); d.start(); }) };
}

test('master playlist: best variant, segments joined in order', async () => {
  const item = { url: `${base}/master.m3u8`, name: 'My Video' };
  await run(item).done;
  assert.strictEqual(path.basename(item.file), 'My Video.ts'); // random bytes: ffmpeg remux fails, .ts kept
  assert.ok(fs.readFileSync(item.file).equals(ALL));
});

test('pause and resume continues from saved part', async () => {
  const item = { url: `${base}/slow/media.m3u8` };
  const first = run(item);
  first.done.catch(() => {});
  while ((item.hlsNext || 0) < 4) await new Promise((r) => setTimeout(r, 20));
  first.d.pause();
  await new Promise((r) => setTimeout(r, 100));
  const saved = JSON.parse(JSON.stringify(item));
  assert.ok(saved.hlsNext < SEGS.length);
  await run(saved).done;
  assert.ok(fs.readFileSync(saved.file).equals(ALL));
});

test('encrypted and live streams are rejected', async () => {
  await assert.rejects(run({ url: `${base}/enc.m3u8` }).done, /Encrypted/);
  await assert.rejects(run({ url: `${base}/live.m3u8` }).done, /Live/);
});
