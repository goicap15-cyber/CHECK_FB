// TempEmail.cc client (API v2) — https://www.tempemail.cc/document
// Đặc điểm:
//  - POST /api/accounts {email,password}  (KHÔNG cần auth, rate limit 1 lần/30s/IP, CHẶN UA mặc định Node)
//  - GET  /api/messages?limit=10..50      (Bearer JWT) -> {code,data:{items:[{id,from,subject,summary}]}}
//  - GET  /api/messages/:id               (Bearer JWT) -> chi tiết
//  - GET  /api/domains                    -> {code,data:['domain']}
//  - Mọi response bọc {code, message, data}
// Interface tương thích TempMailAPI: createEmail()->{email, sidToken:JWT}, getEmailList, fetchEmail, pollForOtp
const https = require('https')

const BASE = 'https://www.tempemail.cc'
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const FALLBACK_DOMAINS = ['icmans.com']

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randStr(n) {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const all = letters + '0123456789'
  let s = letters[Math.floor(Math.random() * letters.length)]
  for (let i = 1; i < (n || 10); i++) s += all[Math.floor(Math.random() * all.length)]
  return s
}

function httpReq(method, urlPath, bodyObj, token) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // API chặn UA mặc định của Node ("Access denied. Invalid User-Agent") — bắt buộc UA trình duyệt
      'User-Agent': UA_BROWSER,
      'Origin': BASE,
      'Referer': BASE + '/'
    }
    if (token) headers['Authorization'] = 'Bearer ' + token
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload)
    const u = new URL(BASE + urlPath)
    const req = https.request({ hostname: u.hostname, path: u.pathname + (u.search || ''), method, headers, timeout: 20000 }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', c => { raw += c })
      res.on('end', () => {
        try { resolve({ s: res.statusCode, j: JSON.parse(raw) }) } catch { resolve({ s: res.statusCode, raw }) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Timeout tempemail.cc')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// Rate limit API: 1 đăng ký / 30 giây / IP. Hàng đợi THEO TỪNG IP (queueKey = proxy) —
// luồng chạy proxy khác nhau tạo email SONG SONG, chỉ luồng cùng 1 IP mới xếp hàng chờ
const _queues = new Map()  // key -> promise chain
const _lastAt = new Map()  // key -> timestamp lần tạo cuối

class TempMailV2 {
  constructor(baseUrl) { this.base = baseUrl || BASE; this.queueKey = 'default' }

  async getDomains() {
    try {
      const r = await httpReq('GET', '/api/domains')
      if (r.s === 200 && r.j && r.j.code === 200 && Array.isArray(r.j.data) && r.j.data.length) {
        return r.j.data.filter(Boolean)
      }
    } catch {}
    return FALLBACK_DOMAINS
  }

  async createEmail() {
    const key = this.queueKey || 'default'
    if (!_queues.has(key)) _queues.set(key, Promise.resolve())
    const run = _queues.get(key).then(async () => {
      const waitMs = (_lastAt.get(key) || 0) + 31000 - Date.now()
      if (waitMs > 0) await sleep(waitMs)
      let lastErr = null
      for (let t = 1; t <= 3; t++) {
        try {
          const domains = await this.getDomains()
          const domain = domains[Math.floor(Math.random() * domains.length)] || FALLBACK_DOMAINS[0]
          const email = randStr(7) + randStr(4) + '@' + domain
          const password = randStr(10) + 'Bb2!A'
          const r = await httpReq('POST', '/api/accounts', { email, password })
          if (r.s === 200 && r.j && r.j.code === 200 && r.j.data && r.j.data.token) {
            _lastAt.set(key, Date.now())
            return { email: r.j.data.name || email, sidToken: r.j.data.token }
          }
          const m = (r.j && r.j.message) || ('HTTP ' + r.s)
          lastErr = new Error('tempemail.cc createEmail: ' + m)
          if (t < 3) await sleep(4000)
        } catch (e) { lastErr = e; if (t < 3) await sleep(4000) }
      }
      throw lastErr || new Error('tempemail.cc createEmail thất bại')
    })
    _queues.set(key, run.catch(() => {}))
    return run
  }

  async getEmailList(sidToken, limit = 20) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 10), 50)
    const r = await httpReq('GET', '/api/messages?limit=' + lim, null, sidToken)
    if (r.s !== 200 || !r.j || r.j.code !== 200 || !r.j.data || !Array.isArray(r.j.data.items)) return []
    return r.j.data.items.map(e => ({
      mail_id: String(e.id || ''),
      id: e.id,
      mail_subject: e.subject || '',
      mail_from: e.from || ''
    }))
  }

  async fetchEmail(sidToken, mailId) {
    const r = await httpReq('GET', '/api/messages/' + encodeURIComponent(mailId), null, sidToken)
    if (r.s !== 200 || !r.j || !r.j.data) return null
    const d = r.j.data
    let body = d.html || d.body || d.text || d.content || ''
    if (typeof body !== 'string') body = JSON.stringify(body)
    return { ...d, mail_subject: d.subject || '', mail_body: body }
  }

  extractOtp(subject = '', bodyHtml = '', length = 5) {
    const subjMatches = subject.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`))
    if (subjMatches && subjMatches[1]) return subjMatches[1]
    const cleanText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const ctxRegex = new RegExp(`(?:code|mã|ma|xác|xac|nhận|nhan|fb|facebook)[^\\d]{0,35}(\\d{${length}})(?!\\d)`, 'i')
    const ctxMatch = cleanText.match(ctxRegex)
    if (ctxMatch && ctxMatch[1]) return ctxMatch[1]
    const fallbackMatches = cleanText.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`))
    return fallbackMatches ? fallbackMatches[1] : null
  }

  async pollForOtp(sidToken, existingMailIds = new Set(), maxAttempts = 25, intervalMs = 6000, logCallback = () => {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logCallback(`[tempemail.cc] Chờ OTP lần ${attempt}/${maxAttempts}...`)
      try {
        const msgs = await this.getEmailList(sidToken, 20)
        const news = msgs.filter(m => !existingMailIds.has(String(m.mail_id || '')))
        if (news.length > 0) {
          const msg = news[0]
          logCallback(`[tempemail.cc] Email mới: ${msg.mail_subject}`)
          let body = ''
          try { const d = await this.fetchEmail(sidToken, msg.mail_id); if (d) body = d.mail_body || '' } catch {}
          // FB email code là 6 số, fallback 5 số
          const otp = this.extractOtp(msg.mail_subject || '', body, 6) || this.extractOtp(msg.mail_subject || '', body, 5)
          if (otp) {
            logCallback(`[tempemail.cc] OTP: ${otp}`)
            return { otp, subject: msg.mail_subject, mailId: msg.mail_id }
          }
          existingMailIds.add(String(msg.mail_id || ''))
        }
      } catch (err) { logCallback(`[tempemail.cc] Lỗi: ${err.message}`) }
      if (attempt < maxAttempts) await sleep(intervalMs)
    }
    return null
  }
}

module.exports = TempMailV2
