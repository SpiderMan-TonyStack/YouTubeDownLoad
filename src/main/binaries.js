const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const { URL } = require('url')
const { app } = require('electron')
const AdmZip = require('adm-zip')

// 单个文件下载上限，防止异常/恶意服务端把磁盘写满
const MAX_DOWNLOAD = 768 * 1024 * 1024

// ---- 下载工具（支持重定向、进度回调）----
function downloadFile(url, dest, onProgress, maxBytes = MAX_DOWNLOAD) {
  return new Promise((resolve, reject) => {
    const run = (u, redirects) => {
      if (redirects > 6) return reject(new Error('下载重定向过多'))
      let parsed
      try {
        parsed = new URL(u)
      } catch (e) {
        return reject(e)
      }
      const client = parsed.protocol === 'http:' ? http : https
      const req = client.get(
        u,
        { headers: { 'User-Agent': 'youtube-download', 'Accept-Encoding': 'identity' } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            return run(new URL(res.headers.location, u).href, redirects + 1)
          }
          if (res.statusCode !== 200) {
            res.resume()
            return reject(new Error('下载失败 HTTP ' + res.statusCode))
          }
          const total = parseInt(res.headers['content-length'] || '0', 10)
          if (total && total > maxBytes) {
            res.resume()
            return reject(new Error(`文件过大（${Math.round(total / 1048576)}MB），已拒绝下载`))
          }
          let received = 0
          const file = fs.createWriteStream(dest)
          const abort = (msg) => {
            res.destroy()
            file.destroy()
            fs.unlink(dest, () => {})
            reject(new Error(msg))
          }
          res.on('data', (c) => {
            received += c.length
            if (received > maxBytes) return abort('文件超过大小上限，已中断下载')
            if (total && onProgress) onProgress(received, total)
          })
          res.on('error', (e) => {
            fs.unlink(dest, () => {})
            reject(e)
          })
          file.on('error', (e) => {
            fs.unlink(dest, () => {})
            reject(e)
          })
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve(dest)))
        }
      )
      req.on('error', (e) => reject(e))
      req.setTimeout(30000, () => req.destroy(new Error('下载超时')))
    }
    run(url, 0)
  })
}

// 取一小段文本（用于校验和文件），带重定向与大小上限
function fetchText(url, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const run = (u2, redirects) => {
      if (redirects > 6) return reject(new Error('获取校验和时重定向过多'))
      const client = String(u2).startsWith('http:') ? http : https
      const req = client.get(u2, { headers: { 'User-Agent': 'youtube-download' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return run(new URL(res.headers.location, u2).href, redirects + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error('HTTP ' + res.statusCode))
        }
        let data = ''
        let size = 0
        res.setEncoding('utf8')
        res.on('data', (c) => {
          size += Buffer.byteLength(c)
          if (size > maxBytes) {
            res.destroy()
            return reject(new Error('校验和响应过大'))
          }
          data += c
        })
        res.on('error', reject)
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
      req.setTimeout(20000, () => req.destroy(new Error('获取校验和超时')))
    }
    run(url, 0)
  })
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('data', (d) => h.update(d))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

async function verifySha256(file, expectedHex, label) {
  const got = await sha256File(file)
  if (got.toLowerCase() !== String(expectedHex).trim().toLowerCase()) {
    throw new Error(
      `${label} 校验失败：期望 ${String(expectedHex).slice(0, 16)}…，实际 ${got.slice(0, 16)}…（文件可能被篡改或下载不完整）`
    )
  }
}

function exists(p) {
  return !!p && fs.existsSync(p)
}

function binDir() {
  return path.join(app.getPath('userData'), 'bin')
}

// yt-dlp 官方单文件 exe
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
// 第三方加速镜像：**默认不使用**，需用户在设置里显式开启
const YTDLP_MIRROR = 'https://mirror.ghproxy.com/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
// 校验和必须从**权威站点**取，不能从镜像取 —— 否则镜像投毒时连校验和一起被换掉，等于没校验
const YTDLP_SUMS = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS'

// ffmpeg 静态构建（gyan.dev，非 GitHub，通常可直接访问）
const FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
const FFMPEG_SHA = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256'

function locateYtDlp(settings) {
  if (settings && settings.ytdlpPath && exists(settings.ytdlpPath)) return settings.ytdlpPath
  // 优先用用户目录下「更新过」的版本（点设置里的「更新 yt-dlp 引擎」会下载到此处），其次才是随包内置版本。
  // 这样内置引擎过期时，用户无需重装应用即可换上最新 yt-dlp。
  const bin = path.join(binDir(), 'yt-dlp.exe')
  if (exists(bin)) return bin
  const res = path.join(process.resourcesPath || '', 'resources', 'yt-dlp.exe')
  if (exists(res)) return res
  return null
}

function locateFfmpeg(settings) {
  if (settings && settings.ffmpegPath && exists(settings.ffmpegPath)) return settings.ffmpegPath
  const res = path.join(process.resourcesPath || '', 'resources', 'ffmpeg.exe')
  if (exists(res)) return res
  const bin = path.join(binDir(), 'ffmpeg.exe')
  if (exists(bin)) return bin
  return null
}

// 取 yt-dlp.exe 的官方 SHA-256（从 github.com 直接取，不经镜像）
async function ytDlpChecksum() {
  const txt = await fetchText(YTDLP_SUMS)
  for (const line of txt.split('\n')) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(yt-dlp\.exe)$/i)
    if (m) return m[1]
  }
  throw new Error('官方校验和文件里没有找到 yt-dlp.exe 的记录')
}

