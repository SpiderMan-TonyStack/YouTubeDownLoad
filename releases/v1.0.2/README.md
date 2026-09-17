# YoutubeDownload（Windows）

基于 **Electron + Vue 3 + Vite + yt-dlp + ffmpeg** 的 Windows 桌面端图形化 YouTube 视频下载工具。

> 策划案见仓库内 `策划案.md`。本软件按策划案 MVP + 字幕硬烧录（中英双字幕）实现。

## 功能

- 粘贴视频链接 → 一键解析（标题/时长/可选格式与字幕）
- 清晰度/格式选择：最高画质合并 mp4，或仅提取音频（mp3/m4a）
- 字幕硬烧录（兼容性最好，任意播放器可看）：`不需要 / 仅中文 / 仅英文 / 中英双字幕`
- 实时下载进度（百分比 / 速度 / 剩余时间）
- 下载历史记录（打开文件所在目录、重新下载、删除记录）
- 引擎二进制（yt-dlp / ffmpeg）首次运行自动下载，亦可手动指定本地已有 exe
- 断点续传 + 失败重试，适应国内网络

## 技术栈

| 层 | 技术 |
|---|---|
| 界面 | Vue 3 + Vite |
| 外壳 | Electron（仅 Windows） |
| 下载引擎 | yt-dlp（内置/自动下载） |
| 转码/字幕 | ffmpeg（内置/自动下载） |
| 本地存储 | electron-store（历史/设置） |

## 目录结构

```
youtube-download/
├─ src/
│  ├─ main/            # Electron 主进程（Node）
│  │  ├─ index.js      # 窗口创建 + IPC 注册
│  │  ├─ binaries.js   # 定位 / 下载 yt-dlp 与 ffmpeg
│  │  ├─ downloader.js  # yt-dlp 封装 + 进度解析
│  │  ├─ ffmpeg.js     # 合并与硬字幕烧录
│  │  └─ store.js      # electron-store 历史/设置
│  ├─ preload.js       # contextBridge 暴露 window.api
│  └─ renderer/        # Vue 渲染进程
│     ├─ index.html
│     ├─ main.js
│     ├─ App.vue
│     ├─ components/
│     └─ styles.css
├─ resources/          # 可选放置 yt-dlp.exe / ffmpeg.exe
├─ dist/               # vite 构建产物（Electron 加载）
├─ package.json
├─ vite.config.js
├─ electron-builder.yml
└─ 策划案.md
```

## 快速开始

### 开发 / 直接运行
```bash
npm install          # 已配置 npmmirror 镜像，自动拉取 Electron
npm run dev          # 构建渲染端并启动应用
```

### 打包为 Windows 安装包 / 便携版
```bash
npm run dist            # NSIS 安装包 -> release/
npm run dist:portable   # 单文件便携 exe -> release/
```
> 打包使用 `ELECTRON_BUILDER_BINARIES_MIRROR`（npmmirror）规避 GitHub 443。
>
> **构建排障**：若 `release/` 下的 `win-unpacked/resources/app.asar` 被杀软 / 索引等系统进程占用，导致 `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`（无法清空输出目录），可改用全新目录绕过，例如：
> ```bash
> npx electron-builder --win nsis --config.directories.output=release-nsis
> ```

### 免安装版（portable）使用
- `npm run dist:portable` 产出 `release/YoutubeDownload-portable-<版本>.exe`：单文件、双击即用、**不写注册表、可放任意目录 / U 盘**。
- 当前构建已将 `yt-dlp.exe` / `ffmpeg.exe` 一并打进包内 `resources/`，**离线即可下载**（无需首次联网拉取引擎）。
- 暂用 Electron 默认图标，后续在 `build/icon.ico` 放多尺寸图标并在 `electron-builder.yml` 设 `win.icon` 即可替换。

### 可安装版（NSIS 安装包）使用
- `npm run dist` 产出 `release/YoutubeDownload-Setup-<版本>.exe`（当前为 `YoutubeDownload-Setup-1.0.2.exe`）：标准 Windows 安装包，安装到 `Program Files`、写注册表、创建开始菜单与桌面快捷方式。
- 同样内置 yt-dlp / ffmpeg，安装后离线即可下载；安装目录可在安装时自定义。
- 与免安装版区别：可安装版需安装（含卸载程序），适合长期使用；免安装版（portable）双击即用、可放 U 盘，适合随身 / 临时使用。

## 引擎二进制说明

