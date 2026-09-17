const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const { URL } = require('url')
const { app } = require('electron')
const AdmZip = require('adm-zip')

// ---- 下载工具（支持重定向、进度回调）----
function downloadFile(url, dest, onProgress) {
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
          let received = 0
          const file = fs.createWriteStream(dest)
          res.on('data', (c) => {
            received += c.length
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

function exists(p) {
  return !!p && fs.existsSync(p)
}

function binDir() {
  return path.join(app.getPath('userData'), 'bin')
}

// yt-dlp 官方单文件 exe（含 gproxy 镜像兜底）
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
const YTDLP_MIRROR = 'https://mirror.ghproxy.com/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

// ffmpeg 静态构建（gyan.dev，非 GitHub，通常可直接访问）
const FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

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

async function downloadYtDlp(dest, onProgress) {
  try {
    await downloadFile(YTDLP_URL, dest, onProgress)
  } catch (e) {
    await downloadFile(YTDLP_MIRROR, dest, onProgress)
  }
}

// 强制把 yt-dlp 更新到最新版，写入用户数据目录（优先级高于随包内置版本）
async function updateYtDlp(onStatus) {
  fs.mkdirSync(binDir(), { recursive: true })
  const dest = path.join(binDir(), 'yt-dlp.exe')
  const tmp = dest + '.new'
  onStatus && onStatus('正在下载最新 yt-dlp…')
  await downloadYtDlp(tmp, (r, t) =>
    onStatus && onStatus(`正在下载最新 yt-dlp ${Math.round((r / t) * 100)}%`)
  )
  fs.copyFileSync(tmp, dest)
  fs.unlinkSync(tmp)
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
  await downloadFile(FFMPEG_ZIP, zip, onProgress)
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
  let yt = locateYtDlp(settings)
  let ff = locateFfmpeg(settings)

  if (!yt) {
    fs.mkdirSync(binDir(), { recursive: true })
    yt = path.join(binDir(), 'yt-dlp.exe')
    onStatus && onStatus('正在下载 yt-dlp 引擎…')
    await downloadYtDlp(yt, (r, t) =>
      onStatus && onStatus(`正在下载 yt-dlp ${Math.round((r / t) * 100)}%`)
    )
  }
  if (!ff) {
    fs.mkdirSync(binDir(), { recursive: true })
    ff = path.join(binDir(), 'ffmpeg.exe')
    onStatus && onStatus('正在下载 ffmpeg 引擎…')
    await downloadFfmpeg(ff, (r, t) =>
      onStatus && onStatus(`正在下载 ffmpeg ${Math.round((r / t) * 100)}%`)
    )
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
  updateYtDlp
}
