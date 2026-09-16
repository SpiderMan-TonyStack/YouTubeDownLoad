const { defineConfig } = require('vite')
const vue = require('@vitejs/plugin-vue')
const path = require('path')

// 渲染进程源码位于 src/renderer；构建产物输出到项目根 dist/，由 Electron 加载
module.exports = defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/renderer') }
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500
  },
  server: {
    port: 5173
  }
})
