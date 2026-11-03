const { spawn } = require('child_process')
const { StringDecoder } = require('string_decoder')
const fs = require('fs')
const path = require('path')
const { burnSubtitles } = require('./ffmpeg')
const { translateSrtFile, translatedSubPath } = require('./translator')

// 把子进程输出按「行」切分，跨 chunk 的残行留到下一次一起处理。
//
// 不能直接 `d.toString().split(/\r?\n/)`，有两个坑：
//   1) 一行被 chunk 边界劈开 → 得到两条半行，Destination / Merging formats /
//      Writing subtitles 捕获到**截断的路径** → 找不到产物，任务报"未找到下载产出文件"；
//   2) 多字节 UTF-8 被劈开 → 两个半字符各自变成 U+FFFD(�)，表现为**标题乱码**。
//      而且 JSON.parse 不会失败，属于静默损坏，很难排查。
// 用 StringDecoder 处理解码，再自己留残行缓冲，两个问题一起解决。
function makeLineBuffer(onLine) {
  let buf = ''
  return {
    write(text) {
      if (!text) return
      buf += text
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''))
        buf = buf.slice(i + 1)
      }
    },
    // 收尾时把最后一段没有换行结尾的内容也吐出去
    flush() {
      if (buf) {
        onLine(buf.replace(/\r$/, ''))
        buf = ''
      }
    }
  }
}

function genId() {
  return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

// -------- 解析视频信息 --------
function parseInfo(url, ytdlpPath, proxy, cookies) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-warnings', '--no-playlist', '--skip-download']
    if (proxy) args.push('--proxy', proxy)
    args.push(...cookieArgs(cookies))
    args.push(url)
    const p = spawn(ytdlpPath, args, { shell: false, windowsHide: true })
    let out = ''
    let err = ''
    const outDec = new StringDecoder('utf8')
    const errDec = new StringDecoder('utf8')
    p.stdout.on('data', (d) => (out += outDec.write(d)))
    p.stderr.on('data', (d) => (err += errDec.write(d)))
    p.on('close', (code) => {
      // 收尾时把解码器里剩余的字节吐出来，避免最后一个字符丢失
      out += outDec.end()
      err += errDec.end()
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

// 字幕语言顺序很关键：**en（原生 ASR）放最前**。
// YouTube 会对「自动翻译轨」(zh-Hans/zh-Hant) 做 IP 级限速（HTTP 429），
// 但原生轨不受影响。把 en 排在前面，yt-dlp 会先成功写出 en.srt，
// 之后即便中文轨 429 导致整条命令失败，en.srt 也已经落盘可以拿来用。
function subtitleLangList(subtitle) {
  if (subtitle === 'en') return 'en,en-*'
  if (subtitle === 'zh') return 'en,zh-Hans,zh-CN,zh,zh-Hans-*'
  return 'en,zh-Hans,zh-CN,zh'
}

// -------- 构建 yt-dlp 参数 --------
// YouTube 的登录 Cookie 参数。cookies = { mode: 'none'|'file'|'browser', browser, file }
// file 模式优先：cookies.txt 是绕开浏览器 DPAPI 加密的可靠路径。
function cookieArgs(cookies) {
  if (!cookies) return []
  if (cookies.mode === 'file' && cookies.file && fs.existsSync(cookies.file)) {
    return ['--cookies', cookies.file]
  }
  if (cookies.mode === 'browser' && cookies.browser) {
    return ['--cookies-from-browser', cookies.browser]
  }
  return []
}

// YouTube 的机器人校验错误（需要带登录 Cookie 才能过）
function isBotCheckError(text) {
  return /Sign in to confirm|not a bot|confirm you.{0,4}re not a bot/i.test(String(text || ''))
}

// 把 yt-dlp 的英文报错换成用户能照着做的中文引导
function friendlyYtdlpError(err) {
  const msg = String((err && err.message) || err || '')
  if (isBotCheckError(msg)) {
    return (
      'YouTube 要求验证"你不是机器人"，需要带上你的登录 Cookie 才能继续。\n' +
      '请到「设置 → YouTube 登录状态」里配置：\n' +
      '  · 推荐：用浏览器扩展导出 cookies.txt，然后把文件路径填进去；\n' +
      '  · 或选择"从浏览器读取"（Chrome 127+ 的加密常导致失败，失败时改用 cookies.txt）。\n' +
      '另外确认你已在浏览器里登录 YouTube，并且账号没有被限制。'
    )
  }
  if (/Could not copy Chrome cookie database/i.test(msg)) {
    return '读取 Chrome 的 Cookie 失败（数据库被浏览器占用）。请完全退出 Chrome 后重试，或改用 cookies.txt 文件。'
  }
  if (/Failed to decrypt with DPAPI/i.test(msg)) {
    return (
      'Chrome/Edge 127+ 对 Cookie 做了应用绑定加密，无法直接读取。\n' +
      '请改用 cookies.txt：用浏览器扩展导出（Netscape 格式），再在设置里选择该文件。'
    )
  }
  return msg
}

function buildArgs({ url, options, template, proxy, ffmpegPath, cookies }) {
  const args = ['--newline', '--restrict-filenames', '--no-playlist', '-o', template + '.%(ext)s']
  if (proxy) args.push('--proxy', proxy)
  // 明确告知 yt-dlp ffmpeg 位置，避免打包后因 PATH 中找不到 ffmpeg 导致合并/提取失败
  if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath))
  args.push(...cookieArgs(cookies))

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
    args.push('--sub-langs', subtitleLangList(options.subtitle))
  }

  args.push(url)
  return args
}

