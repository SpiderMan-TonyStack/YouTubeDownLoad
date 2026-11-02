const net = require('net')
const http = require('http')

// 常见本地代理端口（Clash / FlClash / Clash Verge / v2rayN / 通用）
const HTTP_PROXY_PORTS = [7890, 7897, 7898, 7899, 10809, 1080, 2080, 8888, 8889, 8080, 20171]
// 常见 Clash 兼容内核的控制接口端口（external-controller）
const CONTROLLER_PORTS = [9090, 9097, 9091, 9095, 6170, 9099]

const HOST = '127.0.0.1'
// 控制接口 /proxies 可能返回几百 KB，但绝不该到 MB 级；设上限避免异常端点把内存打满
const MAX_BODY = 8 * 1024 * 1024

function probeTcp(port, timeout = 350) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, HOST)
  })
}

function httpRequest({ url, method = 'GET', secret = '', body = null, timeout = 2000 }) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      return resolve({ status: 0, error: '地址无效' })
    }
    const headers = {}
    if (secret) headers.Authorization = 'Bearer ' + secret
    if (body) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(body)
    }
    const req = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = ''
        let size = 0
        res.setEncoding('utf8')
        res.on('data', (c) => {
          size += Buffer.byteLength(c)
          if (size > MAX_BODY) {
            res.destroy()
            return resolve({ status: 0, error: '控制接口响应过大，已中断' })
          }
          data += c
        })
        res.on('error', (e) => resolve({ status: 0, error: e.message }))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      }
    )
    req.setTimeout(timeout, () => {
      req.destroy()
      resolve({ status: 0, error: '超时' })
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    if (body) req.write(body)
    req.end()
  })
}

// 找到一个可用的本地 HTTP 代理端口
// 端口全部并发探测（各自 350ms 超时），再按优先级取第一个通的 —— 串行最坏要 4 秒
async function findLocalProxyPort(preferred) {
  const list = preferred ? [preferred, ...HTTP_PROXY_PORTS] : HTTP_PROXY_PORTS
  const results = await Promise.all(list.map((port) => probeTcp(port)))
  const i = results.indexOf(true)
  return i >= 0 ? list[i] : null
}

// 探测 Clash 兼容内核的控制接口（external-controller）
async function findController(secret, preferredPort) {
  const ports = preferredPort ? [preferredPort, ...CONTROLLER_PORTS] : CONTROLLER_PORTS
  // 同样并发探测；结果按端口优先级排序后再挑选
  const results = await Promise.all(
    ports.map(async (port) => {
      if (!(await probeTcp(port))) return null
      const url = `http://${HOST}:${port}`
      const r = await httpRequest({ url: url + '/version', secret })
      if (r.status === 200) {
        let version = ''
        try {
          version = JSON.parse(r.body).version || ''
        } catch (e) {}
        return { url, port, version, secret }
      }
      if (r.status === 401 || r.status === 403) return { url, port, unauthorized: true }
      return null
    })
  )
  const ok = results.find((r) => r && !r.unauthorized)
  if (ok) return ok
  const un = results.find((r) => r && r.unauthorized)
  if (un) return { url: un.url, port: un.port, needsSecret: true }
  return null
}

// 综合检测：本地代理端口 + 控制接口（两路并行，互不等待）
async function detect({ secret = '', controllerPort = null, proxyPort = null } = {}) {
  const [port, controller] = await Promise.all([
    findLocalProxyPort(proxyPort),
    findController(secret, controllerPort)
  ])
  return {
    proxyPort: port,
    proxyUrl: port ? `http://${HOST}:${port}` : '',
    controller
  }
}

// 列出可选节点（仅取带 all 的选择器类分组）
async function listNodes({ controllerUrl, secret = '' }) {
  if (!controllerUrl) throw new Error('未检测到控制接口')
  const r = await httpRequest({ url: controllerUrl + '/proxies', secret })
  if (r.status === 401 || r.status === 403) throw new Error('控制接口密钥不正确')
  if (r.status !== 200) throw new Error(r.error || `控制接口返回 ${r.status}`)
  let proxies = {}
  try {
    proxies = JSON.parse(r.body).proxies || {}
  } catch (e) {
    throw new Error('控制接口返回内容无法解析')
  }
  const groups = []
  for (const [name, p] of Object.entries(proxies)) {
    if (!p || !Array.isArray(p.all) || !p.all.length) continue
    if (!['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'].includes(p.type)) continue
    groups.push({ name, type: p.type, now: p.now || '', all: p.all })
  }
  return groups
}

// 切换某个分组当前选中的节点
async function selectNode({ controllerUrl, secret = '', group, node }) {
  const r = await httpRequest({
    url: controllerUrl + '/proxies/' + encodeURIComponent(group),
    method: 'PUT',
    secret,
    body: JSON.stringify({ name: node })
  })
  if (r.status === 204 || r.status === 200) return true
  if (r.status === 401 || r.status === 403) throw new Error('控制接口密钥不正确')
  throw new Error(r.error || `切换失败（HTTP ${r.status}）`)
}

// 通过代理做一次真实连通性测试（HTTP 代理的绝对 URI 形式，无需 CONNECT）
function testProxy(proxyUrl, timeout = 8000) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(proxyUrl)
    } catch (e) {
      return resolve({ ok: false, error: '代理地址无效' })
    }
    const target = 'http://www.gstatic.com/generate_204'
    const started = Date.now()
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        method: 'GET',
        path: target,
        headers: { Host: 'www.gstatic.com' }
      },
      (res) => {
        res.resume()
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          ms: Date.now() - started
        })
      }
    )
    req.setTimeout(timeout, () => {
      req.destroy()
      resolve({ ok: false, error: '超时（代理可能未开启或端口不对）' })
    })
    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    req.end()
  })
}

module.exports = { detect, listNodes, selectNode, testProxy }
