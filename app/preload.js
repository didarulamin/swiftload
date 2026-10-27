'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  snapshot: call('snapshot'),
  add: call('add'),
  pause: call('pause'),
  resume: call('resume'),
  remove: call('remove'),
  settings: call('settings'),
  open: call('open'),
  reveal: call('reveal'),
  pickDir: call('pickDir'),
  onUpdate: (cb) => ipcRenderer.on('update', (_, s) => cb(s)),
});
