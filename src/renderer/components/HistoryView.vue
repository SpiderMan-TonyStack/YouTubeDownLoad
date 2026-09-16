<script setup>
import { ref, onMounted } from 'vue'

const list = ref([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = await window.api.getHistory()
  } finally {
    loading.value = false
  }
}

function fmtTime(ts) {
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', { hour12: false })
}
function fmtSize(b) {
  if (!b) return ''
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB'
  return (b / 1024 / 1024).toFixed(1) + ' MB'
}
function modeText(m) {
  if (m === 'audio') return '音频'
  return '视频'
}
function subText(s) {
  return { none: '无字幕', zh: '中字', en: '英字', both: '中英双字' }[s] || s
}

async function openFile(item) {
  if (item.filePath) await window.api.openFolder(item.filePath)
}
async function removeItem(item) {
  await window.api.removeHistory(item.id)
  await load()
}
async function clearAll() {
  if (!confirm('确定清空全部历史记录？')) return
  await window.api.clearHistory()
  await load()
}

onMounted(load)
</script>

<template>
  <div class="history card" v-if="!loading">
    <div class="spread">
      <strong>下载历史（{{ list.length }}）</strong>
      <div class="row">
        <button class="ghost" @click="load">刷新</button>
        <button class="danger" :disabled="!list.length" @click="clearAll">清空</button>
      </div>
    </div>

    <div v-if="!list.length" class="muted empty">暂无历史记录。</div>

    <div v-for="item in list" :key="item.id" class="item">
      <div class="item-main">
        <div class="item-title">{{ item.title }}</div>
        <div class="muted meta">
          {{ fmtTime(item.time) }} · {{ modeText(item.mode) }} · {{ subText(item.subtitle) }}
          <span v-if="item.status === 'done'"> · {{ fmtSize(item.size) }}</span>
          <span v-if="item.status === 'error'" class="err"> · {{ item.error }}</span>
        </div>
      </div>
      <div class="row">
        <button v-if="item.status === 'done' && item.filePath" class="ghost" @click="openFile(item)">
          打开
        </button>
        <button class="danger" @click="removeItem(item)">删除</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history {
  max-width: 880px;
  margin: 0 auto;
}
.empty {
  padding: 20px 0;
}
.item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.item:first-of-type {
  border-top: none;
}
.item-title {
  font-weight: 500;
  margin-bottom: 4px;
}
.meta {
  font-size: 12px;
}
.err {
  color: var(--red);
}
</style>
