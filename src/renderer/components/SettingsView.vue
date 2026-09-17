<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const settings = ref({
  downloadDir: '',
  proxy: '',
  useAutoCaptions: false,
  ytdlpPath: '',
  ffmpegPath: '',
  theme: 'light'
})

// 主题预览色板：key 与 styles.css 的 [data-theme=xxx] 一一对应
const THEMES = [
  { key: 'light', label: '浅色', bg: '#f5f6f8', panel: '#ffffff', primary: '#2f6fed' },
  { key: 'dark', label: '深色', bg: '#15171c', panel: '#1e2128', primary: '#4c8dff' },
  { key: 'sepia', label: '护眼', bg: '#f3ecd9', panel: '#fbf6ea', primary: '#b5793a' },
  { key: 'blue', label: '蓝调', bg: '#eaf1fb', panel: '#ffffff', primary: '#1e6fe0' },
  { key: 'pink', label: '粉樱', bg: '#fdeef3', panel: '#fff6f9', primary: '#e0568f' },
  { key: 'green', label: '薄荷', bg: '#eaf6ee', panel: '#ffffff', primary: '#1f9d63' }
]

function applyTheme(key) {
  settings.value.theme = key
  document.documentElement.setAttribute('data-theme', key)
  window.api.saveSettings({ theme: key })
}
const binsStatus = ref('')
const offBins = ref(null)

onMounted(async () => {
  settings.value = await window.api.getSettings()
  offBins.value = window.api.onBinariesStatus((msg) => (binsStatus.value = msg))
})
onBeforeUnmount(() => offBins.value && offBins.value())

async function pickDir() {
  const dir = await window.api.selectDir()
  if (dir) {
    settings.value.downloadDir = dir
    await window.api.saveSettings({ downloadDir: dir })
  }
}
async function pickBinary(type) {
  const p = await window.api.selectBinary(type)
  if (p) {
    settings.value[type === 'ffmpeg' ? 'ffmpegPath' : 'ytdlpPath'] = p
    await window.api.saveSettings(type === 'ffmpeg' ? { ffmpegPath: p } : { ytdlpPath: p })
  }
}
async function onProxy() {
  await window.api.saveSettings({ proxy: settings.value.proxy })
}
async function onAutoCaptions() {
  await window.api.saveSettings({ useAutoCaptions: settings.value.useAutoCaptions })
}
async function ensure() {
  binsStatus.value = '开始准备…'
  try {
    await window.api.ensureBinaries()
    binsStatus.value = '引擎已就绪'
  } catch (e) {
    binsStatus.value = '失败：' + (e.message || e)
  }
}
function openDownloads() {
  window.api.openFolder('')
}
</script>

<template>
  <div class="settings card">
    <h3>外观</h3>
    <div class="field">
      <div class="label">主题</div>
      <div class="themes">
        <button
          v-for="th in THEMES"
          :key="th.key"
          :class="['theme-card', settings.theme === th.key ? 'active' : '']"
          :title="th.label"
          @click="applyTheme(th.key)"
        >
          <span class="swatch">
            <i :style="{ background: th.bg }"></i>
            <i :style="{ background: th.panel }"></i>
            <i :style="{ background: th.primary }"></i>
          </span>
          <span class="tname">{{ th.label }}</span>
        </button>
      </div>
    </div>

    <h3>下载设置</h3>
    <div class="field">
      <div class="label">下载目录</div>
      <div class="row">
        <input v-model="settings.downloadDir" class="grow" readonly />
        <button class="ghost" @click="pickDir">选择目录</button>
        <button class="ghost" @click="openDownloads">打开</button>
      </div>
    </div>

    <div class="field">
      <div class="label">网络代理（可选，如 http://127.0.0.1:7890）</div>
      <input v-model="settings.proxy" class="grow" placeholder="留空表示不使用代理" @change="onProxy" />
    </div>

    <div class="field">
      <label class="check">
        <input type="checkbox" v-model="settings.useAutoCaptions" @change="onAutoCaptions" />
        允许下载 YouTube 自动生成字幕（无官方字幕时）
      </label>
    </div>

    <h3>引擎（yt-dlp / ffmpeg）</h3>
    <div class="field">
      <div class="label">yt-dlp 路径</div>
      <div class="row">
        <input :value="settings.ytdlpPath || '自动（首次运行下载）'" class="grow" readonly />
        <button class="ghost" @click="pickBinary('ytdlp')">选择</button>
      </div>
    </div>
    <div class="field">
      <div class="label">ffmpeg 路径</div>
      <div class="row">
        <input :value="settings.ffmpegPath || '自动（首次运行下载）'" class="grow" readonly />
        <button class="ghost" @click="pickBinary('ffmpeg')">选择</button>
      </div>
    </div>
    <div class="row">
      <button @click="ensure">下载 / 更新引擎组件</button>
      <span v-if="binsStatus" class="muted">{{ binsStatus }}</span>
    </div>
    <p class="muted note">
      说明：首次运行会自动从官方源下载 yt-dlp 与 ffmpeg 到用户数据目录；如你的网络无法访问，可手动「选择」本地已有的 exe。
    </p>
  </div>
</template>

<style scoped>
.settings {
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
h3 {
  margin: 14px 0 4px;
}
.field {
  margin-bottom: 10px;
}
.label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}
.grow {
  flex: 1;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
}
.note {
  font-size: 12px;
  line-height: 1.6;
  margin-top: 12px;
}
.themes {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.theme-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  width: 84px;
  color: var(--text);
}
.theme-card.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.swatch {
  display: flex;
  width: 100%;
  height: 26px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.swatch i {
  flex: 1;
}
.tname {
  font-size: 12px;
}
</style>
