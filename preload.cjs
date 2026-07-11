const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coordrippr', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  choosePdfs: () => ipcRenderer.invoke('choose-pdfs'),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  saveCsv: (opts) => ipcRenderer.invoke('save-csv', opts),
  onAutoload: (cb) => ipcRenderer.on('autoload', (_e, files) => cb(files)),
});
