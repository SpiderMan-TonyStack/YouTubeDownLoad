const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { ensureBinaries, updateYtDlp } = require('./binaries')
const { parseInfo, startDownload } = require('./downloader')
const {
  getHistory,
  addHistory,
  removeHistory,
  clearHistory,
  getSettings,
  saveSettings
} = require('./store')

let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: 'YoutubeDownload',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), {
    query: { theme: (getSettings().theme || 'light') }
  })
  // 开发时取消下一行注释可打开调试工具
  // win.webContents.openDevTools()
}

function defaultDownloadDir() {
  try {
    return path.join(app.getPath('downloads'), 'YouTube')
  } catch (e) {
    return path.join(app.getPath('userData'), 'downloads')
  }
}

function recordHistory(outDir, ev, options, url) {
  if (ev.type === 'complete') {
    let size = 0
    try {
      size = fs.statSync(ev.filePath).size
    } catch (e) {}
    addHistory({
      id: ev.id,
      title: ev.title,
      url,
      filePath: ev.filePath,
      mode: options.mode,
      subtitle: options.subtitle,
      status: 'done',
      size,
      time: Date.now()
    })
  } else if (ev.type === 'error') {
    addHistory({
      id: ev.id,
      title: options.title || url,
      url,
      filePath: '',
      mode: options.mode,
      subtitle: options.subtitle,
      status: 'error',
      size: 0,
      time: Date.now(),
      error: ev.message
    })
  }
}

function send(channel, ...args) {
  if (win) win.webContents.send(channel, ...args)
}

// ---------------- IPC ----------------
ipcMain.handle('app:ensure-binaries', async () => {
  const settings = getSettings()
  const bins = await ensureBinaries(settings, (msg) => send('binaries-status', msg))
  return bins
})

// 把 yt-dlp 强制更新到最新版（YouTube 频繁变动，引擎过旧会导致 403 下载失败）
ipcMain.handle('app:update-ytdlp', async () => {
  const p = await updateYtDlp((msg) => send('binaries-status', msg))
  send('binaries-status', 'yt-dlp 引擎已更新到最新版本')
  return p
})

ipcMain.handle('parse', async (_e, { url }) => {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('请输入有效的视频链接')
  const settings = getSettings()
  const bins = await ensureBinaries(settings, (msg) => send('binaries-status', msg))
  return parseInfo(url, bins.ytDlp)
})

ipcMain.handle('download', async (_e, { url, options }) => {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('请输入有效的视频链接')
  const settings = getSettings()
  const dir = settings.downloadDir || defaultDownloadDir()
  fs.mkdirSync(dir, { recursive: true })
  const bins = await ensureBinaries(settings, (msg) => send('binaries-status', msg))
  const id = startDownload({
    url,
    ytdlpPath: bins.ytDlp,
    ffmpegPath: bins.ffmpeg,
    options: { ...options, duration: options.duration || 0 },
    outDir: dir,
    proxy: settings.proxy,
    onEvent: (ev) => {
      ev.title = options.title
      send('download-event', ev)
      if (ev.type === 'complete' || ev.type === 'error') recordHistory(dir, ev, options, url)
    }
  })
  return id
})

ipcMain.handle('get-history', () => getHistory())
ipcMain.handle('clear-history', () => {
  clearHistory()
  return true
})
ipcMain.handle('remove-history', (_e, id) => {
  removeHistory(id)
  return true
})

ipcMain.handle('get-settings', () => {
  const s = getSettings()
  if (!s.downloadDir) s.downloadDir = defaultDownloadDir()
  return s
})
ipcMain.handle('save-settings', (_e, patch) => {
  saveSettings(patch)
  return getSettings()
})

ipcMain.handle('select-binary', async (_e, type) => {
  const result = await dialog.showOpenDialog(win, {
    title: `选择 ${type === 'ffmpeg' ? 'ffmpeg' : 'yt-dlp'} 可执行文件`,
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('select-dir', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择下载目录',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('open-folder', async (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath)
  } else {
    const dir = (getSettings().downloadDir || defaultDownloadDir())
    fs.mkdirSync(dir, { recursive: true })
    shell.openPath(dir)
  }
  return true
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
