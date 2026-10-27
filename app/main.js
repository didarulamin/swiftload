'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, Menu, Tray, clipboard } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Manager, isDownloadLink } = require('./engine/queue');

const BRIDGE_PORT = 47321; // the browser extension posts here
const isMac = process.platform === 'darwin';
const FOLDER_LABEL = isMac ? 'Show in Finder' : 'Show in Explorer';
let win, mgr, tray;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function showWindow() {
  if (win) { if (win.isMinimized()) win.restore(); return win.show(); }
  win = new BrowserWindow({
    width: 1040, height: 640, minWidth: 760, minHeight: 400,
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'), { query: { platform: process.platform } });
  // Closing only hides: downloads, Dock/taskbar progress and the tray keep working. Quit from the tray or ⌘Q.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

// Sends to the window once it has loaded (it may have just been created).
function send(channel, data) {
  showWindow();
  const wc = win.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(channel, data));
  else wc.send(channel, data);
}

// Extension -> app. Only accepts a JSON POST from an extension origin; web pages
// can't send that without a CORS preflight, which we never answer.
function startBridge() {
  http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const ok = req.method === 'POST' && req.url === '/add'
      && /^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f-]{36})$/.test(origin)
      && (req.headers['content-type'] || '').startsWith('application/json');
    if (!ok) { res.writeHead(403); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const { url, audioUrl, filename, referrer, cookie, kind, quality } = JSON.parse(body);
        const id = mgr.add({ url, audioUrl: kind === 'merge' ? audioUrl : null, name: filename ? path.basename(filename) : null, referer: referrer, cookie, hls: kind === 'hls', quality });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
        showWindow();
      } catch (err) {
        res.writeHead(400);
        res.end(String(err.message));
      }
    });
  }).on('error', (err) => console.error('bridge:', err.message)).listen(BRIDGE_PORT, '127.0.0.1');
}

const items = (ids) => [].concat(ids).map((id) => mgr.find(id)).filter(Boolean);
const exists = (p) => !!p && fs.existsSync(p);

async function openFile(it) {
  if (!exists(it.file)) return dialog.showMessageBox(win, { type: 'warning', message: 'File not found', detail: `${it.file || it.name}\n\nIt may have been moved or deleted.` });
  const err = await shell.openPath(it.file);
  if (err) dialog.showMessageBox(win, { type: 'warning', message: 'Could not open the file', detail: err });
}

// Unfinished downloads only have a .part file; fall back to the folder.
function reveal(it) {
  const f = [it.file, it.file && `${it.file}.part`].find(exists);
  if (f) shell.showItemInFolder(f);
  else shell.openPath(it.dir || mgr.settings.baseDir);
}

// Remove from the list, optionally moving finished files to the Trash / Recycle Bin.
async function deleteItems(list) {
  if (!list.length) return;
  const withFiles = list.filter((it) => exists(it.file));
  const many = list.length > 1;
  const buttons = ['Cancel', 'Remove from List'];
  if (withFiles.length) buttons.push(isMac ? 'Move to Trash' : 'Move to Recycle Bin');
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons, defaultId: 1, cancelId: 0,
    message: many ? `Remove ${list.length} downloads?` : `Remove “${list[0].name || list[0].url}”?`,
    detail: withFiles.length ? `“${buttons[2]}” also deletes ${withFiles.length > 1 ? `${withFiles.length} files` : 'the file'} from disk.` : undefined,
  });
  if (response === 0) return;
  if (response === 2) for (const it of withFiles) await shell.trashItem(it.file).catch(() => {});
  for (const it of list) mgr.remove(it.id, response === 2); // also clears leftover .part files
}

function contextMenu(sender, ids) {
  const list = items(ids);
  if (!list.length) return;
  const one = list.length === 1 ? list[0] : null;
  const each = (fn) => () => list.forEach((it) => fn(it.id));
  Menu.buildFromTemplate([
    { label: 'Open', enabled: !!one && one.status === 'done', click: () => openFile(one) },
    { label: FOLDER_LABEL, enabled: !!one, click: () => reveal(one) },
    { type: 'separator' },
    { label: many(list, 'Copy Link', 'Copy Links'), click: () => clipboard.writeText(list.map((it) => it.url).join('\n')) },
    { label: many(list, 'Copy File Path', 'Copy File Paths'), enabled: list.some((it) => it.file), click: () => clipboard.writeText(list.filter((it) => it.file).map((it) => it.file).join('\n')) },
    { type: 'separator' },
    { label: 'Pause', enabled: list.some((it) => it.status === 'downloading' || it.status === 'queued'), click: each((id) => mgr.pause(id)) },
    { label: 'Resume', enabled: list.some((it) => it.status === 'paused' || it.status === 'error'), click: each((id) => mgr.resume(id)) },
    { label: 'Download Again', click: each((id) => mgr.redownload(id)) },
    { type: 'separator' },
    { label: 'Remove…', click: () => deleteItems(list) },
  ]).popup({ window: BrowserWindow.fromWebContents(sender) });
}
const many = (list, single, plural) => (list.length > 1 ? plural : single);

