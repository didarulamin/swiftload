'use strict';
const $ = (id) => document.getElementById(id);
if (new URLSearchParams(location.search).get('platform') === 'darwin') document.body.classList.add('mac');

let state = { items: [], settings: {} };
let filter = 'all';
let query = '';
let sort = { key: 'added', dir: -1 };
try { sort = JSON.parse(localStorage.getItem('sort')) || sort; } catch {}
const selected = new Set();
let anchor = null; // for Shift-click ranges
let order = []; // ids in display order
// Rows are created once and updated in place. Rebuilding them every second
// broke double-click (its two clicks landed on different elements).
const rows = new Map(); // id -> { tr, icon, name, size, bar, label, speed, eta, added }

const fmtBytes = (n) => {
  if (!(n >= 0)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtTime = (s) => {
  if (!isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
};
const set = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const find = (id) => state.items.find((i) => i.id === id);
const sel = () => [...selected].map(find).filter(Boolean);

// yt-dlp downloads video and audio as separate tracks, then merges.
function ytLabel(yt) {
  if (yt.stage === 'merging') return 'Merging…';
  if (yt.stage === 'converting') return 'Converting…';
  if (yt.stage !== 'download') return 'Starting…';
  return `${yt.percent.toFixed(1)}%${yt.part ? ' · audio' : ''}`;
}

const CATEGORY_ICON = { Video: '🎬', Music: '🎵', Documents: '📄', Compressed: '🗜️', Programs: '💿', General: '📦' };
const icons = new Map(); // extension -> data URL | Promise
function iconFor(it, el) {
  const ext = (it.name || '').split('.').pop().toLowerCase();
  const cached = icons.get(ext);
  if (typeof cached === 'string') return showIcon(el, cached);
  if (!cached) set(el, CATEGORY_ICON[it.category] || '📦');
  if (it.status === 'done' && it.file && !cached) {
    icons.set(ext, window.api.icon(it.id).then((url) => {
      if (url) { icons.set(ext, url); render(); } else icons.delete(ext);
    }, () => icons.delete(ext)));
  }
}
function showIcon(el, url) {
  if (el.firstChild?.tagName === 'IMG' && el.firstChild.src === url) return;
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  el.replaceChildren(img);
}

function makeRow(id) {
  const tr = document.createElement('tr');
  tr.dataset.id = id;
  const td = (cls) => { const c = document.createElement('td'); c.className = cls; tr.append(c); return c; };
  const nameTd = td('name');
  const icon = document.createElement('span');
  icon.className = 'icon';
  const name = document.createElement('span');
  name.className = 'fname';
  nameTd.append(icon, name);
  const size = td('num');
  const prog = td('progress');
  const bar = document.createElement('div');
  const label = document.createElement('span');
  prog.append(bar, label);
  const r = { tr, icon, name, size, bar, label, speed: td('num'), eta: td('num'), added: td('muted') };
  rows.set(id, r);
  return r;
}

function updateRow(r, it) {
  const yt = it.status === 'downloading' && it.yt;
  const pct = yt ? yt.percent || 0 : it.size > 0 ? Math.min(100, (it.done / it.size) * 100) : it.parts ? (it.parts[0] / it.parts[1]) * 100 : 0;
  const label = yt ? ytLabel(yt)
    : it.status === 'downloading' ? (it.size > 0 || it.parts ? `${pct.toFixed(1)}%` : fmtBytes(it.done))
    : it.status === 'error' ? `Error: ${it.error}` : it.status === 'done' ? 'Completed' : it.status[0].toUpperCase() + it.status.slice(1);
  iconFor(it, r.icon);
  set(r.name, it.name || it.url);
  r.name.classList.toggle('link', it.status === 'done');
  r.name.title = it.status === 'done' ? `Open ${it.name}\n${it.url}` : it.url;
  set(r.size, it.size > 0 ? fmtBytes(it.size) : it.parts ? fmtBytes(it.done) : '—');
  r.bar.className = `bar ${it.status}`;
  r.bar.style.setProperty('--p', `${it.status === 'done' ? 100 : pct}%`);
  set(r.label, label);
  r.label.title = label;
  set(r.speed, it.status === 'downloading' ? `${fmtBytes(it.speed)}/s` : '');
  set(r.eta, yt ? (yt.eta && yt.eta !== 'Unknown' ? yt.eta : '') : it.status === 'downloading' && it.speed && it.size > 0 ? fmtTime((it.size - it.done) / it.speed) : '');
  set(r.added, new Date(it.added).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }));
  r.tr.classList.toggle('selected', selected.has(it.id));
}

function visible(it) {
  if (query && !`${it.name || ''} ${it.url}`.toLowerCase().includes(query)) return false;
  if (filter === 'all') return true;
  if (filter === 'finished') return it.status === 'done';
  if (filter === 'unfinished') return it.status !== 'done';
  return it.category === filter.slice(4);
}

function compare(a, b) {
  const k = sort.key;
  const va = k === 'name' ? (a.name || a.url).toLowerCase() : k === 'size' ? a.size : a.added;
  const vb = k === 'name' ? (b.name || b.url).toLowerCase() : k === 'size' ? b.size : b.added;
  return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
}

function render() {
  const items = state.items.filter(visible).sort(compare);
  order = items.map((it) => it.id);
  const tbody = $('rows');
  items.forEach((it, i) => {
    const r = rows.get(it.id) || makeRow(it.id);
    updateRow(r, it);
    if (tbody.children[i] !== r.tr) tbody.insertBefore(r.tr, tbody.children[i] || null); // moves keep the element
  });
  while (tbody.children.length > items.length) tbody.lastChild.remove(); // filtered out (kept in `rows`)
  const live = new Set(state.items.map((it) => it.id));
  for (const id of rows.keys()) if (!live.has(id)) { rows.get(id).tr.remove(); rows.delete(id); }
  for (const id of selected) if (!live.has(id)) selected.delete(id);

  $('empty').hidden = items.length > 0;
  set($('empty'), state.items.length ? 'Nothing matches.' : 'No downloads yet. Click “Add URL”, copy a download link, or download something with the browser extension installed.');
  const total = state.items.reduce((n, it) => n + (it.status === 'downloading' ? it.speed : 0), 0);
  set($('total-speed'), total ? `↓ ${fmtBytes(total)}/s` : '');
  const counts = { all: state.items.length, finished: state.items.filter((i) => i.status === 'done').length };
  counts.unfinished = counts.all - counts.finished;
  for (const el of document.querySelectorAll('[data-count]')) set(el, counts[el.dataset.count] ? String(counts[el.dataset.count]) : '');
  for (const th of document.querySelectorAll('th[data-sort]')) th.dataset.dir = th.dataset.sort === sort.key ? (sort.dir > 0 ? '▲' : '▼') : '';
  updateButtons();
}

function updateButtons() {
  const s = sel();
  $('btn-resume').disabled = !s.some((i) => ['paused', 'error'].includes(i.status));
  $('btn-pause').disabled = !s.some((i) => ['downloading', 'queued'].includes(i.status));
  $('btn-delete').disabled = !s.length;
  $('btn-folder').title = s.length === 1 ? 'Show the file in its folder' : 'Open the download folder';
}

function paintSelection() {
  for (const [id, r] of rows) r.tr.classList.toggle('selected', selected.has(id));
  updateButtons();
}

function selectOnly(id) {
  selected.clear();
  if (id) selected.add(id);
  anchor = id;
  paintSelection();
}

function openItem(it) {
  if (it?.status === 'done') window.api.open(it.id);
  else if (it && ['paused', 'error'].includes(it.status)) window.api.resume(it.id);
}

window.api.onUpdate((s) => { state = s; render(); });
window.api.snapshot().then((s) => { state = s; render(); });

// --- Mouse ---
$('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const id = tr.dataset.id;
  if (e.shiftKey && anchor && order.includes(anchor)) {
    const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
    selected.clear();
    order.slice(a, b + 1).forEach((x) => selected.add(x));
    paintSelection();
  } else if (e.metaKey || e.ctrlKey) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    anchor = id;
    paintSelection();
  } else {
    selectOnly(id);
    if (e.target.classList.contains('link')) openItem(find(id)); // click the name of a finished file = open
  }
});
$('rows').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr');
  if (tr && !e.target.classList.contains('link')) openItem(find(tr.dataset.id));
});
$('rows').addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  e.preventDefault();
  if (!selected.has(tr.dataset.id)) selectOnly(tr.dataset.id);
  window.api.contextMenu([...selected]);
});
$('list').addEventListener('click', (e) => { if (!e.target.closest('tr')) selectOnly(null); });

