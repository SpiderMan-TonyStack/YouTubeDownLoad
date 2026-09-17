const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { ensureBinaries, updateYtDlp } = require('./binaries')
const { parseInfo, startDownload, retrySubtitles, cancel } = require('./downloader')
const proxy = require('./proxy')
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

// 只有「显式开启」时才把代理交给 yt-dlp；只影响本应用，从不修改系统代理
function activeProxy(settings) {
  if (settings.proxyEnabled === true) return settings.proxy || ''
  if (settings.proxyEnabled === false) return ''
  // 老版本升级上来的用户：未设置过开关，但有地址 → 沿用（视为开启）
  return settings.proxy || ''
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
  return parseInfo(url, bins.ytDlp, activeProxy(settings))
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
    proxy: activeProxy(settings),
    onEvent: (ev) => {
      ev.title = options.title
      send('download-event', ev)
      if (ev.type === 'complete' || ev.type === 'error') recordHistory(dir, ev, options, url)
    }
  })
  return id
})

// 补字幕：视频已下载完成但字幕当时被限速/失败，仅重抓字幕并烧录，不重下视频
ipcMain.handle('retry-subtitle', async (_e, { id, url, options, filePath }) => {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('缺少有效的视频链接')
  if (!filePath || !fs.existsSync(filePath)) throw new Error('原视频文件不存在，无法补字幕')
  const settings = getSettings()
  const bins = await ensureBinaries(settings, (msg) => send('binaries-status', msg))
  retrySubtitles({
    id,
    url,
    ytdlpPath: bins.ytDlp,
    ffmpegPath: bins.ffmpeg,
    options: { ...options, duration: options.duration || 0 },
    outDir: path.dirname(filePath),
    proxy: activeProxy(settings),
    videoPath: filePath,
    onEvent: (ev) => {
      ev.title = options.title
      send('download-event', ev)
    }
  }).catch((e) => send('download-event', { type: 'error', id, message: '补字幕异常：' + e.message, title: options.title }))
  return true
})

// ---------------- 本地代理对接（复用本机已运行的 Clash / FlClash 内核） ----------------
function controllerPortFrom(url) {
  if (!url) return null
  const m = String(url).match(/:(\d+)/)
  return m ? Number(m[1]) : null
}

ipcMain.handle('proxy:detect', async () => {
  const s = getSettings()
  const r = await proxy.detect({
    secret: s.clashSecret || '',
    controllerPort: controllerPortFrom(s.clashController)
  })
  const patch = { proxyPort: r.proxyPort || null }
  // 探测到端口才覆盖地址；否则保留用户手填的值
  if (r.proxyUrl) patch.proxy = r.proxyUrl
  if (r.controller && !r.controller.needsSecret) patch.clashController = r.controller.url
  saveSettings(patch)
  return { ...r, settings: getSettings() }
})

ipcMain.handle('proxy:nodes', async (_e, { controllerUrl, secret }) => {
  const s = getSettings()
  return proxy.listNodes({
    controllerUrl: controllerUrl || s.clashController,
    secret: secret || s.clashSecret || ''
  })
})

ipcMain.handle('proxy:select', async (_e, { controllerUrl, secret, group, node }) => {
  const s = getSettings()
  const url = controllerUrl || s.clashController
  const sec = secret || s.clashSecret || ''
  await proxy.selectNode({ controllerUrl: url, secret: sec, group, node })
  saveSettings({ clashController: url, clashGroup: group, clashNode: node })
  return true
})

ipcMain.handle('proxy:test', async (_e, { proxyUrl }) => {
  const url = proxyUrl || getSettings().proxy || ''
  if (!url) return { ok: false, error: '尚未配置代理地址' }
  return proxy.testProxy(url)
})

// 取消任务：杀掉正在跑的 yt-dlp / ffmpeg（下载与补字幕通用）
ipcMain.handle('cancel-task', (_e, { id }) => {
  if (!id) return false
  return cancel(id)
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
