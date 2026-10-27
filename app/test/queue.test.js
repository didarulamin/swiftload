'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Manager, isDownloadLink } = require('../engine/queue');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftload-queue-'));
let n = 0;

// maxActive 0 keeps everything queued, so no network is touched.
function manager() {
  const m = new Manager(path.join(dir, `state${n++}.json`));
  m.setSettings({ maxActive: 0 });
  clearInterval(m.timer);
  return m;
}

test('download links are recognised', () => {
  assert.ok(isDownloadLink('https://example.com/files/app.dmg'));
  assert.ok(isDownloadLink('  http://x.org/a%20b.zip  '));
  assert.ok(isDownloadLink('https://www.youtube.com/watch?v=abc'));
  assert.ok(!isDownloadLink('https://example.com/page'));
  assert.ok(!isDownloadLink('see https://example.com/a.zip'));
  assert.ok(!isDownloadLink('ftp://example.com/a.zip'));
  assert.ok(!isDownloadLink('hello'));
});

test('pause all, resume all', () => {
  const m = manager();
  const a = m.add({ url: 'https://example.com/a.zip' });
  const b = m.add({ url: 'https://example.com/b.zip' });
  m.pauseAll();
  assert.deepStrictEqual([m.find(a).status, m.find(b).status], ['paused', 'paused']);
  m.find(b).status = 'error';
  m.resumeAll();
  assert.deepStrictEqual([m.find(a).status, m.find(b).status], ['queued', 'queued']);
});

test('clear finished keeps the rest', () => {
  const m = manager();
  const a = m.add({ url: 'https://example.com/a.zip' });
  const b = m.add({ url: 'https://example.com/b.zip' });
  m.find(a).status = 'done';
  m.clearFinished();
  assert.deepStrictEqual(m.items.map((i) => i.id), [b]);
});

test('download again copies link and options into a new item', () => {
  const m = manager();
  const a = m.add({ url: 'https://www.youtube.com/watch?v=x', quality: '720', referer: 'https://r/' });
  const b = m.redownload(a);
  assert.notStrictEqual(a, b);
  assert.strictEqual(m.find(b).url, m.find(a).url);
  assert.deepStrictEqual(m.find(b).ytdlp, { quality: '720' });
  assert.strictEqual(m.find(b).headers.referer, 'https://r/');
});
