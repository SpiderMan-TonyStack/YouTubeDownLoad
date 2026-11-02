const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { sanitizeSrtInPlace, buildBilingualSrt } = require('./subtitle-fix')

// 把 Windows 路径转换为 ffmpeg subtitles 滤镜可用的形式（正斜杠 + 转义冒号）
function escSubPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

// 描边样式：亮背景（天空、白墙、文档）下不加描边的白字会糊成一片
const STROKE = 'BorderStyle=1,Outline=2,Shadow=1,Alignment=2,PrimaryColour=&H00FFFFFF&'

// subs: { zh?: 路径, en?: 路径, both?: 双语合成后的路径 }
// 返回 ffmpeg 的 -vf 参数值（字幕滤镜链）
function buildSubtitleFilter(subs) {
  // 双语：已经合成成一份多行 srt，只挂一个滤镜，两种语言在画面底部上下相邻
  if (subs.both) {
    return `subtitles='${escSubPath(subs.both)}':force_style='${STROKE},FontSize=20'`
  }
  if (subs.zh) {
    return `subtitles='${escSubPath(subs.zh)}':force_style='${STROKE},FontSize=24'`
  }
  if (subs.en) {
    return `subtitles='${escSubPath(subs.en)}':force_style='${STROKE},FontSize=24'`
  }
  return ''
}

// 把字幕复制到视频同目录的临时固定名，避免路径转义问题。
// 复制完立刻修一遍时间轴：YouTube 自动字幕的 cue 之间存在大量重叠，
// 不修的话 libass 会把同时激活的多条对话一起画出来（叠字 + 顺序颠倒）。
// 中英都有时再合成一份双语 srt，交给单个滤镜烧录。
function copySubsToWorkdir(videoPath, subs) {
  const dir = path.dirname(videoPath)
  const out = {}
  for (const [slot, src] of [
    ['zh', subs.zh],
    ['en', subs.en]
  ]) {
    if (!src) continue
    const t = path.join(dir, `sub_${slot}.srt`)
    fs.copyFileSync(src, t)
    const st = sanitizeSrtInPlace(t)
    if (st.trimmed) {
      console.log(`[subtitle] ${slot}: 裁剪 ${st.trimmed}/${st.cues} 条重叠 cue，最短 ${st.minDur}ms`)
    } else if (st.error) {
      console.warn(`[subtitle] ${slot}: 时间轴修复失败，按原文件烧录 - ${st.error}`)
    }
    out[slot] = t
  }
  if (out.zh && out.en) {
    const merged = path.join(dir, 'sub_both.srt')
    try {
      const r = buildBilingualSrt(out.zh, out.en, merged)
      if (r && r.cues) {
        out.both = merged
        console.log(`[subtitle] 双语合成 ${r.cues} 条（中文在上、英文在下，同置画面底部）`)
      }
    } catch (e) {
      // 合成失败就退回只烧中文（主槽），不让整片失败
      console.warn('[subtitle] 双语合成失败，改为只烧中文字幕 - ' + e.message)
    }
  }
  return out
}

function cleanupWorkdirSubs(videoPath) {
  const dir = path.dirname(videoPath)
  for (const f of ['sub_zh.srt', 'sub_en.srt', 'sub_both.srt']) {
    const p = path.join(dir, f)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

// 烧录字幕到新文件；返回 Promise<outPath>
// onEvent(type, data): 'burn-status' {msg}, 'burn-progress' {percent}
// registerProc(proc): 可选，把 ffmpeg 进程交出去，便于外部取消
function burnSubtitles({ ffmpegPath, videoPath, subs, outPath, duration, onEvent, registerProc }) {
  return new Promise((resolve, reject) => {
    const work = copySubsToWorkdir(videoPath, subs)
    const vf = buildSubtitleFilter(work)
    const args = ['-y', '-i', videoPath, '-vf', vf, '-c:a', 'copy', '-preset', 'veryfast', outPath]

    const p = spawn(ffmpegPath, args, { shell: false, windowsHide: true })
    if (registerProc) registerProc(p)
    let stderr = ''
    p.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      if (duration) {
        const m = s.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        if (m) {
          const sec = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])
          const percent = Math.min(99, Math.round((sec / duration) * 100))
          onEvent && onEvent('burn-progress', { percent })
        }
      }
    })
    p.on('close', (code) => {
      cleanupWorkdirSubs(videoPath)
      if (code !== 0) {
        return reject(new Error('字幕烧录失败：' + stderr.slice(-300)))
      }
      resolve(outPath)
    })
    p.on('error', (e) => {
      cleanupWorkdirSubs(videoPath)
      reject(e)
    })
  })
}

module.exports = { burnSubtitles, buildSubtitleFilter }
