const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { ensureBinaries, updateYtDlp } = require('./binaries')
const {
  parseInfo,
  startDownload,
  retrySubtitles,
  cancel,
  friendlyYtdlpError
} = require('./downloader')
const proxy = require('./proxy')
const { testTranslate } = require('./translator')
const {
  getHistory,
  addHistory,
  removeHistory,
  clearHistory,
  getSettings,
  saveSettings,
  getSecret,
  migrateSecrets,
  maskSettings,
  SECRET_KEYS
} = require('./store')
const { encrypt } = require('./secrets')

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

// 字幕翻译配置（只有中文字幕缺失时才会用到）
function translateConfig(settings) {
  return {
    enabled: settings.translateEnabled !== false,
    provider: settings.translateProvider || 'google',
    baseUrl: settings.translateBaseUrl || '',
    apiKey: getSecret('translateApiKey'),
    model: settings.translateModel || ''
  }
}

// ---------------- IPC ----------------
ipcMain.handle('app:ensure-binaries', async () => {
  const settings = getSettings()
  const bins = await ensureBinaries(settings, (msg) => send('binaries-status', msg))
  return bins
})

// 把 yt-dlp 强制更新到最新版（YouTube 频繁变动，引擎过旧会导致 403 下载失败）
// 下载后必须通过官方 SHA-256 校验才会落盘
ipcMain.handle('app:update-ytdlp', async () => {
  const s = getSettings()
  const p = await updateYtDlp(
    (msg) => send('binaries-status', msg),
    s.binaryMirrorEnabled === true
  )
  send('binaries-status', 'yt-dlp 引擎已更新到最新版本（已通过官方校验和验证）')
  return p
})

// YouTube 登录 Cookie 配置：风控要求 "Sign in to confirm you're not a bot" 时必须带上
function cookieConfig(settings) {
  return {
    mode: settings.cookiesMode || 'none',
    browser: settings.cookiesBrowser || 'chrome',
    file: settings.cookiesFile || ''
  }
}

ipcMain.handle('parse', async (_e, { url }) => {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('请输入有效的视频链接')
  const settings = getSettings()
  const bins = await ensureBinaries(settings, (msg) => send('binaries-status', msg))
  try {
    return await parseInfo(url, bins.ytDlp, activeProxy(settings), cookieConfig(settings))
  } catch (e) {
    throw new Error(friendlyYtdlpError(e))
  }
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
    translate: translateConfig(settings),
    cookies: cookieConfig(settings),
    onEvent: (ev) => {
      ev.title = options.title
      send('download-event', ev)
      if (ev.type === 'complete' || ev.type === 'error') recordHistory(dir, ev, options, url)
    }
  })
  return id
})

// 补字幕会「删除原文件并写回同名文件」，所以必须确认这个路径确实是本应用产出的视频。
// 否则一个被注入的渲染进程就能借这条 IPC 覆盖本机任意视频文件。
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.flv', '.avi'])

function assertOwnedVideoFile(filePath, settings) {
  let abs
  try {
    abs = path.resolve(filePath)
  } catch (e) {
    throw new Error('视频路径无效')
  }
  const ext = path.extname(abs).toLowerCase()
  if (!VIDEO_EXTS.has(ext)) throw new Error('只支持对视频文件补字幕')
  let st
  try {
    st = fs.statSync(abs)
  } catch (e) {
    throw new Error('原视频文件不存在，无法补字幕')
  }
  if (!st.isFile()) throw new Error('目标不是文件')

  const dir = settings.downloadDir || defaultDownloadDir()
  const inDownloadDir = !path.relative(path.resolve(dir), abs).startsWith('..')
  // 允许「在下载目录内」或「本应用历史记录里登记过的文件」——后者覆盖用户改过下载目录的情况
  const inHistory = getHistory().some((h) => h.filePath && path.resolve(h.filePath) === abs)
  if (!inDownloadDir && !inHistory) {
    throw new Error('该文件不在下载目录内，也不是本应用的下载记录，拒绝操作')
  }
  return abs
}