for (const th of document.querySelectorAll('th[data-sort]')) {
  th.onclick = () => {
    sort = sort.key === th.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: th.dataset.sort, dir: th.dataset.sort === 'name' ? 1 : -1 };
    try { localStorage.setItem('sort', JSON.stringify(sort)); } catch {}
    render();
  };
}

$('sidebar').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  filter = a.dataset.filter;
  for (const el of document.querySelectorAll('.sidebar a')) el.classList.toggle('active', el === a);
  render();
});

$('search').addEventListener('input', () => { query = $('search').value.trim().toLowerCase(); render(); });

// --- Toolbar / sidebar buttons ---
$('btn-resume').onclick = () => window.api.resume([...selected]);
$('btn-pause').onclick = () => window.api.pause([...selected]);
$('btn-delete').onclick = () => window.api.deleteItems([...selected]);
$('btn-folder').onclick = () => window.api.openFolder(selected.size === 1 ? [...selected][0] : null);
$('btn-pause-all').onclick = () => window.api.pauseAll();
$('btn-resume-all').onclick = () => window.api.resumeAll();
$('btn-clear').onclick = () => window.api.clearFinished();

// --- Keyboard ---
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (document.querySelector('dialog[open]')) return;
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); openAdd(''); return; }
  if (e.target.matches('input')) {
    if (e.key === 'Escape') { e.target.value = ''; query = ''; e.target.blur(); render(); }
    return;
  }
  const s = sel();
  if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    order.forEach((id) => selected.add(id));
    paintSelection();
  } else if (e.key === 'Escape') selectOnly(null);
  else if (e.key === 'Enter' && s.length === 1) openItem(s[0]);
  else if (e.key === ' ' && s.length) {
    e.preventDefault();
    const running = s.filter((i) => ['downloading', 'queued'].includes(i.status));
    if (running.length) window.api.pause(running.map((i) => i.id));
    else window.api.resume(s.map((i) => i.id));
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.length) {
    e.preventDefault();
    window.api.deleteItems(s.map((i) => i.id));
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && order.length) {
    e.preventDefault();
    const i = anchor ? order.indexOf(anchor) : -1;
    const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    selectOnly(next);
    rows.get(next)?.tr.scrollIntoView({ block: 'nearest' });
  }
});

