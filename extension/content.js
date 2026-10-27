// Floating "Download video" button over the hovered <video>. Lives in a shadow root so page CSS can't touch it.
(() => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;display:none';
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet(); // adopted sheets aren't blocked by the page's CSP, unlike <style>
  sheet.replaceSync(`
      button, li { font: 12px -apple-system, BlinkMacSystemFont, sans-serif; }
      button { background: #0a7cff; color: #fff; border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
      ul { list-style: none; margin: 4px 0 0; padding: 4px; background: #fff; color: #1d1d1f; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.3); max-width: 340px; }
      li { padding: 6px 8px; border-radius: 5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      li:hover { background: #e6f0ff; }
      li.muted { color: #86868b; cursor: default; }
      li.muted:hover { background: none; }`);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `
    <button>⬇ Download video</button>
    <ul hidden></ul>`;
  const btn = root.querySelector('button');
  const menu = root.querySelector('ul');
  let video = null;
  let hideTimer = 0;

  function place() {
    if (!video) return;
    const r = video.getBoundingClientRect();
    host.style.top = `${Math.max(0, r.top + 8)}px`;
    host.style.left = `${Math.max(0, r.right - 150)}px`;
  }

  function show(v) {
    clearTimeout(hideTimer);
    if (video !== v) menu.hidden = true;
    video = v;
    place();
    host.style.display = 'block';
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (menu.hidden) host.style.display = 'none'; }, 1500);
  }

  function item(text, muted, onclick) {
    const li = document.createElement('li');
    li.textContent = text;
    if (muted) li.className = 'muted';
    if (onclick) li.onclick = onclick;
    return li;
  }

  const QUALITIES = [['best', 'Best quality'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['mp3', 'MP3 audio']];

  async function grab(media) {
    const r = await chrome.runtime.sendMessage({ type: 'grab', media, title: document.title });
    menu.replaceChildren(item(r?.ok ? 'Sent to Swiftload ✓' : 'Swiftload app is not running', true));
    setTimeout(() => { menu.hidden = true; host.style.display = 'none'; }, 1500);
  }

  btn.onclick = async () => {
    if (!menu.hidden) { menu.hidden = true; return; }
    // These sites go through yt-dlp in the app: send the page URL with a quality.
    if (/(^|\.)(youtube\.com|youtu\.be|facebook\.com|fb\.watch|instagram\.com|tiktok\.com)$/.test(location.hostname)) {
      menu.replaceChildren(...QUALITIES.map(([quality, text]) => item(text, false, () => grab({ kind: 'ytdlp', url: location.href, quality }))));
      menu.hidden = false;
      return;
    }
    const list = await chrome.runtime.sendMessage({ type: 'list', src: video?.currentSrc || '' });
    menu.replaceChildren(...(list.length
      ? list.map((m) => item(`${m.label} — ${new URL(m.url).pathname.split('/').pop() || m.url}`, false, () => grab(m)))
      : [item('No video found yet. Play the video for a moment, then try again.', true)]));
    menu.hidden = false;
  };

  document.addEventListener('mouseover', (e) => {
    const v = e.target.closest?.('video') || [...document.querySelectorAll('video')].find((x) => {
      const r = x.getBoundingClientRect();
      return r.width > 160 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (v && v.getBoundingClientRect().width > 160) show(v);
    else if (!host.contains(e.target) && e.target !== host) hideSoon();
  }, { passive: true });
  host.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  window.addEventListener('scroll', place, { passive: true });
  window.addEventListener('resize', place, { passive: true });
  document.documentElement.appendChild(host);
})();