// 仅抓取字幕（视频已存在时用于「补字幕」），沿用与下载相同的命名参数，保证字幕文件与视频同名
function buildSubtitleOnlyArgs({ url, options, template, proxy, cookies }) {
  const args = ['--newline', '--restrict-filenames', '--no-playlist', '--skip-download', '-o', template + '.%(ext)s']
  if (proxy) args.push('--proxy', proxy)
  args.push(...cookieArgs(cookies))
  args.push('--write-subs', '--write-auto-subs', '--sub-format', 'srt', '--convert-subs', 'srt')
  args.push('--sub-langs', subtitleLangList(options.subtitle))
  args.push(url)
  return args
}

function isSubtitleError(text) {
  // 字幕请求被 YouTube 限速/拒绝时，yt-dlp 会报 "Unable to download video subtitles"
  return /Unable to download (?:video )?(?:subtitles|automatic captions)/i.test(text)
}

// 错误输出只保留尾部：长视频 + 大量 warning 时无上限累积会一直涨，
// 而真正有用的错误信息都在最后几百字符里。
const ERR_TAIL = 32 * 1024

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

    // stdout / stderr 各自一套解码器 + 残行缓冲（两个流不能共用一个 StringDecoder）
    const outDec = new StringDecoder('utf8')
    const outLines = makeLineBuffer(handleLine)
    const errDec = new StringDecoder('utf8')
    const errLines = makeLineBuffer(handleLine)

    p.stdout.on('data', (d) => outLines.write(outDec.write(d)))
    p.stderr.on('data', (d) => {
      const s = errDec.write(d)
      errOut = (errOut + s).slice(-ERR_TAIL)
      errLines.write(s)
    })

    p.on('error', (e) => reject(e))
    p.on('close', (code) => {
      if (entry.ytdlp === p) entry.ytdlp = null
      // 把两个流残留的半行吐完再收尾（例如最后一行没有换行结尾）
      outLines.write(outDec.end())
      outLines.flush()
      errLines.write(errDec.end())
      errLines.flush()
      // merged 表示「音视频已经合流完成」——这是区分「成品」与「仅某一路流」的关键信号
      resolve({ code, videoPath: mergedDest || lastDest, merged: !!mergedDest, subPaths, errOut })
    })
  })
}

