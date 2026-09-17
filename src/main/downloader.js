const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { burnSubtitles } = require('./ffmpeg')

function genId() {
  return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

// -------- 解析视频信息 --------
function parseInfo(url, ytdlpPath, proxy) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-warnings', '--no-playlist', '--skip-download']
    if (proxy) args.push('--proxy', proxy)
    args.push(url)
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
// 兼容官方字幕与自动生成字幕两种文案：
//   [info] Writing video subtitles to: xxx.srt
//   [info] Writing video automatic captions to: xxx.srt
const SUB_RE = /Writing (?:video )?(?:auto(?:matic)? )?(?:captions|subtitles) to:\s*(.+)/i

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
function buildArgs({ url, options, template, proxy, ffmpegPath }) {
  const args = ['--newline', '--restrict-filenames', '--no-playlist', '-o', template + '.%(ext)s']
  if (proxy) args.push('--proxy', proxy)
  // 明确告知 yt-dlp ffmpeg 位置，避免打包后因 PATH 中找不到 ffmpeg 导致合并/提取失败
  if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath))

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
    // 同时尝试官方字幕与自动生成字幕（自动字幕作为兜底，避免"只有自动字幕"的视频拿不到字幕），
    // 并统一转换成 srt，便于后续 ffmpeg 烧录。
    args.push('--write-subs', '--write-auto-subs', '--sub-format', 'srt', '--convert-subs', 'srt')
    if (options.subtitle === 'zh') args.push('--sub-langs', 'zh-Hans,zh-CN,zh,zh-Hans-*')
    else if (options.subtitle === 'en') args.push('--sub-langs', 'en,en-*')
    else args.push('--sub-langs', 'zh-Hans,zh-CN,zh,en')
  }

  args.push(url)
  return args
}

// 仅抓取字幕（视频已存在时用于「补字幕」），沿用与下载相同的命名参数，保证字幕文件与视频同名
function buildSubtitleOnlyArgs({ url, options, template, proxy }) {
  const args = ['--newline', '--restrict-filenames', '--no-playlist', '--skip-download', '-o', template + '.%(ext)s']
  if (proxy) args.push('--proxy', proxy)
  args.push('--write-subs', '--write-auto-subs', '--sub-format', 'srt', '--convert-subs', 'srt')
  if (options.subtitle === 'zh') args.push('--sub-langs', 'zh-Hans,zh-CN,zh,zh-Hans-*')
  else if (options.subtitle === 'en') args.push('--sub-langs', 'en,en-*')
  else args.push('--sub-langs', 'zh-Hans,zh-CN,zh,en')
  args.push(url)
  return args
}

function isSubtitleError(text) {
  // 字幕请求被 YouTube 限速/拒绝时，yt-dlp 会报 "Unable to download video subtitles"
  return /Unable to download (?:video )?(?:subtitles|automatic captions)/i.test(text)
}

// -------- 运行中任务表（用于取消） --------
const activeTasks = new Map()

function taskEntry(id) {
  let e = activeTasks.get(id)
  if (!e) {
    e = { ytdlp: null, ffmpeg: null, cancelled: false }
    activeTasks.set(id, e)
  }
  return e
}

function wasCancelled(id) {
  const e = activeTasks.get(id)
  return !!(e && e.cancelled)
}

function finishCancelled(id, onEvent) {
  activeTasks.delete(id)
  onEvent({ type: 'cancelled', id })
}

// 取消某个任务：杀掉它正在跑的 yt-dlp / ffmpeg 子进程
function cancel(id) {
  const e = activeTasks.get(id)
  if (!e) return false
  e.cancelled = true
  for (const key of ['ytdlp', 'ffmpeg']) {
    const p = e[key]
    if (p) {
      try {
        p.kill()
      } catch (err) {}
    }
  }
  return true
}