应用启动时会按以下顺序查找 yt-dlp / ffmpeg：
1. 设置中手动指定的路径；
2. `resources/`（随包目录）下的 `yt-dlp.exe` / `ffmpeg.exe`；
3. 系统 PATH；
4. 若都没有 → 首次运行自动下载到 `%APPDATA%/youtube-download/bin/`。

## 字幕（硬字幕）

- 下载阶段用 yt-dlp 拉取中文字幕（`zh-Hans/zh-CN/zh`）与英文字幕（`en`）；
- `中英双字幕`：中文放画面底部、英文放顶部，使用 ffmpeg `subtitles` 滤镜烧录（不可逆，但兼容性最好）；
- `不需要字幕`：仅合并音视频。

## 合规提示

本工具定位于「个人离线收藏 / 合理使用」。请仅下载你有权使用的内容；不内置破解、不捆绑任何翻墙能力，播放列表批量下载需用户主动选择。

## 常见问题

- **启动报缺少 yt-dlp/ffmpeg**：检查网络，或到「设置」手动指定本地已有的 exe。
- **解析失败/超时**：YouTube 链接需可访问；如有地域限制请在「设置」配置代理或 Cookie 文件。
- **字幕不显示**：部分视频无官方字幕；可尝试开启自动字幕（automatic captions）。

## 更新日志

### v1.0.2（2026-09-16）
- 新增 **主题功能**：设置页「外观」分区可切换 6 套常用主题——浅色 / 深色 / 护眼 / 蓝调 / 粉樱 / 薄荷
- 主题基于 CSS 变量 + `data-theme` 实现，主进程启动时通过 `?theme` 参数预置，首屏无闪烁；选择实时生效并持久化到 `electron-store`
- 同步将输入框背景、禁用按钮、状态胶囊、进度条轨道、滚动条等全部改为跟随主题变量

### v1.0.1（2026-09-17）
- 新增 **可安装版（NSIS 安装包）**：安装到 Program Files、创建开始菜单 / 桌面快捷方式、可自定义安装目录，同样内置 yt-dlp / ffmpeg，离线即可下载
- 发布规范落地：每版本独立文件夹 `releases/<版本>/` 存放该版本全部交付文件；每次推送打对应 tag；大文件（.exe）经 **Git LFS** 管理
- 打包文档补充：可安装版使用说明 + 构建排障（输出目录 app.asar 被系统占用时改用全新输出目录）
- **应用统一更名为 `YoutubeDownload`**（原「YouTube下载器」）：产品名、窗口标题、安装向导、快捷方式与安装包文件名全部改为 ASCII，规避中文名在命令行 / CI 环境下被编码破坏的问题

### v1.0.0（2026-09-16）
首个正式版本，Windows 桌面端图形化 YouTube 下载器（MVP + 免安装便携版）。
- 粘贴链接一键解析（标题 / 时长 / 可选格式与字幕）
- 清晰度 / 格式选择：最高画质合并 mp4，或仅提取音频（m4a / mp3）
- 字幕硬烧录：不需要 / 仅中文 / 仅英文 / 中英双字幕
- 实时下载进度（百分比 / 速度 / 剩余时间）
- 下载历史（打开目录 / 重新下载 / 删除）
- 断点续传 + 失败重试，适应国内网络
- **免安装版**：单文件便携 exe（双击即用、不写注册表、可放 U 盘），内置 yt-dlp / ffmpeg，离线即可下载

## 版本与发布规范

本仓库采用「**每版本一个文件夹 + 每次推送一个 tag**」的交付方式：

- **版本号**：小步递增 `+0.0.1`（`v1.0.0 → v1.0.1 → v1.0.2 …`）。
- **版本文件夹**：每个版本的全部交付文件放在 `releases/<版本>/` 下（如 `releases/v1.0.1/`），包含：
  - `YoutubeDownload-Setup-<版本>.exe`（可安装版）
  - `YoutubeDownload-portable-<版本>.exe`（免安装便携版）
  - `README.md`（本版说明 / 更新日志）
- **Tag**：每次 `git push` 同时打一个 annotated tag，名称与文件夹一致：`git tag -a v1.0.x -m "..."`，随后 `git push origin main --tags`。
- **大文件走 Git LFS**：`.gitattributes` 已将 `releases/**/*.exe` 交给 LFS 管理，仓库历史保持轻量；克隆前请先安装 Git LFS（`git lfs install`）。
- **构建排障**：若 `app.asar` 被系统进程占用导致清空输出目录失败，用全新目录绕过（见上方「打包」说明）。
