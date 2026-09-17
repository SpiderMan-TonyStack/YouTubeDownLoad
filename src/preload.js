const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  ensureBinaries: () => ipcRenderer.invoke('app:ensure-binaries'),
  updateYtdlp: () => ipcRenderer.invoke('app:update-ytdlp'),
  parse: (url) => ipcRenderer.invoke('parse', { url }),
  download: (payload) => ipcRenderer.invoke('download', payload),
  retrySubtitle: (payload) => ipcRenderer.invoke('retry-subtitle', payload),

  onBinariesStatus: (cb) => {
    const l = (_e, msg) => cb(msg)
    ipcRenderer.on('binaries-status', l)
    return () => ipcRenderer.removeListener('binaries-status', l)
  },
  onDownloadEvent: (cb) => {
    const l = (_e, ev) => cb(ev)
    ipcRenderer.on('download-event', l)
    return () => ipcRenderer.removeListener('download-event', l)
  },

  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  removeHistory: (id) => ipcRenderer.invoke('remove-history', id),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),

  proxyDetect: () => ipcRenderer.invoke('proxy:detect'),
  proxyNodes: (payload) => ipcRenderer.invoke('proxy:nodes', payload || {}),
  proxySelect: (payload) => ipcRenderer.invoke('proxy:select', payload),
  proxyTest: (payload) => ipcRenderer.invoke('proxy:test', payload || {}),

  selectBinary: (type) => ipcRenderer.invoke('select-binary', type),
  selectDir: () => ipcRenderer.invoke('select-dir'),
  openFolder: (filePath) => ipcRenderer.invoke('open-folder', filePath)
})
