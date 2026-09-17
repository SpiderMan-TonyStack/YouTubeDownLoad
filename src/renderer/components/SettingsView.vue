<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const settings = ref({
  downloadDir: '',
  proxy: '',
  proxyEnabled: false,
  clashController: '',
  clashSecret: '',
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

// ---- 代理 ----
const detecting = ref(false)
const testing = ref(false)
const detectMsg = ref('')
const testMsg = ref('')
const testOk = ref(false)
const groups = ref([])
const selGroup = ref('')
const selNode = ref('')
const nodeMsg = ref('')
const nodeOk = ref(false)

const hasController = computed(() => !!settings.value.clashController)
const currentNodes = computed(() => {
  const g = groups.value.find((x) => x.name === selGroup.value)
  return g ? g.all : []
})

onMounted(async () => {
  settings.value = await window.api.getSettings()
  // 老版本升级：把「填了地址就算开启」的旧行为显式落成开关状态
  if (settings.value.proxyEnabled === undefined) {
    settings.value.proxyEnabled = !!settings.value.proxy
    await window.api.saveSettings({ proxyEnabled: settings.value.proxyEnabled })
  }
  offBins.value = window.api.onBinariesStatus((msg) => (binsStatus.value = msg))
})
onBeforeUnmount(() => offBins.value && offBins.value())

async function saveProxy() {
  await window.api.saveSettings({
    proxy: settings.value.proxy || '',
    proxyEnabled: settings.value.proxyEnabled === true,
    clashController: settings.value.clashController || '',
    clashSecret: settings.value.clashSecret || ''
  })
}

async function detectProxy() {
  detecting.value = true
  detectMsg.value = ''
  try {
    const r = await window.api.proxyDetect()
    if (r.settings) settings.value = { ...settings.value, ...r.settings }
    const ctrl = r.controller
    const ctrlText = ctrl
      ? ctrl.needsSecret
        ? `发现控制接口 ${ctrl.url}，但需要密钥（请在下方填写 secret）`
        : `控制接口 ${ctrl.url}${ctrl.version ? '（v' + ctrl.version + '）' : ''}`
      : '未发现控制接口'
    detectMsg.value = r.proxyPort
      ? `已检测到本地代理端口 ${r.proxyPort}；${ctrlText}`
      : `未检测到本地代理端口，请确认 FlClash / Clash 已启动并开启本地端口；${ctrlText}`
    if (ctrl && !ctrl.needsSecret) await loadNodes()
  } catch (e) {
    detectMsg.value = '检测失败：' + (e.message || e)
  } finally {
    detecting.value = false
  }
}

async function loadNodes() {
  nodeMsg.value = ''
  try {
    const list = await window.api.proxyNodes({})
    groups.value = list || []
    if (groups.value.length) {
      const prefer =
        groups.value.find((g) => /节点|选择|proxy|select/i.test(g.name)) || groups.value[0]
      selGroup.value = prefer.name
      selNode.value = prefer.now || ''
      nodeOk.value = true
      nodeMsg.value = `已读取 ${groups.value.length} 个分组`
    } else {
      nodeMsg.value = '控制接口可用，但没有找到可切换的分组'
      nodeOk.value = false
    }
  } catch (e) {
    groups.value = []
    nodeOk.value = false
    nodeMsg.value = '读取节点失败：' + (e.message || e)
  }
}

async function applyNode() {
  nodeMsg.value = ''
  try {
    await window.api.proxySelect({ group: selGroup.value, node: selNode.value })
    nodeOk.value = true
    nodeMsg.value = `已切换到「${selNode.value}」`
  } catch (e) {
    nodeOk.value = false
    nodeMsg.value = '切换失败：' + (e.message || e)
  }
}

async function testProxy() {
  testing.value = true
  testMsg.value = ''
  try {
    const r = await window.api.proxyTest({ proxyUrl: settings.value.proxy })
    testOk.value = !!r.ok
    testMsg.value = r.ok
      ? `代理可用（HTTP ${r.status}，${r.ms}ms）`
      : '代理不可用：' + (r.error || 'HTTP ' + r.status)
  } catch (e) {
    testOk.value = false
    testMsg.value = '测试失败：' + (e.message || e)
  } finally {
    testing.value = false
  }
}

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
async function ensure() {
  binsStatus.value = '开始准备…'
  try {
    await window.api.ensureBinaries()
    binsStatus.value = '引擎已就绪'
  } catch (e) {
    binsStatus.value = '失败：' + (e.message || e)
  }
}
async function updateYtdlp() {
  binsStatus.value = '正在更新 yt-dlp…'
  try {
    await window.api.updateYtdlp()
    binsStatus.value = 'yt-dlp 已更新到最新版本'
  } catch (e) {
    binsStatus.value = '更新失败：' + (e.message || e)
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

    <h3>网络代理</h3>
    <div class="field">
      <label class="check">
        <input type="checkbox" v-model="settings.proxyEnabled" @change="saveProxy" />
        <span>启用代理——<b>仅本应用生效</b>，不会修改系统代理，也不影响其他软件</span>
      </label>
    </div>

    <div class="field">
      <div class="label">本地代理地址</div>
      <div class="row">
        <input v-model="settings.proxy" class="grow" placeholder="http://127.0.0.1:7890" @change="saveProxy" />
        <button class="ghost" :disabled="detecting" @click="detectProxy">
          {{ detecting ? '检测中…' : '自动检测' }}
        </button>
        <button class="ghost" :disabled="testing" @click="testProxy">
          {{ testing ? '测试中…' : '测试连通性' }}
        </button>
      </div>
      <div v-if="detectMsg" class="note muted" style="margin-top: 6px">{{ detectMsg }}</div>
      <div v-if="testMsg" class="note" :class="testOk ? 'good' : 'bad'" style="margin-top: 4px">
        {{ testMsg }}
      </div>
    </div>

    <div class="field">
      <div class="label">节点选择（对接本机 Clash / FlClash 内核）</div>

      <template v-if="hasController">
        <div class="row">
          <select v-model="selGroup" class="grow">
            <option value="">选择分组…</option>
            <option v-for="g in groups" :key="g.name" :value="g.name">
              {{ g.name }}（{{ g.all.length }} 个节点）
            </option>
          </select>
          <select v-model="selNode" class="grow">
            <option value="">选择节点…</option>
            <option v-for="n in currentNodes" :key="n" :value="n">{{ n }}</option>
          </select>
          <button :disabled="!selGroup || !selNode" @click="applyNode">切换</button>
          <button class="ghost" @click="loadNodes">刷新</button>
        </div>
        <div v-if="nodeMsg" class="note" :class="nodeOk ? 'good' : 'bad'" style="margin-top: 6px">
          {{ nodeMsg }}
        </div>
      </template>

      <div v-else class="note muted" style="margin-top: 0">
        尚未检测到控制接口。此时节点请在 FlClash 界面里选择，本应用只负责走你已开好的本地端口。<br />
        想在应用内直接切节点：在 FlClash 的<b>「覆写」</b>里加入下面两行 → 保存并重启内核 → 回到这里点「自动检测」。
        <pre>external-controller: 127.0.0.1:9090
secret: "自定一个密钥"</pre>
      </div>

      <div class="row" style="margin-top: 8px">
        <input
          v-model="settings.clashController"
          class="grow"
          placeholder="控制接口（可选）http://127.0.0.1:9090"
          @change="saveProxy"
        />
        <input v-model="settings.clashSecret" class="grow" placeholder="密钥 secret（可选）" @change="saveProxy" />
        <button class="ghost" @click="loadNodes">读取节点</button>
      </div>
    </div>

    <div class="field">
      <div class="muted note" style="margin-top: 0">
        字幕：下载视频时会同时尝试**官方字幕**与**自动生成字幕**（后者作为兜底），并烧录进画面；无需额外开关。
      </div>
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
      <button @click="ensure">检测 / 补齐引擎组件</button>
      <button class="ghost" @click="updateYtdlp">更新 yt-dlp 引擎（最新）</button>
      <span v-if="binsStatus" class="muted">{{ binsStatus }}</span>
    </div>
    <p class="muted note">
      说明：首次运行会自动从官方源下载 yt-dlp 与 ffmpeg 到用户数据目录；如你的网络无法访问，可手动「选择」本地已有的 exe。
    </p>
    <p class="muted note">
      提示：YouTube 经常改动，**yt-dlp 引擎过旧会导致下载报 403 失败**。若解析正常但下载失败，请点「更新 yt-dlp 引擎（最新）」把引擎升级到最新版后重试。
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
.note.good {
  color: var(--ok-text);
}
.note.bad {
  color: var(--red);
}
.note pre {
  background: var(--track);
  color: var(--text);
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  margin: 8px 0 0;
  overflow-x: auto;
}
select.grow {
  min-width: 120px;
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  padding: 0;
  accent-color: var(--primary);
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
