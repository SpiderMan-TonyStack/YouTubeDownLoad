// 把英文字幕翻译成中文字幕。
//
// 存在的原因：YouTube 对「自动翻译轨」（tlang=zh-*) 做 IP 级限速，中文字幕经常 429；
// 而英文原生 ASR 轨不受影响。既然英文能稳定拿到，就自己翻 —— 绕开那条被限速的轨道。
//
// 两个引擎：
//   google —— 免密钥的 Chrome 词典端点，POST 重复 q 参数批量翻，无需任何配置；
//   ai     —— OpenAI 兼容的 /chat/completions，质量更好（能结合上下文修补 ASR 的碎句），需自备密钥。
//
// 零依赖：只用了 node 自带的 http / https / tls。代理走标准 CONNECT 隧道，
// 因为应用里 yt-dlp 用的那个代理只在主进程内生效，这里要复用同一份配置。

const http = require('http')
const https = require('https')
const tls = require('tls')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const { parseSrt, toSrt } = require('./subtitle-fix')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
// 翻译结果缓存到视频同目录，同一视频补字幕时直接复用，不重复请求、不烧配额
const CACHE_SUFFIX = '.zh-translated.srt'
const BATCH_SIZE = 40 // 免费端点单次批量；实测 40 行返回顺序与条数完全对齐
const MAX_RETRY = 3
// 响应体上限：翻译接口正常只有几百 KB。Base URL 是用户可配的，
// 一个异常或被劫持的端点返回超大内容就能把主进程内存打满，所以必须设上限。
const MAX_BODY = 8 * 1024 * 1024
// 本机地址允许 http（常见的本地 LLM 网关），其它一律要求 https，避免密钥明文外发
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

// -------- HTTP(S)：可选经本地 HTTP 代理 --------
// https 走 CONNECT 隧道后 TLS 升级；http（如本地 LLM 网关）走「绝对 URI」形式。
function request(urlStr, { proxy = '', method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(urlStr)
    } catch (e) {
      return reject(new Error('翻译接口地址无效：' + urlStr))
    }
    const isHttps = u.protocol === 'https:'
    if (!isHttps) {
      if (u.protocol !== 'http:') return reject(new Error('翻译接口只支持 http/https 地址'))
      // 明文 http 只在访问本机时放行（本地 LLM 网关 / mock 服务），
      // 远程地址必须走 https —— 否则 API Key 会以明文经过网络
      if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) {
        return reject(new Error('翻译接口地址必须是 https（仅本机地址允许使用 http）'))
      }
    }
    const h = { 'user-agent': UA, accept: '*/*', ...headers }
    if (body) h['content-length'] = Buffer.byteLength(body)
    const mod = isHttps ? https : http

    const onRes = (res) => {
      let data = ''
      let size = 0
      res.setEncoding('utf8')
      res.on('data', (d) => {
        size += Buffer.byteLength(d)
        if (size > MAX_BODY) {
          res.destroy()
          return reject(new Error('翻译接口响应体过大，已中断'))
        }
        data += d
      })
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    }
    const fire = (opts) => {
      const req = mod.request(opts, onRes)
      req.setTimeout(timeout, () => req.destroy(new Error('请求超时')))
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    }
    const port = u.port || (isHttps ? 443 : 80)
    const base = { hostname: u.hostname, port, path: u.pathname + u.search, method, headers: h }

    if (!proxy) return fire({ ...base, agent: false })

    let p
    try {
      p = new URL(proxy)
    } catch (e) {
      return reject(new Error('代理地址无效：' + proxy))
    }

    if (!isHttps) {
      // 明文 http：按「绝对 URI」发，由代理转发
      return fire({
        hostname: p.hostname,
        port: p.port || 80,
        path: u.href,
        method,
        headers: { ...h, host: u.host }
      })
    }

    const target = `${u.hostname}:${port}`
    const cr = http.request({
      hostname: p.hostname,
      port: p.port || 80,
      method: 'CONNECT',
      path: target,
      headers: { host: target },
      timeout
    })
    cr.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return reject(new Error('代理 CONNECT 失败：HTTP ' + res.statusCode))
      }
      // 用显式 Agent 覆写 createConnection，把 CONNECT 打好的裸 socket 交给 TLS 升级。
      // 别只传 options.createConnection —— 它会被 agent:false 新建的默认 Agent 盖掉，
      // 结果又去直连（实测会 ETIMEDOUT）。
      const agent = new https.Agent({ keepAlive: false })
      agent.createConnection = () => tls.connect({ socket, servername: u.hostname })
      fire({ ...base, agent })
    })
    cr.on('timeout', () => cr.destroy(new Error('代理连接超时')))
    cr.on('error', reject)
    cr.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 字幕文本清理：去掉 yt-dlp/YouTube 可能残留的标签与实体，避免污染翻译输入
