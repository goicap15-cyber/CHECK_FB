// TempMailG client — https://v1.tempmailg.com/api (Bearer key)
// Free plan: 8 domain free, TỐI ĐA 1 hòm active cùng lúc (mailbox_limit=1) + quota 20 lần tạo
// → createEmail luôn DELETE hòm trước đó để nhả slot. Interface giống TempMailAPI
// (createEmail → {email, sidToken=email}, pollForOtp → {otp, subject, mailId}).
const https = require('https')
const fs = require('fs')
const path = require('path')

const KEY_FILE = path.join(__dirname, 'tempmailg_key.txt')
const DEFAULT_API_KEY = '0WPRnBWJRI6biCzt5aq7PPSiWemLrXEdxTJrxRSq3f7c1ac2'
let API_KEY = DEFAULT_API_KEY
try {
  const saved = fs.readFileSync(KEY_FILE, 'utf8').trim()
  if (saved) API_KEY = saved
} catch {}

const FALLBACK_DOMAINS = ['easymailer.shop', 'fast.speedlooking.fun', 'flashemail.site', 'hello.nondon.site', 'nondon.site', 'privmail.easymailer.shop', 'speedlooking.fun', 'zen.flashemail.site']

// Plan free chỉ cho 1 hòm active: slot chia sẻ MODULE-LEVEL giữa mọi instance/worker
let LAST_ACTIVE_EMAIL = ''

class TempMailG {
  constructor(baseUrl = 'https://v1.tempmailg.com', timeoutMs = 15000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this._domains = null
  }

  _req(method, urlPath, bodyObj) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.baseUrl + urlPath)
      const payload = bodyObj ? JSON.stringify(bodyObj) : null
      const opts = {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        timeout: this.timeoutMs
      }
      if (payload) {
        opts.headers['Content-Type'] = 'application/json'
        opts.headers['Content-Length'] = Buffer.byteLength(payload)
      }
      const req = https.request(opts, (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(data) }
        })
      })
      req.on('timeout', () => { req.destroy(new Error('Timeout TempMailG')) })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  async getDomains() {
    if (this._domains && this._domains.length) return this._domains
    try {
      const res = await this._req('GET', '/api/domains?type=free')
      const list = res && res.data && Array.isArray(res.data.domains) ? res.data.domains : []
      const ds = list.map(d => d.domain).filter(Boolean)
      if (ds.length) { this._domains = ds; return ds }
    } catch {}
    return FALLBACK_DOMAINS
  }

  // Nhả slot hòm cũ (plan free chỉ cho 1 hòm active)
  async deleteEmail(email) {
    if (!email) return
    try { await this._req('DELETE', `/api/emails/${encodeURIComponent(email)}`) } catch {}
    if (LAST_ACTIVE_EMAIL === email) LAST_ACTIVE_EMAIL = ''
  }

  async createEmail(domain = null) {
    if (LAST_ACTIVE_EMAIL) await this.deleteEmail(LAST_ACTIVE_EMAIL)
    if (!domain) {
      try {
        const ds = await this.getDomains()
        if (Array.isArray(ds) && ds.length) domain = ds[Math.floor(Math.random() * ds.length)]
      } catch {}
    }
    const body = {}
    if (domain) body.domain = domain
    body.lifetime = '2h'
    const res = await this._req('POST', '/api/emails', body)
    const data = res && res.data ? res.data : null
    const email = data && (data.email || data.address) || ''
    if (!email) {
      const msg = (res && (res.message || res.msg || res.error)) || 'Không tạo được email từ tempmailg.com'
      throw new Error(msg)
    }
    LAST_ACTIVE_EMAIL = email
    return { email, sidToken: email }
  }

  async getEmailList(sidToken, limit = 20) {
    const res = await this._req('GET', `/api/messages?email=${encodeURIComponent(sidToken)}`)
    if (res && res.status === false) {
      const q = res.quota || {}
      const remain = q.monthly_remaining != null ? ` (còn ${q.monthly_remaining}/${q.monthly_limit})` : ''
      throw new Error(`${res.message || 'Lỗi TempMailG'}${remain}`)
    }
    const arr = res && Array.isArray(res.messages) ? res.messages : []
    return arr.slice(0, limit).map(e => ({
      mail_id: String(e.id != null ? e.id : ''),
      id: e.id,
      mail_subject: e.subject || '',
      mail_from: e.from_email || e.from || ''
    }))
  }

  async fetchEmail(sidToken, mailId) {
    const res = await this._req('GET', `/api/messages/${encodeURIComponent(mailId)}`)
    const src = res && res.data && typeof res.data === 'object' ? res.data : (res || {})
    const body = src.content || src.body || src.body_html || src.html || src.text || ''
    const subject = src.subject || ''
    return { ...src, mail_subject: subject, mail_body: body }
  }

  extractOtp(subject = '', bodyHtml = '', length = 5) {
    const subjMatches = subject.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`))
    if (subjMatches && subjMatches[1]) return subjMatches[1]
    const cleanText = bodyHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const ctxRegex = new RegExp(`(?:code|mã|ma|xác|xac|nhận|nhan|fb|facebook)[^\\d]{0,35}(\\d{${length}})(?!\\d)`, 'i')
    const ctxMatch = cleanText.match(ctxRegex)
    if (ctxMatch && ctxMatch[1]) return ctxMatch[1]
    const fallbackMatches = cleanText.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`))
    if (fallbackMatches && fallbackMatches[1]) return fallbackMatches[1]
    return null
  }

  async pollForOtp(sidToken, existingMailIds = new Set(), maxAttempts = 20, intervalMs = 8000, logCallback = () => {}) {
    // Mỗi lần poll tốn 1 quota call (free = 20/tháng) → chặn trần 12 lần / 10s một lần
    maxAttempts = Math.min(maxAttempts, 12)
    intervalMs = Math.max(intervalMs, 10000)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logCallback(`Đang chờ email OTP (lần ${attempt}/${maxAttempts})...`)
      try {
        const emails = await this.getEmailList(sidToken)
        const newEmails = emails.filter(e => !existingMailIds.has(String(e.mail_id || '')))
        if (newEmails.length > 0) {
          const latestMail = newEmails[0]
          const mailId = latestMail.mail_id
          const detail = await this.fetchEmail(sidToken, mailId)
          const subject = detail.mail_subject || latestMail.mail_subject || ''
          const body = detail.mail_body || ''
          // FB email code là 6 số ("651404 is your code...") — 5 số chỉ là dự phòng
          const otp = this.extractOtp(subject, body, 6) || this.extractOtp(subject, body, 5)
          if (otp) {
            logCallback(`Tìm thấy mã OTP: ${otp}`)
            return { otp, subject, mailId }
          }
        }
      } catch (err) {
        logCallback(`Lỗi poll OTP: ${err.message}`)
        if (/quota/i.test(err.message)) return null
      }
      await new Promise(r => setTimeout(r, intervalMs))
    }
    return null
  }
}

module.exports = TempMailG
module.exports.getApiKey = () => API_KEY
module.exports.setApiKey = (k) => {
  API_KEY = String(k || '').trim()
  try { if (API_KEY) fs.writeFileSync(KEY_FILE, API_KEY, 'utf8') } catch {}
}
