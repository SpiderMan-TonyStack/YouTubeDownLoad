// 敏感配置（AI API Key / 代理控制接口密钥）的加密存取。
//
// electron-store 默认写的是明文 JSON，任何能读到 %APPDATA%\youtube-download 的进程
// 都能直接把密钥读走。这里改用 Electron 的 safeStorage（Windows 下走 DPAPI，
// 绑定当前登录用户）加密后再落盘。
//
// 存储格式：`v1:<base64>`。没有前缀的视为历史明文，读取时兼容，启动时由 store
// 的 migrateSecrets() 自动升级成密文。

const { safeStorage } = require('electron')

const PREFIX = 'v1:'

function available() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch (e) {
    return false
  }
}

// 明文 → 存盘用的字符串。空值返回空串（表示"未配置"）
function encrypt(plain) {
  const s = String(plain == null ? '' : plain)
  if (!s) return ''
  if (!available()) return s // 系统不支持加密时退回明文，至少不丢功能
  try {
    return PREFIX + safeStorage.encryptString(s).toString('base64')
  } catch (e) {
    return s
  }
}

// 存盘用的字符串 → 明文。历史明文原样返回
function decrypt(stored) {
  const s = String(stored == null ? '' : stored)
  if (!s) return ''
  if (!s.startsWith(PREFIX)) return s
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(PREFIX.length), 'base64'))
  } catch (e) {
    // 换了 Windows 用户、或系统凭据被重置 → 解不开，当作"未配置"
    return ''
  }
}

function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX)
}

module.exports = { encrypt, decrypt, isEncrypted, available }
