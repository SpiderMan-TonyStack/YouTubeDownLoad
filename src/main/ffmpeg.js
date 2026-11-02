const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { sanitizeSrtInPlace } = require('./subtitle-fix')

// 将 Windows 路径转换为 ffmpeg subtitles 滤镜可用的形式（正斜杠 + 转义冒号）
function escSubPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

// subs: { zh?: 绝对路径, en?: 绝对路径 }
// 返回 ffmpeg 的 -vf 参数值（字幕滤镜链）
function buildSubtitleFilter(subs) {
  const filters = []
  if (subs.zh) {
    filters.push(
      `subtitles='${escSubPath(subs.zh)}':force_style='FontSize=24,PrimaryColour=&H00FFFFFF&'`
    )
  }
  if (subs.en) {
    // 英文字幕放顶部（Alignment=6）
    filters.push(
      `subtitles='${escSubPath(subs.en)}':force_style='FontSize=18,PrimaryColour=&H00CCCCCC&,Alignment=6'`
    )
  }
  return filters.join(',')
}

// 把字幕复制到视频同目录的临时固定名，避免路径转义问题。
// 复制完立刻修一遍时间轴：YouTube 自动字幕的 cue 之间存在大量重叠，
// 不修的话 libass 会把同时激活的多条对话一起画出来（叠字 + 顺序颠倒）。
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
  return out
}

function cleanupWorkdirSubs(videoPath) {
  const dir = path.dirname(videoPath)
  for (const f of ['sub_zh.srt', 'sub_en.srt']) {
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
