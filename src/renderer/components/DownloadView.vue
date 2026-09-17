<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, computed } from 'vue'

const url = ref('')
const parsing = ref(false)
const info = ref(null)
const parseError = ref('')

const mode = ref('video')
const height = ref('best')
const subtitle = ref('none')

const tasks = reactive([])
const offEvent = ref(null)
// 补字幕时用来走秒（抓字幕阶段 yt-dlp 不输出百分比，只能显示已用时）
const nowTick = ref(Date.now())
let tickTimer = null

const subtitleOptions = [
  { value: 'none', label: '不需要字幕' },
  { value: 'zh', label: '仅中文' },
  { value: 'en', label: '仅英文' },
  { value: 'both', label: '中英双字幕' }
]

const heightOptions = computed(() => {
  if (!info.value || !info.value.heights.length) return [{ value: 'best', label: '最佳画质' }]
  const list = info.value.heights.map((h) => ({ value: h, label: h + 'p' }))
  return [{ value: 'best', label: '最佳画质' }, ...list]
})

async function onParse() {
  if (!url.value.trim()) return
  parsing.value = true
  parseError.value = ''
  info.value = null
  try {
    info.value = await window.api.parse(url.value.trim())
  } catch (e) {
    parseError.value = e.message || '解析失败'
  } finally {
    parsing.value = false
  }
}

async function onDownload() {
  if (!url.value.trim()) return
  const options = {
    mode: mode.value,
    height: mode.value === 'video' ? height.value : 'best',
    subtitle: subtitle.value,
    title: info.value ? info.value.title : '',
    duration: info.value ? info.value.duration : 0
  }
  try {
    const id = await window.api.download({ url: url.value.trim(), options })
    tasks.unshift({
      id,
      title: options.title || url.value,
      url: url.value.trim(),
      options,
      percent: 0,
      speed: '',
      eta: '',
      status: 'starting',
      filePath: '',
      message: '准备中…'
    })
  } catch (e) {
    parseError.value = e.message || '下载启动失败'
  }
}

function fmtSize(b) {
  if (!b) return ''
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB'
  return (b / 1024 / 1024).toFixed(1) + ' MB'
}

function statusText(t) {
  if (t.retrying) {
    if (t.status === 'burning') return `正在烧录字幕 ${Math.round(t.percent || 0)}%`
    const secs = t.retryStart ? Math.max(0, Math.floor((nowTick.value - t.retryStart) / 1000)) : 0
    return `正在抓取字幕… 已用 ${secs}s`
  }
  switch (t.status) {
    case 'starting':
      return t.message || '准备中…'
    case 'downloading':
      return `下载中 ${t.percent.toFixed(1)}%  ·  ${t.speed}  ·  ETA ${t.eta}`
    case 'burning':
      return `字幕烧录中 ${t.percent || ''}%`
    case 'done':
      return '完成 · ' + fmtSize(t.size)
    case 'error':
      return '失败：' + t.message
    default:
      return t.message || ''
  }
}

function onEvent(ev) {
  let t = tasks.find((x) => x.id === ev.id)
  if (!t) {
    t = { id: ev.id, title: ev.title || '', percent: 0, speed: '', eta: '', status: 'starting', filePath: '', message: '' }
    tasks.unshift(t)
  }
  if (ev.type === 'progress') {
    t.status = 'downloading'
    t.percent = ev.percent
    t.speed = ev.speed
    t.eta = ev.eta
  } else if (ev.type === 'burn-progress') {
    t.status = 'burning'
    t.percent = ev.percent
  } else if (ev.type === 'status') {
    t.message = ev.msg
  } else if (ev.type === 'warn') {
    // 这一轮补字幕已经结束（多半是被限速），必须结束 retrying，
    // 否则进度条会一直滚、状态永远停在「正在抓取字幕…」
    t.retrying = false
    t.note = ev.msg
    t.noteKind = 'warn'
    t.retryable = ev.retryable !== false
  } else if (ev.type === 'cancelled') {
    t.retrying = false
    t.status = 'done'
    t.note = '已取消补字幕'
    t.noteKind = 'warn'
    t.retryable = true
  } else if (ev.type === 'complete') {
    t.status = 'done'
    t.percent = 100
    t.filePath = ev.filePath
    t.retrying = false
    if (ev.retried) {
      t.note = '字幕已补上并烧录完成'
      t.noteKind = 'ok'
      t.retryable = false
    }
  } else if (ev.type === 'error') {
    if (t.retrying) {
      // 补字幕失败：视频本身是好的，不要把整条任务判为失败
      t.retrying = false
      t.note = '补字幕失败：' + ev.message
      t.noteKind = 'bad'
    } else {
      t.status = 'error'
      t.message = ev.message
      t.note = ''
    }
  }
}

async function retrySub(t) {
  if (!t.url || !t.filePath || t.retrying) return
  t.retrying = true
  t.retryStart = Date.now()
  t.note = '正在重新抓取字幕…'
  t.noteKind = 'warn'
  try {
    await window.api.retrySubtitle({
      id: t.id,
      url: t.url,
      // 必须深拷贝成普通对象：reactive 里取出的 options 是 Proxy，直接过 IPC 会报
      // "An object could not be cloned."
      options: JSON.parse(JSON.stringify(t.options || {})),
      filePath: t.filePath
    })
  } catch (e) {
    t.retrying = false
    t.note = '补字幕启动失败：' + (e.message || e)
    t.noteKind = 'bad'
  }
}