// 下载并校验 yt-dlp；优先官方源，镜像仅在用户显式开启时作为兜底，且同样要过校验
async function downloadYtDlp(dest, onProgress, allowMirror = false) {
  onProgress && onProgress(0, 1, '正在获取官方校验和…')
  const expected = await ytDlpChecksum() // 取不到就直接失败，不安装未校验的可执行文件

  await downloadFile(YTDLP_URL, dest, onProgress)
  try {
    await verifySha256(dest, expected, 'yt-dlp.exe')
    return
  } catch (e) {
    fs.unlink(dest, () => {})
    if (!allowMirror) throw e
  }

  // 官方源被污染或下载不完整 → 镜像兜底（校验和仍是官方的）
  await downloadFile(YTDLP_MIRROR, dest, onProgress)
  await verifySha256(dest, expected, 'yt-dlp.exe（镜像）')
}

// 强制把 yt-dlp 更新到最新版，写入用户数据目录（优先级高于随包内置版本）
async function updateYtDlp(onStatus, allowMirror = false) {
  fs.mkdirSync(binDir(), { recursive: true })
  const dest = path.join(binDir(), 'yt-dlp.exe')
  const tmp = dest + '.new'
  onStatus && onStatus('正在下载最新 yt-dlp…')
  await downloadYtDlp(
    tmp,
    (r, t) => t > 1 && onStatus && onStatus(`正在下载最新 yt-dlp ${Math.round((r / t) * 100)}%`),
    allowMirror
  )
  // 先校验通过再原子替换，避免中途失败留下损坏的 exe
  fs.renameSync(tmp, dest)
  return dest
}

function findFfmpegExe(root) {
  let found = null
  const walk = (dir) => {
    if (found) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const e of entries) {
      if (found) return
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'ffmpeg.exe') found = p
    }
  }
  walk(root)
  return found
}

async function downloadFfmpeg(destExe, onProgress) {
  const dir = path.dirname(destExe)
  const zip = path.join(dir, 'ffmpeg-essentials.zip')
  onProgress && onProgress(0, 1, '正在获取官方校验和…')
  // 先拿 gyang.dev 官方的 zip 校验和，再去下 zip —— 校验不过就不解压、不执行
  const expected = (await fetchText(FFMPEG_SHA)).trim().split(/\s+/)[0]
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('ffmpeg 官方校验和格式异常')
  await downloadFile(FFMPEG_ZIP, zip, onProgress)
  try {
    await verifySha256(zip, expected, 'ffmpeg 压缩包')
  } catch (e) {
    fs.unlink(zip, () => {})
    throw e
  }
  const extractDir = path.join(dir, 'ffmpeg-tmp')
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true })
  const adm = new AdmZip(zip)
  adm.extractAllTo(extractDir, true)
  const found = findFfmpegExe(extractDir)
  if (!found) throw new Error('ffmpeg 解压后未找到 ffmpeg.exe')
  fs.copyFileSync(found, destExe)
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.unlinkSync(zip)
}

// 确保两个引擎存在；缺失则自动下载。onStatus(msg) 用于回传进度文案
async function ensureBinaries(settings, onStatus) {
  const result = {}
  const allowMirror = !!(settings && settings.binaryMirrorEnabled)
  let yt = locateYtDlp(settings)
  let ff = locateFfmpeg(settings)

  if (!yt) {
    fs.mkdirSync(binDir(), { recursive: true })
    yt = path.join(binDir(), 'yt-dlp.exe')
    onStatus && onStatus('正在下载 yt-dlp 引擎…')
    await downloadYtDlp(
      yt,
      (r, t, note) => {
        if (note) return onStatus && onStatus(note)
        if (t > 1) onStatus && onStatus(`正在下载 yt-dlp ${Math.round((r / t) * 100)}%`)
      },
      allowMirror
    )
  }
  if (!ff) {
    fs.mkdirSync(binDir(), { recursive: true })
    ff = path.join(binDir(), 'ffmpeg.exe')
    onStatus && onStatus('正在下载 ffmpeg 引擎…')
    await downloadFfmpeg(ff, (r, t, note) => {
      if (note) return onStatus && onStatus(note)
      if (t > 1) onStatus && onStatus(`正在下载 ffmpeg ${Math.round((r / t) * 100)}%`)
    })
  }
  result.ytDlp = yt
  result.ffmpeg = ff
  return result
}

module.exports = {
  downloadFile,
  locateYtDlp,
  locateFfmpeg,
  ensureBinaries,
  updateYtDlp,
  ytDlpChecksum,
  sha256File,
  verifySha256
}