// 执行一次 yt-dlp，返回 { code, videoPath, subPaths, errOut }
function runYtDlpOnce({ args, ytdlpPath, onEvent, id }) {
  return new Promise((resolve, reject) => {
    let lastDest = ''
    let mergedDest = ''
    const subPaths = []
    let errOut = ''

    const handleLine = (line) => {
      if (!line.trim()) return
      const pr = parseProgressLine(line)
      if (pr) {
        onEvent({ type: 'progress', id, ...pr, status: 'downloading' })
        return
      }
      const dest = line.match(DEST_RE)
      if (dest) lastDest = dest[1].trim()
      const mg = line.match(MERGE_RE)
      if (mg) mergedDest = mg[1].trim()
      const sb = line.match(SUB_RE)
      if (sb) subPaths.push(sb[1].trim())
    }

    const p = spawn(ytdlpPath, args, { shell: false, windowsHide: true })
    const entry = taskEntry(id)
    entry.ytdlp = p
    p.stdout.on('data', (d) => d.toString().split(/\r?\n/).forEach(handleLine))
    p.stderr.on('data', (d) => {
      const text = d.toString()
      errOut += text
      text.split(/\r?\n/).forEach(handleLine)
    })

    p.on('error', (e) => reject(e))
    p.on('close', (code) => {
      if (entry.ytdlp === p) entry.ytdlp = null
      resolve({ code, videoPath: mergedDest || lastDest, subPaths, errOut })
    })
  })
}

async function finalizeVideo({ id, videoPath, subPaths, options, ffmpegPath, onEvent, retried = false }) {
  // 字幕烧录
  if (options.subtitle && options.subtitle !== 'none' && subPaths.length) {
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
      let completed = false
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
          },
          registerProc: (proc) => {
            const e = taskEntry(id)
            e.ffmpeg = proc
            proc.on('close', () => {
              if (e.ffmpeg === proc) e.ffmpeg = null
            })
          }
        })
        completed = true
        fs.unlinkSync(videoPath)
        fs.renameSync(burned, videoPath)
      } catch (e) {
        // 清掉可能产生的半成品，避免留下垃圾文件
        try {
          if (fs.existsSync(burned)) fs.unlinkSync(burned)
        } catch (err) {}
        if (wasCancelled(id)) return finishCancelled(id, onEvent)
        if (!completed) {
          // 烧录失败不阻断：保留原视频并提示
          onEvent({ type: 'status', id, msg: '字幕烧录失败，已保留无字幕版本：' + e.message })
        }
      }
      if (wasCancelled(id)) return finishCancelled(id, onEvent)
    } else {
      onEvent({ type: 'status', id, msg: '未找到对应字幕文件，已保留无字幕版本' })
    }
  }

  activeTasks.delete(id)
  onEvent({
    type: 'complete',
    id,
    filePath: videoPath,
    title: options.title || path.basename(videoPath),
    retried
  })
}

