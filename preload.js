const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  printInvoice: (options) => ipcRenderer.send('print-invoice', options),
  printToPdf: (options) => ipcRenderer.invoke('print-to-pdf', options),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  saveFastCache: (key, data) => ipcRenderer.invoke('fast-save-cache', { key, data }),
  readFastCache: (key) => ipcRenderer.invoke('fast-read-cache', { key }),
  loadInitialDb: () => ipcRenderer.invoke('load-initial-db')
});