// 中文字幕缺失时（多因 YouTube 对翻译轨 429 限速），用英文字幕本地翻译出中文。
// 返回翻译后 srt 的路径；任何失败都返回 null，调用方继续按「只有英文字幕」处理。
async function ensureTranslatedSub({ id, videoPath, enSub, translate, proxy, onEvent }) {
  const outPath = translatedSubPath(videoPath)

  // 已翻译过就直接复用：同一视频补字幕时不再重复请求、不重复消耗额度
  try {
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      onEvent({ type: 'status', id, msg: '已复用本地已有的中文字幕（英文字幕翻译）' })
      return outPath
    }
  } catch (e) {}

  try {
    onEvent({ type: 'translate-start', id })
    onEvent({ type: 'status', id, msg: '中文字幕被限速，正在用英文字幕翻译成中文…' })
    const r = await translateSrtFile({
      srtPath: enSub,
      outPath,
      provider: translate.provider,
      config: {
        baseUrl: translate.baseUrl,
        apiKey: translate.apiKey,
        model: translate.model
      },
      proxy,
      shouldStop: () => wasCancelled(id),
      onProgress: (done, total) => onEvent({ type: 'translate-progress', id, done, total })
    })
    onEvent({
      type: 'warn',
      id,
      retryable: false,
      noteKind: 'ok',
      msg: `中文字幕被 YouTube 限速，已用英文字幕自动翻译成中文并烧录（${r.cues} 条，${
        translate.provider === 'ai' ? 'AI 翻译' : '免费翻译'
      }）。`
    })
    return outPath
  } catch (e) {
    if (wasCancelled(id)) return null
    if (e && e.message === 'CANCELLED') return null
    onEvent({
      type: 'warn',
      id,
      retryable: true,
      msg: '中文字幕翻译失败（' + e.message + '），本次仍使用英文字幕。可在设置里检查「字幕翻译」配置或代理。'
    })
    return null
  }
}

