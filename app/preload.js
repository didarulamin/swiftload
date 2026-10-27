'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  snapshot: call('snapshot'),
  add: call('add'),
  pause: call('pause'), // id or array of ids
  resume: call('resume'),
  deleteItems: call('deleteItems'),
  pauseAll: call('pauseAll'),
  resumeAll: call('resumeAll'),
  clearFinished: call('clearFinished'),
  settings: call('settings'),
  open: call('open'),
  openFolder: call('openFolder'),
  contextMenu: call('contextMenu'),
  clipboardLink: call('clipboardLink'),
  icon: call('icon'),
  pickDir: call('pickDir'),
  onUpdate: (cb) => ipcRenderer.on('update', (_, s) => cb(s)),
  onAddUrl: (cb) => ipcRenderer.on('addUrl', (_, url) => cb(url)),
});