function cleanForTranslate(text) {
  return String(text)
    .replace(/<[^>]*>/g, ' ') // <i> <c> <00:00:01.234> 等
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\\N|\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// -------- 引擎一：Google 免密钥端点 --------
// 该端点接受重复的 q 参数（POST 表单），一次返回一一对应的 JSON 数组。
// 注意：translate.googleapis.com 的 gtx 端点在部分出口 IP 上已被封（返回 429 "Sorry..."），
// 所以这里用的是 clients5 + dict-chrome-ex 这一条。
const GOOGLE_URL = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN'

async function googleBatch(lines, { proxy }) {
  const body = lines.map((l) => 'q=' + encodeURIComponent(l)).join('&')
  const r = await request(GOOGLE_URL, {
    proxy,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (r.status !== 200) {
    throw new Error('翻译接口 HTTP ' + r.status + (/Sorry/.test(r.body) ? '（该出口 IP 被限速）' : ''))
  }
  let arr
  try {
    arr = JSON.parse(r.body)
  } catch (e) {
    throw new Error('翻译接口返回了非 JSON 内容')
  }
  if (!Array.isArray(arr)) throw new Error('翻译接口返回格式异常')
  if (arr.length !== lines.length) {
    throw new Error(`翻译结果条数不匹配（${arr.length}/${lines.length}）`)
  }
  return arr.map((s) => (Array.isArray(s) ? s.join('') : String(s == null ? '' : s)).trim())
}

async function translateByGoogle(lines, ctx) {
  const out = []
  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const chunk = lines.slice(i, i + BATCH_SIZE)
    let got = null
    let lastErr = null
    for (let attempt = 1; attempt <= MAX_RETRY && !got; attempt++) {
      if (ctx.shouldStop && ctx.shouldStop()) throw new Error('CANCELLED')
      try {
        got = await googleBatch(chunk, ctx)
      } catch (e) {
        lastErr = e
        if (attempt < MAX_RETRY) await sleep(1000 * attempt) // 退避：被限速时立刻重试只会更糟
      }
    }
    // 批量失败就退化成逐条请求，尽量别整份字幕都丢掉
    if (!got) {
      got = []
      for (const line of chunk) {
        if (ctx.shouldStop && ctx.shouldStop()) throw new Error('CANCELLED')
        try {
          got.push((await googleBatch([line], ctx))[0] || '')
        } catch (e) {
          got.push('') // 单条也失败就留空，稍后用原文兜底
        }
        await sleep(200)
      }
    }
    out.push(...got)
    if (ctx.onProgress) ctx.onProgress(Math.min(i + BATCH_SIZE, lines.length), lines.length)
  }
  return out
}

// -------- 引擎二：OpenAI 兼容接口 --------
function extractJsonArray(text) {
  // 兼容模型把 JSON 包在 ```json 里、或前后带解释的情况
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced ? fenced[1] : text
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON 数组')
  return JSON.parse(raw.slice(start, end + 1))
}

async function aiBatch(lines, { proxy, baseUrl, apiKey, model }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('未配置 AI 接口地址（Base URL）')
  if (!apiKey) throw new Error('未配置 AI 接口密钥（API Key）')
  const sys =
    '你是专业的视频字幕翻译。用户会给你一个 JSON 字符串数组，每个元素是一行英文字幕（来自语音识别，' +
    '可能没有标点、断句零碎）。请逐行翻译成自然通顺的简体中文。要求：' +
    '1) 严格返回同样长度的 JSON 字符串数组，不要多余解释、不要 Markdown 代码块；' +
    '2) 第 i 条译文必须对应第 i 条原文，不得合并或拆分；' +
    '3) 保留专有名词原文（如 Unreal Engine、GAS），必要时可在译文中直接沿用英文；' +
    '4) 单行译文尽量简短，适合作为字幕显示。'
  const body = JSON.stringify({
    model: model || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(lines) }
    ]
  })
  const r = await request(base + '/chat/completions', {
    proxy,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body,
    timeout: 60000
  })
  if (r.status !== 200) {
    let msg = ''
    try {
      const j = JSON.parse(r.body)
      msg = (j.error && (j.error.message || j.error)) || ''
    } catch (e) {}
    throw new Error('AI 接口 HTTP ' + r.status + (msg ? '：' + String(msg).slice(0, 160) : ''))
  }
  let j
  try {
    j = JSON.parse(r.body)
  } catch (e) {
    throw new Error('AI 接口返回了非 JSON 内容')
  }
  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  if (!content) throw new Error('AI 接口未返回翻译内容')
  const arr = extractJsonArray(content)
  if (!Array.isArray(arr)) throw new Error('AI 返回的不是数组')
  if (arr.length !== lines.length) {
    throw new Error(`AI 返回条数不匹配（${arr.length}/${lines.length}）`)
  }
  return arr.map((s) => String(s == null ? '' : s).trim())
}

