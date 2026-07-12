const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coordrippr', {
  platform: 'electron',
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  choosePdfs: () => ipcRenderer.invoke('choose-pdfs'),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  saveCsv: (opts) => ipcRenderer.invoke('save-csv', opts),
  savePdf: (opts) => ipcRenderer.invoke('save-pdf', opts),
  netFetch: (opts) => ipcRenderer.invoke('net-fetch', opts),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onAutoload: (cb) => ipcRenderer.on('autoload', (_e, files) => cb(files)),
});
