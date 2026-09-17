<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import DownloadView from './components/DownloadView.vue'
import HistoryView from './components/HistoryView.vue'
import SettingsView from './components/SettingsView.vue'

const tab = ref('download')
const binsStatus = ref('')
const binsReady = ref(false)
let offBins = null

onMounted(async () => {
  // 兜底：确保主题与设置一致（主进程已通过 ?theme 预置，这里防止任何路径下遗漏）
  try {
    const s = await window.api.getSettings()
    if (s && s.theme) document.documentElement.setAttribute('data-theme', s.theme)
  } catch (e) {}
  offBins = window.api.onBinariesStatus((msg) => {
    binsStatus.value = msg
  })
  // 启动即检查 / 下载引擎，确保开箱可用
  try {
    await window.api.ensureBinaries()
    binsReady.value = true
    binsStatus.value = '引擎已就绪'
  } catch (e) {
    binsStatus.value = '引擎准备失败：' + (e.message || e)
  }
})

onBeforeUnmount(() => {
  offBins && offBins()
})

const tabs = [
  { key: 'download', label: '下载' },
  { key: 'history', label: '历史' },
  { key: 'settings', label: '设置' }
]
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <div class="brand">📥 YoutubeDownload</div>
      <nav class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          :class="['tab', tab === t.key ? 'active' : '']"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </nav>
      <div class="bins" :class="binsReady ? 'ok' : 'pending'">
        {{ binsStatus || '正在准备引擎…' }}
      </div>
    </header>

    <main class="content">
      <!-- 下载页常驻（v-show）：切到别的页签不清空队列/解析结果，且下载中仍持续接收进度事件 -->
      <DownloadView v-show="tab === 'download'" />
      <!-- 历史页每次进入重新挂载，以拉取最新记录 -->
      <HistoryView v-if="tab === 'history'" />
      <SettingsView v-if="tab === 'settings'" />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px 18px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.brand {
  font-weight: 700;
  font-size: 16px;
}
.tabs {
  display: flex;
  gap: 6px;
}
.tab {
  background: transparent;
  color: var(--muted);
  border: 1px solid transparent;
  padding: 6px 14px;
}
.tab.active {
  background: #eef3ff;
  color: var(--primary);
  font-weight: 600;
}
.bins {
  margin-left: auto;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 20px;
}
.bins.ok {
  background: #e7f7ef;
  color: var(--green);
}
.bins.pending {
  background: #fff4e5;
  color: #c77700;
}
.content {
  flex: 1;
  overflow: auto;
  padding: 18px;
}
</style>
