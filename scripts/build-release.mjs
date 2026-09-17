#!/usr/bin/env node
/**
 * 一键发布构建脚本（YoutubeDownload）。
 *
 * 解决的问题：electron-builder 每次打包都会在项目根目录生成 `release-*` 文件夹
 * （内含 app.asar，常被系统进程锁定、删不掉），导致项目目录越来越乱。
 *
 * 本脚本的做法：
 *  1. 把 electron-builder 的输出放到**系统临时目录** → 项目根目录不再产生 `release-*`；
 *  2. 构建完自动把产物归档到 `releases/v<版本>/`（安装包 + 便携版 + README）；
 *  3. 同步 `releases/` 顶层的「最新免安装副本」——只保留最新一份（版本文件夹绝不动）；
 *  4. 尽力清理本次及历史的临时构建目录（被锁则跳过，仅留在系统临时目录）。
 *
 * 用法：
 *   node scripts/build-release.mjs            # 构建 nsis + portable（按 electron-builder.yml）
 *   node scripts/build-release.mjs nsis       # 只构建 nsis
 *   node scripts/build-release.mjs portable   # 只构建 portable
 *   node scripts/build-release.mjs --dry      # 只构建+清理，不写入 releases/（自测用）
 *
 * npm 脚本：`npm run dist`
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry')
const target = argv.find((a) => a === 'nsis' || a === 'portable') || ''

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version

// 本工作台会注入 ELECTRON_RUN_AS_NODE=1，会让 electron 退化为纯 Node → 必须移除
delete process.env.ELECTRON_RUN_AS_NODE
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://cdn.npmmirror.com/binaries/'

const node = process.execPath
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const builderBin = path.join(root, 'node_modules', 'electron-builder', 'cli.js')

function run(entry, args) {
  console.log('> node', path.relative(root, entry), args.join(' '))
  const r = spawnSync(node, [entry, ...args], { cwd: root, stdio: 'inherit', env: process.env })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`命令退出码 ${r.status}: ${entry} ${args.join(' ')}`)
}

function rmBestEffort(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch (e) {
    console.warn(`[cleanup] 跳过（可能被系统进程锁定 app.asar）: ${dir} -> ${e.code || e.message}`)
    return false
  }
}

// 1) 构建渲染端
run(viteBin, ['build'])

// 2) 打包到系统临时目录（项目根目录不再产生 release-*）
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-build-'))
console.log('[build] 临时输出目录:', outDir)
const builderArgs = ['--win']
if (target) builderArgs.push(target)
builderArgs.push(`--config.directories.output=${outDir}`)
run(builderBin, builderArgs)

const setupName = `YoutubeDownload-Setup-${version}.exe`
const portableName = `YoutubeDownload-portable-${version}.exe`

if (dryRun) {
  console.log('[dry] 跳过归档（--dry）')
} else {
  // 3) 归档到 releases/v<版本>/（只复制本次实际产出的文件）
  const relDir = path.join(root, 'releases', `v${version}`)
  if (fs.existsSync(relDir)) console.warn(`[warn] releases/v${version}/ 已存在，将覆盖其中同名产物`)
  fs.mkdirSync(relDir, { recursive: true })
  const copied = []
  for (const name of [setupName, portableName]) {
    const src = path.join(outDir, name)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(relDir, name))
      copied.push(name)
    }
  }
  fs.copyFileSync(path.join(root, 'README.md'), path.join(relDir, 'README.md'))
  console.log(`[archive] releases/v${version}/ <- ${copied.join(', ') || '(无产物)'}`)

  // 4) 顶层“最新免安装副本”只留最新一份（版本文件夹绝不动）
  const releasesDir = path.join(root, 'releases')
  if (fs.existsSync(releasesDir)) {
    for (const f of fs.readdirSync(releasesDir)) {
      if (/^YoutubeDownload-portable-.*\.exe$/.test(f)) rmBestEffort(path.join(releasesDir, f))
    }
    const newPortable = path.join(relDir, portableName)
    if (fs.existsSync(newPortable)) {
      fs.copyFileSync(newPortable, path.join(releasesDir, portableName))
      console.log(`[sync] releases/${portableName}（顶层仅保留最新免安装副本）`)
    }
  }
}

// 5) 尽力清理：本次临时目录 + 历史遗留的 ytdl-build-* 临时目录
rmBestEffort(outDir)
for (const name of fs.readdirSync(os.tmpdir())) {
  if (name.startsWith('ytdl-build-')) rmBestEffort(path.join(os.tmpdir(), name))
}

console.log('\n完成：项目根目录未生成 release-* 构建文件夹。')
