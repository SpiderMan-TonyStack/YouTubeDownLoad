const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { burnSubtitles } = require('./ffmpeg')

function genId() {
  return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

// -------- 解析视频信息 --------
function parseInfo(url, ytdlpPath) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-warnings', '--no-playlist', '--skip-download', url]
    const p = spawn(ytdlpPath, args, { shell: false, windowsHide: true })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(parseYtDlpError(err) || '解析失败（链接无效或网络不可达）'))
      }
      try {
        const info = JSON.parse(out)
        resolve(normalizeInfo(info))
      } catch (e) {
        reject(new Error('解析结果解析失败'))
      }
    })
    p.on('error', (e) => reject(e))
  })
}

function normalizeInfo(info) {
  const fmts = info.formats || []
  const heights = [
    ...new Set(fmts.map((f) => f.height).filter((h) => typeof h === 'number'))
  ].sort((a, b) => b - a)
  const subs = Object.keys(info.subtitles || {})
  const auto = Object.keys(info.automatic_captions || {})
  return {
    id: info.id,
    title: info.title,
    duration: info.duration || 0,
    thumbnail: info.thumbnail,
    webpageUrl: info.webpage_url,
    uploader: info.uploader,
    heights,
    subtitles: subs,
    automaticCaptions: auto
  }
}

function parseYtDlpError(err) {
  const m = err.match(/ERROR:\s*(.+)/)
  return m ? m[1].split('\n')[0] : null
}

// -------- 进度解析 --------
const PROGRESS_RE = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+([\d.]+)\s*(\w+)?(?:\s+at\s+([\d.]+)\s*(\w+\/s))?(?:\s+ETA\s+([\d:]+))?/
const DEST_RE = /Destination:\s*(.+)/i
const MERGE_RE = /Merging formats into "([^"]+)"/i
const SUB_RE = /Writing video subtitles to:\s*(.+)/i

function parseProgressLine(line) {
  const m = line.match(PROGRESS_RE)
  if (!m) return null
  return {
    percent: parseFloat(m[1]),
    speed: m[4] ? `${m[4]} ${m[5] || ''}`.trim() : '',
    eta: m[6] || ''
  }
}

// -------- 构建 yt-dlp 参数 --------
function buildArgs({ url, options, template, proxy }) {
  const args = ['--newline', '--restrict-filenames', '--no-playlist', '-o', template + '.%(ext)s']
  if (proxy) args.push('--proxy', proxy)

  if (options.mode === 'audio') {
    args.push('-f', 'bestaudio', '-x', '--audio-format', 'mp3')
  } else {
    const fmt =
      options.height && options.height !== 'best'
        ? `bestvideo[height<=${options.height}]+bestaudio/best[height<=${options.height}]`
        : 'bestvideo+bestaudio/best'
    args.push('-f', fmt, '--merge-output-format', 'mp4')
  }

  if (options.mode === 'video' && options.subtitle && options.subtitle !== 'none') {
    args.push('--write-subs', '--sub-format', 'srt')
    if (options.useAutoCaptions) args.push('--write-auto-subs')
    if (options.subtitle === 'zh') args.push('--sub-langs', 'zh-Hans,zh-CN,zh,zh-Hans-*')
    else if (options.subtitle === 'en') args.push('--sub-langs', 'en,en-*')
    else args.push('--sub-langs', 'zh-Hans,zh-CN,zh,en')
  }

  args.push(url)
  return args
}

// -------- 启动一次下载（含字幕烧录编排） --------
function startDownload({ url, ytdlpPath, ffmpegPath, options, outDir, proxy, onEvent }) {
  const id = genId()
  const template = path.join(outDir, '%(title)s [%(id)s]')
  const args = buildArgs({ url, options, template, proxy })

  const p = spawn(ytdlpPath, args, { shell: false, windowsHide: true })
  let lastDest = ''
  let mergedDest = ''
  const subPaths = []

  p.stdout.on('data', (d) => {
    const lines = d.toString().split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      const pr = parseProgressLine(line)
      if (pr) {
        onEvent({ type: 'progress', id, ...pr, status: 'downloading' })
        continue
      }
      const dest = line.match(DEST_RE)
      if (dest) lastDest = dest[1].trim()
      const mg = line.match(MERGE_RE)
      if (mg) mergedDest = mg[1].trim()
      const sb = line.match(SUB_RE)
      if (sb) subPaths.push(sb[1].trim())
    }
  })

  p.stderr.on('data', (d) => {
    const lines = d.toString().split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      const pr = parseProgressLine(line)
      if (pr) {
        onEvent({ type: 'progress', id, ...pr, status: 'downloading' })
      }
    }
  })

  p.on('error', (e) => onEvent({ type: 'error', id, message: e.message }))

  p.on('close', async (code) => {
    if (code !== 0) {
      return onEvent({ type: 'error', id, message: '下载进程异常退出（可能网络超时或链接失效）' })
    }
    const videoPath = mergedDest || lastDest
    if (!videoPath || !fs.existsSync(videoPath)) {
      return onEvent({ type: 'error', id, message: '未找到下载产出文件' })
    }

    // 字幕烧录
    if (options.subtitle && options.subtitle !== 'none' && subPaths.length) {
      const base = path.basename(videoPath)
      const zhSub = subPaths.find((s) => /zh/i.test(path.basename(s)))
      const enSub = subPaths.find((s) => /en/i.test(path.basename(s)) && !/zh/i.test(path.basename(s)))
      const subs = {}
      if (options.subtitle === 'zh' && zhSub) subs.zh = zhSub
      else if (options.subtitle === 'en' && enSub) subs.en = enSub
      else {
        if (zhSub) subs.zh = zhSub
        if (enSub) subs.en = enSub
      }

      if (Object.keys(subs).length) {
        const burned = videoPath + '.burning.mp4'
        try {
          onEvent({ type: 'status', id, msg: '正在烧录字幕…' })
          await burnSubtitles({
            ffmpegPath,
            videoPath,
            subs,
            outPath: burned,
            duration: options.duration || 0,
            onEvent: (t, data) => {
              if (t === 'burn-progress') onEvent({ type: 'burn-progress', id, percent: data.percent })
            }
          })
          fs.unlinkSync(videoPath)
          fs.renameSync(burned, videoPath)
        } catch (e) {
          // 烧录失败不阻断：保留原视频并提示
          onEvent({ type: 'status', id, msg: '字幕烧录失败，已保留无字幕版本：' + e.message })
        }
      } else {
        onEvent({ type: 'status', id, msg: '未找到对应字幕文件，已保留无字幕版本' })
      }
    }

    onEvent({ type: 'complete', id, filePath: videoPath, title: options.title || path.basename(videoPath) })
  })

  return id
}

module.exports = { parseInfo, startDownload, normalizeInfo }
