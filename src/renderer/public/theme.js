/* 首屏防闪烁：主进程通过 loadFile({ query: { theme } }) 把用户主题传入，
   这里在 <body> 渲染前给 <html> 打上 data-theme，避免默认主题闪一下。
   同源脚本，受 CSP script-src 'self' 约束，无需放开 'unsafe-inline'。 */
(function () {
  try {
    var params = new URLSearchParams(window.location.search)
    var t = params.get('theme')
    if (t) document.documentElement.setAttribute('data-theme', t)
  } catch (e) {}
})()