async function runDownloadLoop({ id, url, ytdlpPath, ffmpegPath, options, outDir, proxy, onEvent }) {
  const template = path.join(outDir, '%(title)s [%(id)s]')

  // 第一次：按用户选择尝试下载（含字幕）
  const first = await runYtDlpOnce({
    args: buildArgs({ url, options, template, proxy, ffmpegPath }),
    ytdlpPath,
    onEvent,
    id
  })
  if (wasCancelled(id)) return finishCancelled(id, onEvent)

  // 若因字幕下载失败（典型 429），自动回退为无字幕下载，避免整单失败
  if ((first.code !== 0 || !first.videoPath || !fs.existsSync(first.videoPath)) && isSubtitleError(first.errOut)) {
    const is429 = /429/.test(first.errOut)
    onEvent({
      type: 'warn',
      id,
      retryable: true,
      msg: is429
        ? '字幕被 YouTube 限速（HTTP 429），本次已回退为无字幕下载。可稍后点「重试字幕」补上（无需重下视频），或在设置中配置代理更换 IP。'
        : '字幕下载失败，本次已回退为无字幕下载：' + (parseYtDlpError(first.errOut) || '未知错误')
    })

    const second = await runYtDlpOnce({
      args: buildArgs({ url, options: { ...options, subtitle: 'none' }, template, proxy, ffmpegPath }),
      ytdlpPath,
      onEvent,
      id
    })
    if (wasCancelled(id)) return finishCancelled(id, onEvent)

    if (second.code !== 0) {
      const reason2 = parseYtDlpError(second.errOut) || second.errOut.trim() || 'yt-dlp 退出码非 0'
      const short = reason2.length > 400 ? reason2.slice(0, 400) + '…' : reason2
      return onEvent({ type: 'error', id, message: '下载失败：' + short })
    }
    if (!second.videoPath || !fs.existsSync(second.videoPath)) {
      return onEvent({ type: 'error', id, message: '未找到下载产出文件' })
    }
    return finalizeVideo({
      id,
      videoPath: second.videoPath,
      subPaths: [],
      options: { ...options, subtitle: 'none' },
      ffmpegPath,
      onEvent
    })
  }

  // 非字幕类失败，直接报错
  if (first.code !== 0) {
    const reason = parseYtDlpError(first.errOut) || first.errOut.trim() || 'yt-dlp 退出码非 0'
    const short = reason.length > 400 ? reason.slice(0, 400) + '…' : reason
    return onEvent({ type: 'error', id, message: '下载失败：' + short })
  }

  if (!first.videoPath || !fs.existsSync(first.videoPath)) {
    return onEvent({ type: 'error', id, message: '未找到下载产出文件' })
  }

  return finalizeVideo({ id, videoPath: first.videoPath, subPaths: first.subPaths, options, ffmpegPath, onEvent })
}

// -------- 补字幕：视频已下载完成，仅重新抓取字幕并烧录（不重下视频） --------
async function retrySubtitles({ id, url, ytdlpPath, ffmpegPath, options, outDir, proxy, videoPath, onEvent }) {
  if (!options.subtitle || options.subtitle === 'none') {
    return onEvent({ type: 'warn', id, msg: '该任务未选择字幕' })
  }
  if (!videoPath || !fs.existsSync(videoPath)) {
    return onEvent({ type: 'error', id, message: '原视频文件不存在，无法补字幕' })
  }

  const template = path.join(outDir, '%(title)s [%(id)s]')
  onEvent({ type: 'status', id, msg: '正在重新抓取字幕…' })
  const r = await runYtDlpOnce({
    args: buildSubtitleOnlyArgs({ url, options, template, proxy }),
    ytdlpPath,
    onEvent,
    id
  })
  if (wasCancelled(id)) return finishCancelled(id, onEvent)

  if (isSubtitleError(r.errOut)) {
    const is429 = /429/.test(r.errOut)
    activeTasks.delete(id)
    return onEvent({
      type: 'warn',
      id,
      retryable: true,
      msg: is429
        ? '字幕仍被 YouTube 限速（HTTP 429）。请稍等几分钟再试，或在设置中配置代理更换 IP 后重试。'
        : '字幕抓取失败：' + (parseYtDlpError(r.errOut) || '未知错误')
    })
  }
  if (!r.subPaths.length) {
    activeTasks.delete(id)
    return onEvent({ type: 'warn', id, msg: '未取到字幕文件，该视频可能没有所选中语言的字幕' })
  }

  return finalizeVideo({ id, videoPath, subPaths: r.subPaths, options, ffmpegPath, onEvent, retried: true })
}

// -------- 启动一次下载（含字幕烧录编排，字幕失败时自动回退） --------
function startDownload({ id, url, ytdlpPath, ffmpegPath, options, outDir, proxy, onEvent }) {
  const taskId = id || genId()
  // 后台执行，立即返回 id，避免 IPC 阻塞
  runDownloadLoop({ id: taskId, url, ytdlpPath, ffmpegPath, options, outDir, proxy, onEvent }).catch((e) => {
    onEvent({ type: 'error', id: taskId, message: '下载异常：' + e.message })
  })
  return taskId
}

module.exports = { parseInfo, startDownload, retrySubtitles, cancel, normalizeInfo }
