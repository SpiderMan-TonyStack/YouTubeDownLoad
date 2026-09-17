const Store = require('electron-store')

const store = new Store({
  name: 'youtube-download',
  defaults: {
    history: [],
    settings: {
      ytdlpPath: '',
      ffmpegPath: '',
      downloadDir: '',
      proxy: '',
      useAutoCaptions: false,
      theme: 'light'
    }
  }
})

function getHistory() {
  return store.get('history', [])
}

function addHistory(item) {
  const list = store.get('history', [])
  list.unshift(item)
  // 最多保留 200 条
  store.set('history', list.slice(0, 200))
}

function updateHistory(id, patch) {
  const list = store.get('history', [])
  const idx = list.findIndex((h) => h.id === id)
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch }
    store.set('history', list)
  }
}

function removeHistory(id) {
  const list = store.get('history', []).filter((h) => h.id !== id)
  store.set('history', list)
}

function clearHistory() {
  store.set('history', [])
}

function getSettings() {
  return store.get('settings', {})
}

function saveSettings(patch) {
  const cur = store.get('settings', {})
  store.set('settings', { ...cur, ...patch })
}

module.exports = {
  store,
  getHistory,
  addHistory,
  updateHistory,
  removeHistory,
  clearHistory,
  getSettings,
  saveSettings
}
