'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron');
const http = require('node:http');
const path = require('node:path');
const { Manager } = require('./engine/queue');

const BRIDGE_PORT = 47321; // the browser extension posts here
let win, mgr;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function showWindow() {
  if (win) { if (win.isMinimized()) win.restore(); return win.show(); }
  win = new BrowserWindow({
    width: 980, height: 620, minWidth: 720, minHeight: 400,
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'), { query: { platform: process.platform } });
  win.on('closed', () => { win = null; });
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

const fileOf = (id) => mgr.find(id)?.file;

app.whenReady().then(() => {
  mgr = new Manager(path.join(app.getPath('userData'), 'downloads.json'));
  mgr.on('update', (s) => win?.webContents.send('update', s));
  mgr.on('finished', (it) => {
    if (Notification.isSupported()) new Notification({ title: it.status === 'done' ? 'Download complete' : 'Download failed', body: it.name || it.url }).show();
  });
  ipcMain.handle('snapshot', () => mgr.snapshot());
  ipcMain.handle('add', (_, d) => mgr.add(d));
  ipcMain.handle('pause', (_, id) => mgr.pause(id));
  ipcMain.handle('resume', (_, id) => mgr.resume(id));
  ipcMain.handle('remove', (_, id, deleteFile) => mgr.remove(id, deleteFile));
  ipcMain.handle('settings', (_, s) => mgr.setSettings(s));
  ipcMain.handle('open', (_, id) => fileOf(id) && shell.openPath(fileOf(id)));
  ipcMain.handle('reveal', (_, id) => fileOf(id) && shell.showItemInFolder(fileOf(id)));
  ipcMain.handle('pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  startBridge();
  showWindow();
});

app.on('activate', showWindow);
// macOS: keep downloading in the background (Dock reopens the window). Elsewhere there's no way back, so quit.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => mgr?.close());
