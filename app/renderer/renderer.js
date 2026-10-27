'use strict';
const $ = (id) => document.getElementById(id);
if (new URLSearchParams(location.search).get('platform') === 'darwin') document.body.classList.add('mac');
let state = { items: [], settings: {} };
let filter = 'all';
let selected = null;

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

function visible(it) {
  if (filter === 'all') return true;
  if (filter === 'finished') return it.status === 'done';
  if (filter === 'unfinished') return it.status !== 'done';
  return it.category === filter.slice(4);
}

// yt-dlp downloads video and audio as separate tracks, then merges.
function ytLabel(yt) {
  if (yt.stage === 'merging') return 'Merging…';
  if (yt.stage === 'converting') return 'Converting…';
  if (yt.stage !== 'download') return 'Starting…';
  return `${yt.percent.toFixed(1)}%${yt.part ? ' · audio' : ''}`;
}

function render() {
  const rows = state.items.filter(visible);
  const tbody = $('rows');
  tbody.replaceChildren(...rows.map((it) => {
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    if (it.id === selected) tr.className = 'selected';
    const yt = it.status === 'downloading' && it.yt;
    const pct = yt ? yt.percent || 0 : it.size > 0 ? Math.min(100, (it.done / it.size) * 100) : it.parts ? (it.parts[0] / it.parts[1]) * 100 : 0;
    const label = yt ? ytLabel(yt) : it.status === 'downloading' ? (it.size > 0 || it.parts ? `${pct.toFixed(1)}%` : fmtBytes(it.done))
      : it.status === 'error' ? `Error: ${it.error}` : it.status[0].toUpperCase() + it.status.slice(1);
    const cells = [
      [it.name || it.url, 'name'],
      [it.size > 0 ? fmtBytes(it.size) : it.parts ? fmtBytes(it.done) : '—', 'num'],
      [null, 'progress'],
      [it.status === 'downloading' ? `${fmtBytes(it.speed)}/s` : '', 'num'],
      [yt ? (yt.eta && yt.eta !== 'Unknown' ? yt.eta : '') : it.status === 'downloading' && it.speed && it.size > 0 ? fmtTime((it.size - it.done) / it.speed) : '', 'num'],
      [new Date(it.added).toLocaleString(), 'muted'],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.className = cls;
      if (cls === 'progress') {
        const bar = document.createElement('div');
        bar.className = `bar ${it.status}`;
        bar.style.setProperty('--p', `${it.status === 'done' ? 100 : pct}%`);
        const span = document.createElement('span');
        span.textContent = label;
        td.append(bar, span);
      } else {
        td.textContent = text;
        if (cls === 'name') td.title = it.url;
      }
      tr.append(td);
    }
    return tr;
  }));
  $('empty').hidden = rows.length > 0;
  const total = state.items.reduce((n, it) => n + (it.status === 'downloading' ? it.speed : 0), 0);
  $('total-speed').textContent = total ? `↓ ${fmtBytes(total)}/s` : '';
  const sel = state.items.find((i) => i.id === selected);
  $('btn-resume').disabled = !sel || !['paused', 'error'].includes(sel.status);
  $('btn-pause').disabled = !sel || !['downloading', 'queued'].includes(sel.status);
  $('btn-delete').disabled = !sel;
}

window.api.onUpdate((s) => { state = s; render(); });
window.api.snapshot().then((s) => { state = s; render(); });

$('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  selected = tr ? tr.dataset.id : null;
  render();
});
$('rows').addEventListener('dblclick', (e) => {
  const it = state.items.find((i) => i.id === e.target.closest('tr')?.dataset.id);
  if (!it) return;
  if (it.status === 'done') window.api.open(it.id);
  else if (['paused', 'error'].includes(it.status)) window.api.resume(it.id);
});

$('sidebar').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  filter = a.dataset.filter;
  for (const el of document.querySelectorAll('.sidebar a')) el.classList.toggle('active', el === a);
  render();
});

$('btn-resume').onclick = () => window.api.resume(selected);
$('btn-pause').onclick = () => window.api.pause(selected);
$('btn-delete').onclick = () => {
  const it = state.items.find((i) => i.id === selected);
  if (!it) return;
  const alsoFile = it.file && confirm(`Also delete the file from disk?\n\n${it.file}`);
  window.api.remove(it.id, alsoFile);
  selected = null;
};

// Add dialog
$('btn-add').onclick = () => {
  $('add-url').value = '';
  $('add-name').value = '';
  $('add-error').textContent = '';
  $('dlg-add').showModal();
};
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

// Settings dialog
$('btn-settings').onclick = () => {
  const s = state.settings;
  $('set-dir').value = s.baseDir;
  $('set-conn').value = s.connections;
  $('set-active').value = s.maxActive;
  $('set-limit').value = s.speedLimit;
  $('set-sched').checked = s.schedule.enabled;
  $('set-start').value = s.schedule.start;
  $('set-stop').value = s.schedule.stop;
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
  });
  $('dlg-settings').close();
};
