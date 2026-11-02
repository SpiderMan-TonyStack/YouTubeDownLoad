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
function clipOverlaps(cues) {
  let trimmed = 0
  let minDur = Infinity
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]
    if (next) {
      const limit = next.start - GAP_MS
      if (cues[i].end > limit && limit > cues[i].start) {
        cues[i].end = limit
        trimmed++
      }
    }
    // 兜底：裁完仍然跨过下一条开始的（下一条开始时间 <= 本条开始的异常数据），
    // 直接压到本条开始处，宁可这一条不显示，也不要继续叠字
    if (next && cues[i].end > next.start) cues[i].end = cues[i].start
    const dur = cues[i].end - cues[i].start
    if (dur < minDur) minDur = dur
  }
  return { trimmed, minDur: cues.length ? minDur : 0 }
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

    const { trimmed, minDur } = clipOverlaps(cues)
    if (!trimmed) return { cues: cues.length, trimmed: 0, minDur, changed: false }
    fs.writeFileSync(filePath, toSrt(cues), 'utf8')
    return { cues: cues.length, trimmed, minDur, changed: true }
  } catch (e) {
    // 修复失败绝不能影响下载主流程：保留原文件继续烧录
    return { cues: 0, trimmed: 0, minDur: 0, changed: false, error: e.message }
  }
}

module.exports = { sanitizeSrtInPlace, parseSrt, toSrt, clipOverlaps, formatTime }