// 补字幕：视频已下载完成但字幕当时被限速/失败，仅重抓字幕并烧录，不重下视频
ipcMain.handle('retry-subtitle', async (_e, { id, url, options, filePath }) => {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('缺少有效的视频链接')
  const settings = getSettings()
  const safePath = assertOwnedVideoFile(filePath, settings)
  const bins = await ensureBinaries(settings, (msg) => send('binaries-status', msg))
  retrySubtitles({
    id,
    url,
    ytdlpPath: bins.ytDlp,
    ffmpegPath: bins.ffmpeg,
    options: { ...options, duration: options.duration || 0 },
    outDir: path.dirname(safePath),
    proxy: activeProxy(settings),
    videoPath: safePath,
    translate: translateConfig(settings),
    cookies: cookieConfig(settings),
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
    secret: getSecret('clashSecret'),
    controllerPort: controllerPortFrom(s.clashController)
  })
  const patch = { proxyPort: r.proxyPort || null }
  // 探测到端口才覆盖地址；否则保留用户手填的值
  if (r.proxyUrl) patch.proxy = r.proxyUrl
  if (r.controller && !r.controller.needsSecret) patch.clashController = r.controller.url
  saveSettings(patch)
  return { ...r, settings: maskSettings(getSettings()) }
})

ipcMain.handle('proxy:nodes', async (_e, { controllerUrl, secret }) => {
  const s = getSettings()
  return proxy.listNodes({
    controllerUrl: controllerUrl || s.clashController,
    secret: secret || getSecret('clashSecret')
  })
})

ipcMain.handle('proxy:select', async (_e, { controllerUrl, secret, group, node }) => {
  const s = getSettings()
  const url = controllerUrl || s.clashController
  const sec = secret || getSecret('clashSecret')
  await proxy.selectNode({ controllerUrl: url, secret: sec, group, node })
  saveSettings({ clashController: url, clashGroup: group, clashNode: node })
  return true
})

ipcMain.handle('proxy:test', async (_e, { proxyUrl }) => {
  const url = proxyUrl || getSettings().proxy || ''
  if (!url) return { ok: false, error: '尚未配置代理地址' }
  return proxy.testProxy(url)
})

// ---------------- 字幕翻译（中文字幕被限速时用英文字幕翻） ----------------
// 用当前设置里的引擎与代理翻一句样句，便于用户确认配置是否可用
ipcMain.handle('translate:test', async (_e, patch) => {
  const settings = { ...getSettings(), ...(patch || {}) }
  const cfg = translateConfig(settings)
  try {
    const r = await testTranslate({
      provider: cfg.provider,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
      proxy: activeProxy(settings)
    })
    return { ok: true, text: r.text, engine: r.engine }
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
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
  // 敏感字段一律不回传，只告诉渲染进程"是否已配置"
  return maskSettings(s)
})
ipcMain.handle('save-settings', (_e, patch) => {
  const p = { ...(patch || {}) }
  // 密钥字段语义：undefined/空串 = 不改动；null = 清除；其它字符串 = 新值（加密后入库）
  for (const k of SECRET_KEYS) {
    if (!(k in p)) continue
    const v = p[k]
    if (v === null) p[k] = ''
    else if (typeof v === 'string' && v !== '') p[k] = encrypt(v)
    else delete p[k]
  }
  saveSettings(p)
  return maskSettings(getSettings())
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

// 选择 cookies.txt（Netscape 格式）
ipcMain.handle('select-cookies-file', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择 cookies.txt（Netscape 格式）',
    filters: [
      { name: 'Cookie 文件', extensions: ['txt'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths.length) return null
  const p = result.filePaths[0]
  // 粗校验：Netscape 格式前几行里会有 "# Netscape HTTP Cookie File"
  let looksValid = false
  try {
    const head = fs.readFileSync(p, 'utf8').slice(0, 512)
    looksValid = /Netscape HTTP Cookie File/i.test(head) || /\.youtube\.com/.test(head)
  } catch (e) {}
  return { path: p, looksValid }
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

app.whenReady().then(() => {
  // 启动时把历史遗留的明文密钥升级成密文（幂等，失败不影响启动）
  try {
    const migrated = migrateSecrets()
    if (migrated.length) console.log('[secret] 已加密存量密钥字段:', migrated.join(', '))
  } catch (e) {
    console.warn('[secret] 密钥迁移失败:', e.message)
  }
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
