// Proxy helpers cho Auto Reg FB
// Parse nhiều định dạng + kiểm tra proxy sống/chết + geo (quốc gia/ISP/ping) — theo mẫu AUTO_BM:
// primary: ip.decodo.com/json qua chính proxy (ra IP + Country + City + ISP + ping)
// fallback: ipify (IP) + facebook.com/robots.txt, geo từ cache hoặc ip-api trực tiếp

const { session, net } = require('electron')
const fs = require('fs')
const path = require('path')

// Parse 1 dòng proxy: IP:Port | IP:Port:User:Pass | User:Pass@IP:Port | scheme://...
function parseProxyLine(raw) {
  let line = String(raw || '').trim()
  if (!line || line.startsWith('#')) return null
  let scheme = null
  const sm = line.match(/^(https?|socks[45]?):\/\//i)
  if (sm) {
    scheme = sm[1].toLowerCase()
    line = line.slice(sm[0].length)
  }
  let auth = null
  const at = line.lastIndexOf('@')
  if (at !== -1) {
    const cred = line.slice(0, at)
    const ci = cred.indexOf(':')
    if (ci !== -1) auth = { user: cred.slice(0, ci), pass: cred.slice(ci + 1) }
    line = line.slice(at + 1)
  }
  const parts = line.split(':').filter(p => p !== '')
  let host = '', port = ''
  if (!auth && parts.length >= 4) {
    host = parts[0]
    port = parts[1]
    auth = { user: parts[2], pass: parts.slice(3).join(':') }
  } else if (parts.length >= 2) {
    host = parts[0]
    port = parts[1]
  } else if (parts.length === 1) {
    host = parts[0]
  }
  if (!host || !port) return null
  let rules
  if (scheme === 'socks4' || scheme === 'socks5') {
    rules = (scheme === 'socks5' ? 'socks5=' : 'socks=') + host + ':' + port
  } else {
    rules = host + ':' + port
  }
  return { rules, auth: auth ? { ...auth, host, port } : null, display: `${host}:${port}` }
}

// ── GeoIP cache (persist ra geoip_cache.json cạnh app, kiểu AUTO_BM) ──
const GEO_FILE = path.join(__dirname, 'geoip_cache.json')
let geoCache = {}
try { geoCache = JSON.parse(fs.readFileSync(GEO_FILE, 'utf8')) || {} } catch { geoCache = {} }
let geoFlushT = null
function saveGeo(host, geo) {
  geoCache[host] = geo
  if (geoFlushT) return
  geoFlushT = setTimeout(() => {
    geoFlushT = null
    try { fs.writeFileSync(GEO_FILE, JSON.stringify(geoCache, null, 2)) } catch {}
  }, 800)
}

// 🇺🇸 từ country code
function flagOf(cc) {
  if (!cc || String(cc).length !== 2) return ''
  return String.fromCodePoint(...String(cc).toUpperCase().split('').map(c => 127397 + c.charCodeAt(0)))
}

function authHandler(p) {
  return (authInfo, callback) => {
    if (p.auth) callback(p.auth.user, p.auth.pass)
  }
}

// Request qua proxy session, trả body string hoặc null (timeout/lỗi)
function proxyGet(chkSes, p, url, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    const finish = r => { if (!done) { done = true; clearTimeout(t); resolve(r) } }
    const t = setTimeout(() => finish(null), timeoutMs)
    try {
      const req = net.request({ url, session: chkSes })
      req.on('login', authHandler(p))
      req.on('response', res => {
        let buf = ''
        res.on('data', c => { buf += c })
        res.on('end', () => finish(buf))
      })
      req.on('error', () => finish(null))
      req.end()
    } catch { finish(null) }
  })
}

// Phản hồi HTTP nào cũng tính là "tới được" (kể cả 4xx) — quan trọng là không treo
function proxyReachable(chkSes, p, url, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    const finish = r => { if (!done) { done = true; clearTimeout(t); resolve(r) } }
    const t = setTimeout(() => finish(false), timeoutMs)
    try {
      const req = net.request({ url, session: chkSes })
      req.on('login', authHandler(p))
      req.on('response', () => finish(true))
      req.on('error', () => finish(false))
      req.end()
    } catch { finish(false) }
  })
}

// Geo trực tiếp (không qua proxy) cho fallback path, 3s timeout
function geoDirect(ipOrHost) {
  return new Promise(resolve => {
    let done = false
    const finish = r => { if (!done) { done = true; clearTimeout(t); resolve(r) } }
    const t = setTimeout(() => finish(null), 3000)
    try {
      const req = net.request(`http://ip-api.com/json/${encodeURIComponent(ipOrHost)}?fields=status,country,countryCode,city,isp`)
      req.setHeader('User-Agent', 'Mozilla/5.0')
      req.on('response', res => {
        let buf = ''
        res.on('data', c => { buf += c })
        res.on('end', () => {
          try {
            const j = JSON.parse(buf)
            if (j.status === 'success') finish({ country: j.country || 'N/A', countryCode: (j.countryCode || 'un').toLowerCase(), city: j.city || '', isp: j.isp || '' })
            else finish(null)
          } catch { finish(null) }
        })
      })
      req.on('error', () => finish(null))
      req.end()
    } catch { finish(null) }
  })
}