// --- Add dialog ---
async function openAdd(url) {
  $('add-url').value = url || (await window.api.clipboardLink());
  $('add-name').value = '';
  $('add-error').textContent = '';
  $('dlg-add').showModal();
}
window.api.onAddUrl((url) => openAdd(url));
$('btn-add').onclick = () => openAdd('');
$('add-ok').onclick = async (e) => {
  e.preventDefault();
  if (!$('add-url').reportValidity()) return;
  try {
    await window.api.add({ url: $('add-url').value.trim(), name: $('add-name').value.trim() || null, quality: $('add-quality').value });
    $('dlg-add').close();
  } catch (err) {
    $('add-error').textContent = err.message.replace(/^Error invoking remote method '\w+': (Error: )?/, '');
  }
};

// --- Settings dialog ---
$('btn-settings').onclick = () => {
  const s = state.settings;
  $('set-dir').value = s.baseDir;
  $('set-conn').value = s.connections;
  $('set-active').value = s.maxActive;
  $('set-limit').value = s.speedLimit;
  $('set-sched').checked = s.schedule.enabled;
  $('set-start').value = s.schedule.start;
  $('set-stop').value = s.schedule.stop;
  $('set-clip').checked = s.watchClipboard !== false;
  $('dlg-settings').showModal();
};
$('set-pick').onclick = async () => {
  const dir = await window.api.pickDir();
  if (dir) $('set-dir').value = dir;
};
$('set-ok').onclick = (e) => {
  e.preventDefault();
  const form = $('dlg-settings').querySelector('form');
  if (!form.reportValidity()) return;
  window.api.settings({
    baseDir: $('set-dir').value,
    connections: Number($('set-conn').value),
    maxActive: Number($('set-active').value),
    speedLimit: Number($('set-limit').value),
    schedule: { enabled: $('set-sched').checked, start: $('set-start').value || '00:00', stop: $('set-stop').value || '00:00' },
    watchClipboard: $('set-clip').checked,
  });
  $('dlg-settings').close();
};
