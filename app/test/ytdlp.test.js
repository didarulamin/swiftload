'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { YtdlpDownload, isVideoSite, parseProgress, buildArgs } = require('../engine/ytdlp');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftload-ytdlp-'));

// Fake yt-dlp: logs its args, prints progress like the real one, writes the output file.
// FAIL=1 makes it exit like a blocked video.
const fake = path.join(dir, 'yt-dlp');
fs.writeFileSync(fake, `#!/bin/sh
echo "$@" > "${dir}/args.txt"
[ -n "$FAIL" ] && { echo "ERROR: [youtube] abc: Video unavailable" >&2; exit 1; }
out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
echo "SWIFTLOAD_TITLE My Clip"
echo "[download]  42.0% of   10.00MiB at    2.00MiB/s ETA 00:03"
echo "[download] 100% of   10.00MiB in 00:00:05 at 2.00MiB/s"
echo "[Merger] Merging formats into \\"x\\""
f="$(dirname "$out")/My Clip.mp4"; printf 'video' > "$f"
echo "SWIFTLOAD_FILE $f"
`, { mode: 0o755 });

function run(item, opts = {}) {
  const d = new YtdlpDownload(item, { bin: fake, dirFor: (n) => path.join(dir, n.endsWith('.mp3') ? 'Music' : 'Video'), ...opts });
  return new Promise((res, rej) => { d.on('done', res); d.on('error', rej); d.start(); });
}

test('video sites detected, others not', () => {
  assert.ok(isVideoSite('https://www.youtube.com/watch?v=x'));
  assert.ok(isVideoSite('https://youtu.be/x'));
  assert.ok(isVideoSite('https://web.facebook.com/reel/1'));
  assert.ok(isVideoSite('https://www.tiktok.com/@a/video/1'));
  assert.ok(!isVideoSite('https://notyoutube.com/x'));
  assert.ok(!isVideoSite('https://cdn.example.com/v.mp4'));
});

test('progress lines parsed', () => {
  assert.deepStrictEqual(parseProgress('[download]  42.0% of   10.00MiB at    2.00MiB/s ETA 00:03'),
    { stage: 'download', percent: 42, total: '10.00MiB', speed: '2.00MiB/s', eta: '00:03' });
  assert.strictEqual(parseProgress('[Merger] Merging formats into "a.mp4"').stage, 'merging');
  assert.strictEqual(parseProgress('[youtube] abc: Downloading webpage'), null);
});

test('args per quality and speed limit', () => {
  const base = { url: 'https://youtu.be/x', dir: '/d' };
  const a720 = buildArgs({ ...base, ytdlp: { quality: '720' } }, { speedLimit: 500, ffmpeg: null }).join(' ');
  assert.match(a720, /-S res:720,vcodec:h264,acodec:m4a/);
  assert.match(a720, /--limit-rate 500K/);
  assert.match(a720, /-- https:\/\/youtu\.be\/x$/);
  const best = buildArgs({ ...base, ytdlp: { quality: 'best' } }, { ffmpeg: null }).join(' ');
  assert.match(best, /-S vcodec:h264,acodec:m4a/);
  const mp3 = buildArgs({ ...base, ytdlp: { quality: 'mp3' } }, { ffmpeg: null }).join(' ');
  assert.match(mp3, /-x --audio-format mp3/);
  assert.doesNotMatch(mp3, /merge-output-format/);
});

test('download sets file, name, size, progress', async () => {
  const item = { url: 'https://www.youtube.com/watch?v=x', ytdlp: { quality: '720' } };
  await run(item);
  assert.strictEqual(item.file, path.join(dir, 'Video', 'My Clip.mp4'));
  assert.strictEqual(item.name, 'My Clip.mp4');
  assert.strictEqual(item.size, 5);
  assert.deepStrictEqual(item.yt, { stage: 'done', percent: 100 });
});

test('yt-dlp error is reported', async () => {
  process.env.FAIL = '1';
  try {
    await assert.rejects(run({ url: 'https://youtu.be/x', ytdlp: { quality: 'best' } }), /Video unavailable/);
  } finally {
    delete process.env.FAIL;
  }
});

test('missing yt-dlp gives install hint', async () => {
  await assert.rejects(run({ url: 'https://youtu.be/x', ytdlp: { quality: 'best' } }, { bin: null }), /brew install yt-dlp/);
});