// Kiểm tra proxy sống/chết + geo. Trả null (chết) | { ip, pingMs, geo: {country, countryCode, city, isp} | null }
// Luôn kiểm tra nốt facebook.com: nhiều proxy datacenter qua được ipify nhưng treo/chặn với FB
async function checkProxy(p, timeoutMs = 25000) {
  return new Promise(resolve => {
    let settled = false
    const finish = r => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => finish(null), timeoutMs)
    ;(async () => {
      const chkSes = session.fromPartition('proxychk_' + Date.now() + '_' + Math.random())
      await chkSes.setProxy({ mode: 'fixed_servers', proxyRules: p.rules })

      // 1. Primary: decodo qua proxy → IP + geo + ping trong 1 lần
      const t0 = Date.now()
      const body = await proxyGet(chkSes, p, 'https://ip.decodo.com/json?provider=IPinfo', 15000)
      let ip = null, geo = null
      if (body) {
        try {
          const j = JSON.parse(body)
          const po = j.proxy || {}
          ip = typeof po === 'object' ? po.ip : null
          const co = j.country
          const cityO = j.city
          const ispO = j.isp
          geo = {
            country: typeof co === 'object' ? (co.name || 'N/A') : (co || 'N/A'),
            countryCode: String(typeof co === 'object' ? (co.code || 'un') : 'un').toLowerCase(),
            city: typeof cityO === 'object' ? (cityO.name || '') : (cityO || ''),
            isp: (typeof ispO === 'object' ? (ispO.isp || ispO.organization || '') : (ispO || ''))
          }
        } catch {}
      }

      // 2. Fallback: ipify (IP) — geo lấy cache hoặc ip-api
      if (!ip) {
        const jb = await proxyGet(chkSes, p, 'https://api.ipify.org/?format=json', 10000)
        try { ip = JSON.parse(jb || '').ip || null } catch {}
        if (ip) {
          geo = geoCache[p.display] || null
          if (!geo) {
            geo = await geoDirect(p.display.split(':')[0])
            if (geo) saveGeo(p.display, geo)
          }
        }
      }
      if (!ip) return finish(null)

      // 3. Bắt buộc: facebook.com phải phản hồi được
      const fbOk = await proxyReachable(chkSes, p, 'https://www.facebook.com/robots.txt', 12000)
      if (!fbOk) return finish(null)

      if (geo && geo.country !== 'N/A') saveGeo(p.display, geo)
      finish({ ip, pingMs: Date.now() - t0, geo })
    })().catch(() => finish(null))
  })
}

// ── Proxy API: dán link API vào ô proxy — mỗi nick lúc reg tự gọi link lấy proxy mới ──

// Trích dòng proxy từ response của link API. Hỗ trợ JSON nhiều kiểu (TMProxy data.https_Curl,
// {ip,port}, {proxy:{host,port,user,pass}},...) và text trần "ip:port[:user:pass]" / "user:pass@ip:port"
function extractProxyFromApiResponse(buf, overrideAuth) {
  const text = String(buf || '').trim()
  if (!text) return null
  let line = null
  try {
    const j = JSON.parse(text)
    const found = {}
    // proxyno1.com: data.http = "host:port" (hostname, không phải IP) — detect trước walk()
    const data = j && j.data ? j.data : null
    if (data && typeof data === 'object') {
      // key-status trả: { http: "host:port", sock5: "host:port" }
      for (const httpKey of ['http', 'https', 'http_ipv4', 'https_ipv4']) {
        if (data[httpKey] && typeof data[httpKey] === 'string' && data[httpKey].includes(':')) {
          found.hostport = data[httpKey].trim(); break
        }
      }
    }
    const walk = (o) => {
      if (!o || typeof o !== 'object') return
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object') { walk(v); continue }
        if (v === null || v === undefined || v === '') continue
        const key = String(k).toLowerCase()
        const s = String(v).trim()
        if (found.ip === undefined && ['ip', 'ipv4', 'host', 'address', 'proxy_ip', 'proxyip'].includes(key)) found.ip = s
        else if (found.port === undefined && ['port', 'proxy_port', 'proxyport'].includes(key)) found.port = s
        else if (found.user === undefined && ['username', 'user', 'proxy_user', 'proxyuser', 'login', 'authen'].includes(key)) found.user = s
        else if (found.pass === undefined && ['password', 'pass', 'proxy_pass', 'proxypass'].includes(key)) found.pass = s
        else if (found.curlLine === undefined && s.length <= 120) {
          const m = s.match(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})(?::([^\s:]+):(\S+))?/)
          if (m) found.curlLine = m[0]
        }
      }
    }
    walk(j)
    // Override auth từ URL ?_auth=user:pass nếu có
    if (overrideAuth) { found.user = overrideAuth.user; found.pass = overrideAuth.pass }
    if (found.ip && found.port) line = (found.user || found.pass) ? `${found.ip}:${found.port}:${found.user || ''}:${found.pass || ''}` : `${found.ip}:${found.port}`
    else if (found.hostport) {
      // proxyno1: "svhn3.proxyno1.com:27014" → dùng trực tiếp
      line = (found.user || found.pass) ? `${found.user}:${found.pass}@${found.hostport}` : found.hostport
    } else if (found.curlLine) {
      // TMProxy trả https/socks5 chỉ là "ip:port", user/pass ở field username/password riêng → ghép vào
      const colon = (found.curlLine.match(/:/g) || []).length
      line = (found.user || found.pass) && colon === 1 ? `${found.curlLine}:${found.user || ''}:${found.pass || ''}` : found.curlLine
    }
  } catch {
    const mAt = text.match(/([^\s:@/]+):([^\s:@]+)@([^\s/]+:\d{2,5})/)
    if (mAt) line = `${mAt[1]}:${mAt[2]}@${mAt[3]}`
    else {
      const mAt2 = text.match(/([^\s:@/]+):([^\s:@]+)@(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/)
      if (mAt2) line = `${mAt2[3]}:${mAt2[4]}:${mAt2[1]}:${mAt2[2]}`
      else {
        const m = text.match(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})(?::([^\s:]+):([^\s:]+))?/)
        if (m) line = m[0]
      }
    }
  }
  return line ? parseProxyLine(line) : null
}