async function translateByAI(lines, ctx) {
  // AI 单次能吃更多，但太大容易漏行 → 20 条一批更稳
  const size = 20
  const out = []
  for (let i = 0; i < lines.length; i += size) {
    const chunk = lines.slice(i, i + size)
    if (ctx.shouldStop && ctx.shouldStop()) throw new Error('CANCELLED')
    let got = null
    let lastErr = null
    for (let attempt = 1; attempt <= 2 && !got; attempt++) {
      try {
        got = await aiBatch(chunk, ctx)
      } catch (e) {
        lastErr = e
        if (attempt < 2) await sleep(800)
      }
    }
    if (!got) throw lastErr || new Error('AI 翻译失败')
    out.push(...got)
    if (ctx.onProgress) ctx.onProgress(Math.min(i + size, lines.length), lines.length)
  }
  return out
}

// -------- 对外：翻译一个 srt 文件 --------
// provider: 'google' | 'ai'
// config: { baseUrl, apiKey, model }（仅 ai 需要）
// proxy:   本地 HTTP 代理地址，空串表示直连
// shouldStop(): 返回 true 表示用户已取消
// onProgress(done, total)
async function translateSrtFile({ srtPath, outPath, provider = 'google', config = {}, proxy = '', shouldStop, onProgress }) {
  const raw = fs.readFileSync(srtPath, 'utf8')
  const cues = parseSrt(raw)
  if (!cues.length) throw new Error('英文字幕为空，无法翻译')

  const lines = cues.map((c) => cleanForTranslate(c.text))
  const ctx = {
    proxy,
    ...config,
    shouldStop,
    onProgress: (done, total) => onProgress && onProgress(done, total)
  }
  const translated =
    provider === 'ai' ? await translateByAI(lines, ctx) : await translateByGoogle(lines, ctx)

  // 单条翻译失败会得到空串 —— 保留原文，不要出现空字幕
  cues.forEach((c, i) => {
    const t = translated[i]
    c.text = t && t.length ? t : cleanForTranslate(c.text)
  })

  fs.writeFileSync(outPath, toSrt(cues), 'utf8')
  return { cues: cues.length, provider }
}

// 缓存路径：与视频同名，独立后缀
function translatedSubPath(videoPath) {
  return path.join(
    path.dirname(videoPath),
    path.basename(videoPath, path.extname(videoPath)) + CACHE_SUFFIX
  )
}

// 测试用：翻一句样句
async function testTranslate({ provider = 'google', config = {}, proxy = '' }) {
  const sample = 'This is a subtitle translation test.'
  const ctx = { proxy, ...config }
  const out = provider === 'ai' ? await aiBatch([sample], ctx) : await googleBatch([sample], ctx)
  return { text: out[0] || '', engine: provider }
}

module.exports = { translateSrtFile, translatedSubPath, testTranslate, cleanForTranslate, CACHE_SUFFIX }