async function cancelSub(t) {
  if (!t.retrying) return
  t.note = '正在取消…'
  t.noteKind = 'warn'
  try {
    await window.api.cancelTask(t.id)
  } catch (e) {
    t.note = '取消失败：' + (e.message || e)
    t.noteKind = 'bad'
  }
}

function openFile(t) {
  if (t.filePath) window.api.openFolder(t.filePath)
}

// 抓字幕阶段 yt-dlp 不给百分比 → 用滚动条表示「进行中」；烧录阶段才是有百分比的实进度条
function isIndeterminate(t) {
  return !!t.retrying && t.status !== 'burning'
}

function removeTask(t) {
  const i = tasks.indexOf(t)
  if (i >= 0) tasks.splice(i, 1)
}

onMounted(() => {
  offEvent.value = window.api.onDownloadEvent(onEvent)
  tickTimer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  offEvent.value && offEvent.value()
  if (tickTimer) clearInterval(tickTimer)
})
</script>

<template>
  <div class="download">
    <div class="card url-card">
      <div class="row">
        <input
          v-model="url"
          class="url-input"
          placeholder="粘贴 YouTube 视频链接，例如 https://www.youtube.com/watch?v=..."
          @keyup.enter="onParse"
        />
        <button :disabled="parsing || !url.trim()" @click="onParse">
          {{ parsing ? '解析中…' : '解析' }}
        </button>
        <button class="ghost" :disabled="!url.trim()" @click="onDownload">下载</button>
      </div>
      <div v-if="parseError" class="err">{{ parseError }}</div>
    </div>

    <div v-if="info" class="card info-card">
      <img v-if="info.thumbnail" :src="info.thumbnail" class="thumb" alt="thumb" />
      <div class="info-main">
        <div class="title">{{ info.title }}</div>
        <div class="muted">
          {{ info.uploader || '' }} · 时长
          {{ info.duration ? Math.floor(info.duration / 60) + ':' + String(info.duration % 60).padStart(2, '0') : '未知' }}
        </div>
        <div class="opts">
          <label>类型
            <select v-model="mode">
              <option value="video">视频</option>
              <option value="audio">仅音频 (mp3)</option>
            </select>
          </label>
          <label v-if="mode === 'video'">画质
            <select v-model="height">
              <option v-for="h in heightOptions" :key="h.value" :value="h.value">{{ h.label }}</option>
            </select>
          </label>
          <label>字幕
            <select v-model="subtitle">
              <option v-for="s in subtitleOptions" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </label>
        </div>
      </div>
    </div>

    <div class="card queue">
      <div class="spread">
        <strong>下载队列</strong>
        <span class="muted">{{ tasks.length }} 个任务</span>
      </div>
      <div v-if="!tasks.length" class="muted empty">暂无任务，解析后点击「下载」开始。</div>
      <div v-for="t in tasks" :key="t.id" class="task">
        <div class="task-head">
          <span class="task-title">{{ t.title }}</span>
          <span class="status" :class="t.status">{{ statusText(t) }}</span>
        </div>
        <div v-if="t.note" class="task-note" :class="t.noteKind">{{ t.note }}</div>
        <div v-if="t.status === 'downloading' || t.status === 'burning' || t.retrying" class="bar">
          <div
            class="fill"
            :class="{ indeterminate: isIndeterminate(t) }"
            :style="isIndeterminate(t) ? {} : { width: (t.percent || 0) + '%' }"
          ></div>
        </div>
        <div class="row task-actions">
          <button v-if="t.status === 'done'" class="ghost" @click="openFile(t)">打开文件</button>
          <button
            v-if="t.retryable && t.status === 'done' && !t.retrying"
            class="ghost"
            @click="retrySub(t)"
          >
            重试字幕
          </button>
          <button v-if="t.retrying" class="ghost" @click="cancelSub(t)">取消补字幕</button>
          <button class="danger" @click="removeTask(t)">移除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.download {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 880px;
  margin: 0 auto;
}
.url-input {
  flex: 1;
}
.err {
  color: var(--red);
  margin-top: 8px;
}
.info-card {
  display: flex;
  gap: 14px;
}
.thumb {
  width: 160px;
  height: 90px;
  object-fit: cover;
  border-radius: 8px;
  background: var(--track);
  flex-shrink: 0;
}
.info-main {
  flex: 1;
}
.title {
  font-weight: 600;
  margin-bottom: 4px;
}
.opts {
  display: flex;
  gap: 14px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.opts label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.queue .empty {
  padding: 16px 0;
}
.task {
  border-top: 1px solid var(--border);
  padding: 12px 0;
}
.task:first-of-type {
  border-top: none;
}
.task-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.task-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.status.done {
  color: var(--green);
}
.status.error {
  color: var(--red);
  white-space: normal;
  text-align: right;
  max-width: 60%;
}
.status.warn {
  color: var(--warn-text);
  white-space: normal;
  text-align: right;
  max-width: 60%;
}
.task-note {
  color: var(--warn-text);
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 8px;
  word-break: break-word;
}
.task-note.ok {
  color: var(--ok-text);
}
.task-note.bad {
  color: var(--red);
}
.bar {
  height: 8px;
  background: var(--track);
  border-radius: 6px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--primary);
  transition: width 0.3s;
}
/* 抓字幕阶段：没有百分比，用来回滚动的条表示「进行中」 */
.fill.indeterminate {
  width: 32%;
  transition: none;
  animation: fill-slide 1.2s ease-in-out infinite;
}
@keyframes fill-slide {
  0% {
    margin-left: -32%;
  }
  100% {
    margin-left: 100%;
  }
}
.task-actions {
  margin-top: 8px;
}
</style>