// Gọi link API lấy 1 proxy mới (không qua proxy, tách session riêng khỏi cache).
// GET mặc định; link TMProxy tự chuyển POST {api_key} — dán dạng
// https://tmproxy.com/api/proxy/get-new-proxy?api_key=XXX
let apiFetchSes = null
function httpFetchApi(url, method, body, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    const finish = r => { if (!done) { done = true; clearTimeout(t); resolve(r) } }
    const t = setTimeout(() => finish(null), timeoutMs)
    ;(async () => {
      if (!apiFetchSes) apiFetchSes = session.fromPartition('apiproxy_fetch')
      try { await apiFetchSes.clearCache() } catch {}
      const req = net.request({ url, session: apiFetchSes, method })
      req.setHeader('User-Agent', 'Mozilla/5.0')
      if (body) {
        req.setHeader('Content-Type', 'application/json')
        req.write(JSON.stringify(body))
      }
      req.on('response', res => {
        let buf = ''
        res.on('data', c => { buf += c })
        res.on('end', () => finish(buf))
      })
      req.on('error', () => finish(null))
      req.end()
    })().catch(() => finish(null))
  })
}

async function fetchProxyFromApi(url, timeoutMs = 15000) {
  let reqUrl = url
  let method = 'GET'
  let body = null
  let tmRotate = false
  let overrideAuth = null
  try {
    // Hỗ trợ ?_auth=user:pass — credentials nhúng trong URL, không gửi lên server
    const authM = url.match(/[?&]_auth=([^&#]+)/i)
    if (authM) {
      const cred = decodeURIComponent(authM[1])
      const ci = cred.indexOf(':')
      if (ci > 0) overrideAuth = { user: cred.slice(0, ci), pass: cred.slice(ci + 1) }
      // Xoá _auth khỏi URL trước khi gọi
      reqUrl = url.replace(/([?&])_auth=[^&#]*/i, (m, sep) => sep === '?' ? '?' : '').replace(/[?&]$/, '')
    }
    if (/tmproxy\./i.test(reqUrl)) {
      method = 'POST'
      const km = reqUrl.match(/(?:api_key|key|token)=([^&#]+)/i)
      reqUrl = reqUrl.replace(/\?.*$/, '')
      body = { api_key: km ? km[1] : '' }
      tmRotate = /get-new-proxy/i.test(reqUrl)
    }
  } catch {}
  let buf = await httpFetchApi(reqUrl, method, body, timeoutMs)
  // TMProxy chặn đổi IP quá sớm (code 5 "retry after Ns" — giữ IP tối thiểu ~4p)
  // → lấy proxy HIỆN TẠI qua get-current-proxy (endpoint xem, không bị khoá) thay vì bỏ nick
  if (buf && tmRotate) {
    try {
      if (JSON.parse(buf).code === 5) {
        buf = await httpFetchApi(reqUrl.replace('get-new-proxy', 'get-current-proxy'), 'POST', body, timeoutMs)
      }
    } catch {}
  }
  return buf ? extractProxyFromApiResponse(buf, overrideAuth) : null
}

module.exports = { parseProxyLine, checkProxy, flagOf, extractProxyFromApiResponse, fetchProxyFromApi }
