# 引擎二进制目录（resources）

本目录用于放置下载引擎，二者都可省略——应用首次运行会自动从官方源下载并缓存到用户数据目录。

可选放置（若你已拥有，可加快首次启动）：
- yt-dlp.exe      —— YouTube 解析/下载引擎（https://github.com/yt-dlp/yt-dlp）
- ffmpeg.exe      —— 音视频合并与字幕烧录（https://www.gyan.dev/ffmpeg/builds/）

放置后应用会优先使用本目录的二进制；否则自动下载到：
  Windows: %APPDATA%/youtube-download/bin/