async function finalizeVideo({
  id,
  videoPath,
  subPaths,
  options,
  ffmpegPath,
  onEvent,
  retried = false,
  translate = null,
  proxy = ''
}) {
  // 字幕烧录
  if (options.subtitle && options.subtitle !== 'none' && subPaths.length) {
    let zhSub = subPaths.find((s) => /zh/i.test(path.basename(s)))
    const enSub = subPaths.find((s) => /en/i.test(path.basename(s)) && !/zh/i.test(path.basename(s)))

    // 需要中文但没拿到中文字幕 → 用英文字幕本地翻译，绕开被限速的翻译轨
    if (!zhSub && enSub && translate && translate.enabled) {
      zhSub = await ensureTranslatedSub({ id, videoPath, enSub, translate, proxy, onEvent })
      if (wasCancelled(id)) return finishCancelled(id, onEvent)
    }

    // subs.zh = 主字幕轨（单轨时独占画面底部）；subs.en = 副字幕轨。
    // 中英都有时，ffmpeg.js 会把两轨合成一份双语 srt 再烧 —— 这样两种语言在画面底部
    // 上下相邻、不会互相压住（不能靠「两个滤镜各自 Alignment=2」实现，那样会叠在一起）。
    // 槽位与文件语言无关：例如「仅英文」时英文也放主槽。
    const subs = {}
    const primary = zhSub || enSub
    if (options.subtitle === 'en') {
      if (primary) subs.zh = primary
    } else {
      if (primary) subs.zh = primary
      if (options.subtitle === 'both' && zhSub && enSub) subs.en = enSub
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

async function runDownloadLoop({ id, url, ytdlpPath, ffmpegPath, options, outDir, proxy, translate, cookies, onEvent }) {
  const template = path.join(outDir, '%(title)s [%(id)s]')

  // 第一次：按用户选择尝试下载（含字幕）
  const first = await runYtDlpOnce({
    args: buildArgs({ url, options, template, proxy, ffmpegPath, cookies }),
    ytdlpPath,
    onEvent,
    id
  })
  if (wasCancelled(id)) return finishCancelled(id, onEvent)

  // 若因字幕下载失败（典型 429 自动翻译轨），自动回退为「无字幕下载视频」，
  // 但先检查字幕阶段是否已经落盘了可用文件（en 原生轨排在前面，通常会成功）。
  if ((first.code !== 0 || !first.videoPath || !fs.existsSync(first.videoPath)) && isSubtitleError(first.errOut)) {
    const is429 = /429/.test(first.errOut)
    const partial = first.subPaths.filter((p) => fs.existsSync(p))
    const wantsZh = options.subtitle === 'zh' || options.subtitle === 'both'
    const gotZh = partial.some((p) => /zh/i.test(path.basename(p)))
    const degraded = wantsZh && !gotZh && partial.length > 0
    // 有英文字幕 + 开了翻译 → 这次会自己翻出中文，别提前说「只能用英文」
    const willTranslate = degraded && translate && translate.enabled

    onEvent({
      type: 'warn',
      id,
      retryable: !willTranslate,
      msg: willTranslate
        ? '中文字幕被 YouTube 限速（HTTP 429），稍后会用英文字幕自动翻译成中文。'
        : degraded
          ? '中文字幕被 YouTube 限速（HTTP 429），本次已改用英文原生字幕；稍后可点「重试字幕」再试中文。'
          : is429
            ? '字幕被 YouTube 限速（HTTP 429），本次已回退为无字幕下载。可稍后点「重试字幕」补上（无需重下视频），或在设置中配置代理更换 IP。'
            : '字幕下载失败，本次已回退为无字幕下载：' + (parseYtDlpError(first.errOut) || '未知错误')
    })

    // 关键：字幕失败发生在「音视频已合流之后」，此时成品已在磁盘上。
    // 之前一律重跑一遍 yt-dlp，等于把整个视频再下一次（进度条会走两趟 0%→100%）。
    // 只要 merged 为真且文件存在，就直接进字幕收尾，省掉一次完整传输与合流。
    if (first.merged && first.videoPath && fs.existsSync(first.videoPath)) {
      onEvent({ type: 'status', id, msg: '视频已下载完成，正在处理字幕…' })
      return finalizeVideo({
        id,
        videoPath: first.videoPath,
        subPaths: partial,
        options,
        ffmpegPath,
        onEvent,
        translate,
        proxy
      })
    }

    const second = await runYtDlpOnce({
      args: buildArgs({ url, options: { ...options, subtitle: 'none' }, template, proxy, ffmpegPath, cookies }),
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

    // 有可用字幕就烧上去（可能只是英文）；一个都没有则直接完成视频
    return finalizeVideo({
      id,
      videoPath: second.videoPath,
      subPaths: partial,
      options,
      ffmpegPath,
      onEvent,
      translate,
      proxy
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

  return finalizeVideo({
    id,
    videoPath: first.videoPath,
    subPaths: first.subPaths,
    options,
    ffmpegPath,
    onEvent,
    translate,
    proxy
  })
}

// 兜底：yt-dlp 若判定字幕「已下载」会跳过、不再输出 Writing 行，
// 这时直接按文件名在目录里找一遍（<视频名>.<lang>.srt）
// 注意排除本应用自己产出的 .zh-translated.srt（翻译缓存），
// 否则它会被当成「真的中文字幕轨」，抢在真正下载到的 zh-Hans.srt 前面。
function findSubtitleFiles(outDir, videoPath) {
  const base = path.basename(videoPath, path.extname(videoPath))
  try {
    return fs
      .readdirSync(outDir)
      .filter(
        (f) =>
          f.startsWith(base + '.') &&
          f.toLowerCase().endsWith('.srt') &&
          !f.toLowerCase().endsWith('.zh-translated.srt')
      )
      .map((f) => path.join(outDir, f))
  } catch (e) {
    return []
  }
}

// -------- 补字幕：视频已下载完成，仅重新抓取字幕并烧录（不重下视频） --------
async function retrySubtitles({
  id,
  url,
  ytdlpPath,
  ffmpegPath,
  options,
  outDir,
  proxy,
  videoPath,
  translate,
  cookies,
  onEvent
}) {
  if (!options.subtitle || options.subtitle === 'none') {
    return onEvent({ type: 'warn', id, msg: '该任务未选择字幕' })
  }
  if (!videoPath || !fs.existsSync(videoPath)) {
    return onEvent({ type: 'error', id, message: '原视频文件不存在，无法补字幕' })
  }

  const template = path.join(outDir, '%(title)s [%(id)s]')
  onEvent({ type: 'status', id, msg: '正在重新抓取字幕…' })
  const r = await runYtDlpOnce({
    args: buildSubtitleOnlyArgs({ url, options, template, proxy, cookies }),
    ytdlpPath,
    onEvent,
    id
  })
  if (wasCancelled(id)) return finishCancelled(id, onEvent)

  // yt-dlp 输出的字幕路径 + 目录里已存在的同名字幕（后者覆盖「已下载被跳过」的情况）
  let found = r.subPaths.filter((p) => fs.existsSync(p))
  if (!found.length) found = findSubtitleFiles(outDir, videoPath)

  if (isSubtitleError(r.errOut)) {
    const is429 = /429/.test(r.errOut)
    // en 原生轨排在最前，通常已经落盘；有就先用上，别白白丢掉
    const wantsZh = options.subtitle === 'zh' || options.subtitle === 'both'
    const gotZh = found.some((p) => /zh/i.test(path.basename(p)))

    if (found.length) {
      if (wantsZh && !gotZh) {
        const willTranslate = translate && translate.enabled
        onEvent({
          type: 'warn',
          id,
          retryable: !willTranslate,
          msg: willTranslate
            ? '中文字幕仍被 YouTube 限速（HTTP 429），改用英文字幕自动翻译成中文…'
            : '中文字幕仍被 YouTube 限速（HTTP 429），本次已改用英文原生字幕；稍后可再点「重试字幕」试中文。'
        })
      }
      return finalizeVideo({
        id,
        videoPath,
        subPaths: found,
        options,
        ffmpegPath,
        onEvent,
        retried: true,
        translate,
        proxy
      })
    }

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
  if (!found.length) {
    activeTasks.delete(id)
    return onEvent({ type: 'warn', id, msg: '未取到字幕文件，该视频可能没有所选中语言的字幕' })
  }

  return finalizeVideo({
    id,
    videoPath,
    subPaths: found,
    options,
    ffmpegPath,
    onEvent,
    retried: true,
    translate,
    proxy
  })
}

// -------- 启动一次下载（含字幕烧录编排，字幕失败时自动回退） --------
function startDownload({ id, url, ytdlpPath, ffmpegPath, options, outDir, proxy, translate, cookies, onEvent }) {
  const taskId = id || genId()
  // 后台执行，立即返回 id，避免 IPC 阻塞
  runDownloadLoop({ id: taskId, url, ytdlpPath, ffmpegPath, options, outDir, proxy, translate, cookies, onEvent }).catch(
    (e) => {
      onEvent({ type: 'error', id: taskId, message: '下载异常：' + e.message })
    }
  )
  return taskId
}

module.exports = {
  parseInfo,
  cookieArgs,
  friendlyYtdlpError,
  isBotCheckError,
  startDownload,
  retrySubtitles,
  cancel,
  normalizeInfo,
  // 导出以便直接驱动「字幕收尾」环节做回归测试（翻译 → 烧录）
  finalizeVideo
}