// Dock (macOS) / taskbar (Windows) progress + active-download badge.
function showProgress(s) {
  const active = s.items.filter((it) => it.status === 'downloading');
  const fractions = active
    .map((it) => (it.yt ? (it.yt.percent || 0) / 100 : it.size > 0 ? it.done / it.size : it.parts ? it.parts[0] / it.parts[1] : null))
    .filter((f) => f !== null);
  const value = !active.length ? -1 : fractions.length ? fractions.reduce((a, b) => a + b, 0) / fractions.length : 2; // >1 = indeterminate
  win?.setProgressBar(value);
  if (isMac) app.setBadgeCount(active.length);
  tray?.setToolTip(active.length ? `Swiftload: ${active.length} downloading` : 'Swiftload');
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', isMac ? 'trayTemplate.png' : 'tray.png'));
  tray.setToolTip('Swiftload');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Swiftload', click: showWindow },
    { label: 'Add URL…', click: async () => send('addUrl', await clipboardLink()) },
    { type: 'separator' },
    { label: 'Pause All', click: () => mgr.pauseAll() },
    { label: 'Resume All', click: () => mgr.resumeAll() },
    { label: 'Open Download Folder', click: () => shell.openPath(mgr.settings.baseDir) },
    { type: 'separator' },
    { label: 'Quit Swiftload', click: () => app.quit() },
  ]));
  if (!isMac) tray.on('click', showWindow); // Windows: left click opens, right click shows the menu
}

// Electron 45: clipboard.readText() is async.
const clipboardLink = async () => { const t = (await clipboard.readText()).trim(); return isDownloadLink(t) ? t : ''; };

// Offer copied download links. ponytail: 1s polling, Electron has no clipboard-change event.
async function watchClipboard() {
  let last = await clipboard.readText();
  setInterval(async () => {
    const text = await clipboard.readText();
    if (text === last) return;
    last = text;
    const url = text.trim();
    if (!mgr.settings.watchClipboard || !isDownloadLink(url) || !Notification.isSupported()) return;
    if (mgr.items.some((it) => it.url === new URL(url).href)) return;
    const n = new Notification({ title: 'Download this link?', body: decodeURIComponent(path.posix.basename(new URL(url).pathname)) || url, silent: true });
    n.on('click', () => send('addUrl', url));
    n.show();
  }, 1000);
}

app.whenReady().then(() => {
  mgr = new Manager(path.join(app.getPath('userData'), 'downloads.json'));
  mgr.on('update', (s) => { win?.webContents.send('update', s); showProgress(s); });
  mgr.on('finished', (it) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: it.status === 'done' ? 'Download complete' : 'Download failed', body: it.name || it.url });
    n.on('click', () => (it.status === 'done' ? reveal(it) : showWindow()));
    n.show();
  });
  ipcMain.handle('snapshot', () => mgr.snapshot());
  ipcMain.handle('add', (_, d) => mgr.add(d));
  ipcMain.handle('pause', (_, ids) => items(ids).forEach((it) => mgr.pause(it.id)));
  ipcMain.handle('resume', (_, ids) => items(ids).forEach((it) => mgr.resume(it.id)));
  ipcMain.handle('deleteItems', (_, ids) => deleteItems(items(ids)));
  ipcMain.handle('pauseAll', () => mgr.pauseAll());
  ipcMain.handle('resumeAll', () => mgr.resumeAll());
  ipcMain.handle('clearFinished', () => mgr.clearFinished());
  ipcMain.handle('settings', (_, s) => mgr.setSettings(s));
  ipcMain.handle('open', (_, id) => { const it = mgr.find(id); if (it) return openFile(it); });
  ipcMain.handle('openFolder', (_, id) => { const it = id && mgr.find(id); return it ? reveal(it) : shell.openPath(mgr.settings.baseDir); });
  ipcMain.handle('contextMenu', (e, ids) => contextMenu(e.sender, ids));
  ipcMain.handle('clipboardLink', clipboardLink);
  ipcMain.handle('icon', async (_, id) => {
    const it = mgr.find(id);
    if (!exists(it?.file)) return null;
    return (await app.getFileIcon(it.file, { size: 'small' })).toDataURL();
  });
  ipcMain.handle('pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  startBridge();
  createTray();
  watchClipboard();
  showWindow();
});

app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; mgr?.close(); });
