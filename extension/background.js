// Hands downloads and detected page media to the Swiftload app.
// If the app isn't running, the browser keeps the download.
const APP = 'http://127.0.0.1:47321/add';
const MIN_FILE = 100 * 1024; // smaller media is usually an ad/preview

async function sendToApp({ url, audioUrl, quality, filename, referrer, kind }) {
  const cookies = await chrome.cookies.getAll({ url });
  const res = await fetch(APP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, audioUrl, quality, filename, referrer, kind, cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') }),
  });
  return res.ok;
}

chrome.downloads.onCreated.addListener(async (item) => {
  const url = item.finalUrl || item.url;
  if (!/^https?:/.test(url)) return; // blob:, data:, file: stay in the browser
  try {
    const ok = await sendToApp({ url, referrer: item.referrer || '', filename: item.filename ? item.filename.split(/[\\/]/).pop() : '' });
    if (!ok) return;
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {
    // App not running.
  }
});

// --- Video grabber: remember media responses per tab (session storage survives worker restarts) ---

const key = (tabId) => `tab:${tabId}`;

// Some players (e.g. Facebook) fetch one file in pieces, with the byte window in the
// query string. Dropping those params gives the URL of the whole file.
const FRAGMENT_PARAMS = ['bytestart', 'byteend'];

function classify(details) {
  const h = Object.fromEntries((details.responseHeaders || []).map((x) => [x.name.toLowerCase(), x.value || '']));
  const type = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
  const u = new URL(details.url);
  const path = u.pathname.toLowerCase();
  if (/mpegurl/.test(type) || path.endsWith('.m3u8')) return { url: details.url, kind: 'hls', label: 'HLS stream' };
  if (type === 'video/mp2t' || /\.(ts|m4s|aac)$/.test(path)) return null; // stream segments
  if (!/^(video|audio)\//.test(type)) return null;
  const fragment = FRAGMENT_PARAMS.some((p) => u.searchParams.has(p));
  for (const p of FRAGMENT_PARAMS) u.searchParams.delete(p);
  const total = /\/(\d+)$/.exec(h['content-range'] || '');
  const size = total ? Number(total[1]) : fragment ? 0 : Number(h['content-length'] || 0);
  if (size && size < MIN_FILE) return null;
  const track = type.startsWith('audio/') ? 'audio' : 'video';
  const ext = (/\.(\w{2,4})$/.exec(path) || [, track === 'audio' ? 'm4a' : 'mp4'])[1];
  const what = fragment ? (track === 'audio' ? 'Audio track' : 'Video track (no sound?)') : ext.toUpperCase();
  return { url: u.href, type, kind: 'file', track, fragment, ext, label: `${what}${size ? ` · ${(size / 1048576).toFixed(1)} MB` : ''}` };
}

chrome.webRequest.onHeadersReceived.addListener(async (details) => {
  if (details.tabId < 0 || !/^https?:/.test(details.url)) return;
  const found = classify(details);
  if (!found) return;
  const k = key(details.tabId);
  const list = (await chrome.storage.session.get(k))[k] || [];
  // Ranged requests repeat the same URL; HLS players refetch playlists.
  if (list.some((m) => m.url === found.url)) return;
  list.push(found);
  await chrome.storage.session.set({ [k]: list.slice(-30) });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);

// New page in the tab = new media list.
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId >= 0) chrome.storage.session.remove(key(d.tabId));
}, { urls: ['<all_urls>'], types: ['main_frame'] });
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

const safeName = (s) => (s || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'video';

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  if (msg.type === 'list') {
    chrome.storage.session.get(key(tabId)).then((r) => {
      const list = r[key(tabId)] || [];
      // A <video src> pointing at a plain file counts even if we missed its request.
      if (msg.src && /^https?:/.test(msg.src) && !list.some((m) => m.url === msg.src)) {
        list.push({ url: msg.src, kind: 'file', ext: (/\.(\w{2,4})(\?|$)/.exec(msg.src) || [, 'mp4'])[1], label: 'Video source' });
      }
      const out = list.slice().reverse(); // newest first
      // Separate video + audio tracks: offer both merged (the newest of each = what's playing).
      const v = out.find((m) => m.fragment && m.track === 'video');
      const a = out.find((m) => m.fragment && m.track === 'audio');
      if (v && a) out.unshift({ kind: 'merge', url: v.url, audioUrl: a.url, label: 'Video + audio (merged)' });
      reply(out);
    });
    return true;
  }
  if (msg.type === 'grab') {
    const m = msg.media;
    const filename = m.kind === 'ytdlp' ? '' : safeName(msg.title) + (m.kind === 'file' ? `.${m.ext}` : ''); // yt-dlp names by title
    sendToApp({ url: m.url, audioUrl: m.audioUrl, quality: m.quality, filename, referrer: sender.tab?.url || '', kind: m.kind })
      .then((ok) => reply({ ok }), () => reply({ ok: false }));
    return true;
  }
});
