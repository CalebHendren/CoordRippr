const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coordrippr', {
  platform: 'electron',
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  choosePdfs: () => ipcRenderer.invoke('choose-pdfs'),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  saveCsv: (opts) => ipcRenderer.invoke('save-csv', opts),
  savePdf: (opts) => ipcRenderer.invoke('save-pdf', opts),
  saveJson: (opts) => ipcRenderer.invoke('save-json', opts),
  openJson: (opts) => ipcRenderer.invoke('open-json', opts),
  renamePdfs: (opts) => ipcRenderer.invoke('rename-pdfs', opts),
  netFetch: (opts) => ipcRenderer.invoke('net-fetch', opts),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onAutoload: (cb) => ipcRenderer.on('autoload', (_e, files) => cb(files)),
  // Durable project storage on disk. Its presence is what tells src/persist.js
  // to use the file back end instead of IndexedDB, so the browser build (which
  // has no `store`) keeps working exactly as before.
  store: {
    read: (rel) => ipcRenderer.invoke('store-read', rel),
    write: (rel, text) => ipcRenderer.invoke('store-write', { rel, text }),
    readBin: (rel) => ipcRenderer.invoke('store-read-bin', rel),
    writeBin: (rel, data) => ipcRenderer.invoke('store-write-bin', { rel, data }),
    remove: (rel) => ipcRenderer.invoke('store-remove', rel),
    dir: () => ipcRenderer.invoke('store-dir'),
    setDir: () => ipcRenderer.invoke('store-set-dir'),
  },
});
