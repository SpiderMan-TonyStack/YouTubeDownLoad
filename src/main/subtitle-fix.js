// 修复 YouTube 自动字幕（ASR）的「滚动窗口」时间轴重叠。
//
// YouTube 自动生成字幕的 cue 会互相互相「借时间」——第 N 条还没结束，第 N+1 条就开始了：
//   1  00:00:02,120 --> 00:00:08,280
//   2  00:00:05,799 --> 00:00:11,320     ← 比上一条的结束时间早 2.5s 开始
// yt-dlp 转成 srt 时把这段重叠原样保留。ffmpeg 的 subtitles 滤镜（libass）会把「同一时刻
// 处于激活状态」的所有对话一起画出来，于是出现：
//   1. 屏幕上下同时出现两条字幕（看起来像"重复"）；
//   2. 底部对齐（Alignment=2）的多条事件在 libass 里是**从下往上**堆叠的，
//      后开始的那条排在上面 → 字幕顺序颠倒；
//   3. 选「中英双字幕」时是两条轨各叠两条，合计 4 行，挡住半个画面。
//
// 修复方式：把每条 cue 的结束时间裁到「下一条的开始时间 - 30ms」，让时间轴严格串行。
// 文本一个字都不改，只改结束时间；因为 cue 已按开始时间升序，裁到下一条开始即能保证
// 任意时刻最多只有一条 cue 处于激活状态（即使原文件有 3 条以上叠加也成立）。

const fs = require('fs')

const GAP_MS = 30 // 相邻 cue 之间留的空隙，避免交界处闪一帧双字幕
// 只有「大面积重叠」才认定是滚动字幕并动手裁剪。手工字幕里偶尔会有两条
// 刻意重叠（两人抢话、背景音效），那种不该动 —— 所以按占比判定而不是按单条。
const ROLLING_RATIO = 0.3
const TIME_RE =
  /^\s*(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/

function toMs(h, m, s, frac) {
  return +h * 3600000 + +m * 60000 + +s * 1000 + +String(frac).padEnd(3, '0').slice(0, 3)
}

function formatTime(ms) {
  if (!(ms > 0)) ms = 0
  const pad = (n, w) => String(n).padStart(w, '0')
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`
}

// 解析 srt → [{ start, end, text }]（时间单位 ms，跳过空 cue）
function parseSrt(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const cues = []
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (!lines.length) continue
    // 序号行可选（有些工具不写）
    const idx = /^\d+$/.test(lines[0].trim()) && lines.length > 1 ? 1 : 0
    const m = (lines[idx] || '').match(TIME_RE)
    if (!m) continue
    const body = lines
      .slice(idx + 1)
      .join('\n')
      .trim()
    if (!body) continue
    const start = toMs(m[1], m[2], m[3], m[4])
    cues.push({ start, end: Math.max(toMs(m[5], m[6], m[7], m[8]), start), text: body })
  }
  return cues
}

function toSrt(cues) {
  return (
    cues
      .map((c, i) => `${i + 1}\n${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text}`)
      .join('\n\n') + '\n'
  )
}

// 裁掉与前一条重叠的部分：end_i 最多到 start_{i+1} - GAP
// 若两条起始时间挤在一起、连最短间隙都放不下（如两条 cue 同一时刻开始），
// 就把文本并成一条、时间取并集 —— **绝不能压成 0 时长**，那等于字幕凭空消失。
function clipOverlaps(cues) {
  const out = []
  let trimmed = 0
  let merged = 0
  for (const c of cues) {
    const prev = out[out.length - 1]
    if (prev && prev.end > c.start) {
      const limit = c.start - GAP_MS
      if (limit > prev.start) {
        prev.end = limit
        trimmed++
      } else {
        const text = (prev.text + ' ' + c.text).replace(/\s+/g, ' ').trim()
        c.text = text
        c.start = prev.start
        c.end = Math.max(prev.end, c.end)
        out.pop()
        merged++
      }
    }
    out.push(c)
  }
  let minDur = Infinity
  for (const c of out) {
    const dur = c.end - c.start
    if (dur < minDur) minDur = dur
  }
  return { trimmed, merged, minDur: out.length ? minDur : 0, cues: out }
}

// 就地修复一个 srt 文件；返回统计信息
function sanitizeSrtInPlace(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const cues = parseSrt(raw)
    if (cues.length < 3) return { cues: cues.length, trimmed: 0, minDur: 0, changed: false }
    // 稳定排序：yt-dlp 产出的本来就有序，排序只为兼容手改过的文件
    cues.sort((a, b) => a.start - b.start)

    let overlaps = 0
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) overlaps++
    }
    if (overlaps / cues.length < ROLLING_RATIO) {
      // 重叠只是零星几条，属于正常字幕，保持原样
      return { cues: cues.length, trimmed: 0, minDur: 0, changed: false }
    }

    const res = clipOverlaps(cues)
    if (!res.trimmed && !res.merged) {
      return { cues: cues.length, trimmed: 0, merged: 0, minDur: res.minDur, changed: false }
    }
    fs.writeFileSync(filePath, toSrt(res.cues), 'utf8')
    return {
      cues: res.cues.length,
      trimmed: res.trimmed,
      merged: res.merged,
      minDur: res.minDur,
      changed: true
    }
  } catch (e) {
    // 修复失败绝不能影响下载主流程：保留原文件继续烧录
    return { cues: 0, trimmed: 0, minDur: 0, changed: false, error: e.message }
  }
}

// 把中英两轨合成一份 srt：同一条字幕里，中文一行在上、英文一行在下。
//
// 为什么必须合成而不是「两个 subtitles 滤镜各画一遍」：每个滤镜都是一个独立的 ASS
// 渲染器，各自从底部排版，两行会直接压在一起。合成成一个多行事件后，libass 会把它
// 当作一个整体块来排版（自动避让、换行也算得对），两种语言永远不会互相覆盖。
//
// 两轨条数常常不一致（中文翻译轨可能少几条），所以按「条数多的那条」当主轴，
// 另一条用「时间重叠最多」匹配；相邻重复的副语言文本会被留空，避免同一句显示两遍。
function buildBilingualSrt(zhPath, enPath, outPath) {
  const zh = parseSrt(fs.readFileSync(zhPath, 'utf8'))
  const en = parseSrt(fs.readFileSync(enPath, 'utf8'))
  if (!zh.length || !en.length) return null

  const primaryIsZh = zh.length >= en.length
  const primary = primaryIsZh ? zh : en
  const secondary = primaryIsZh ? en : zh

  const oneLine = (t) => String(t).replace(/\s*\n\s*/g, ' ').trim()
  let lastSecondary = null
  const cues = primary.map((c) => {
    let best = null
    let bestOv = 0
    for (const s of secondary) {
      const ov = Math.min(c.end, s.end) - Math.max(c.start, s.start)
      if (ov > bestOv) {
        bestOv = ov
        best = s
      }
    }
    const sec = best && bestOv > 0 ? oneLine(best.text) : ''
    const useSec = sec && sec !== lastSecondary ? sec : ''
    if (sec) lastSecondary = sec
    const main = oneLine(c.text)
    // 主轴是英文时，要让中文仍然排在上面 → 顺序反一下
    const text = !useSec ? main : primaryIsZh ? main + '\n' + useSec : useSec + '\n' + main
    return { start: c.start, end: c.end, text }
  })

  fs.writeFileSync(outPath, toSrt(cues), 'utf8')
  return { cues: cues.length }
}

module.exports = {
  sanitizeSrtInPlace,
  buildBilingualSrt,
  parseSrt,
  toSrt,
  clipOverlaps,
  formatTime
}
