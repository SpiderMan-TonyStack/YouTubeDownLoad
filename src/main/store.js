const Store = require('electron-store')
const { encrypt, decrypt, isEncrypted } = require('./secrets')

// 需要加密落盘的敏感字段
const SECRET_KEYS = ['translateApiKey', 'clashSecret']

const store = new Store({
  name: 'youtube-download',
  defaults: {
    history: [],
    settings: {
      ytdlpPath: '',
      ffmpegPath: '',
      downloadDir: '',
      proxy: '',
      proxyEnabled: false,
      proxyPort: null,
      clashController: '',
      clashSecret: '',
      clashGroup: '',
      clashNode: '',
      // 字幕翻译：中文字幕被 YouTube 限速时，用英文字幕本地翻译出中文
      translateEnabled: true,
      translateProvider: 'google', // google | ai
      translateBaseUrl: 'https://api.deepseek.com/v1',
      translateApiKey: '',
      translateModel: 'deepseek-chat',
      // 引擎下载是否允许走第三方加速镜像（默认关闭：镜像无法保证未被篡改）
      binaryMirrorEnabled: false,
      theme: 'light'
    }
  }
})

function getHistory() {
  return store.get('history', [])
}

function addHistory(item) {
  const list = store.get('history', [])
  list.unshift(item)
  // 最多保留 200 条
  store.set('history', list.slice(0, 200))
}

function updateHistory(id, patch) {
  const list = store.get('history', [])
  const idx = list.findIndex((h) => h.id === id)
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch }
    store.set('history', list)
  }
}

function removeHistory(id) {
  const list = store.get('history', []).filter((h) => h.id !== id)
  store.set('history', list)
}

function clearHistory() {
  store.set('history', [])
}

function getSettings() {
  return store.get('settings', {})
}

function saveSettings(patch) {
  const cur = store.get('settings', {})
  store.set('settings', { ...cur, ...patch })
}

// 读取解密后的密钥明文（空串表示未配置）
function getSecret(name) {
  return decrypt(getSettings()[name] || '')
}

// 把历史遗留的明文密钥升级为密文（只在启动时跑一次，幂等）
function migrateSecrets() {
  const s = getSettings()
  const patch = {}
  for (const k of SECRET_KEYS) {
    const v = s[k]
    if (v && !isEncrypted(v)) patch[k] = encrypt(v)
  }
  if (Object.keys(patch).length) saveSettings(patch)
  return Object.keys(patch)
}

// 防泄漏：给渲染进程的副本，敏感字段一律清空、只留"是否已配置"的布尔
function maskSettings(settings) {
  const out = { ...settings }
  for (const k of SECRET_KEYS) {
    out[`has${k.charAt(0).toUpperCase()}${k.slice(1)}`] = !!out[k]
    out[k] = ''
  }
  return out
}

module.exports = {
  store,
  getHistory,
  addHistory,
  updateHistory,
  removeHistory,
  clearHistory,
  getSettings,
  saveSettings,
  getSecret,
  migrateSecrets,
  maskSettings,
  SECRET_KEYS
}
