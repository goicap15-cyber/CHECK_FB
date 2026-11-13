// Mail.td client — https://api.mail.td (Bearer td_ token)
// Docs: GET /api/domains (public), POST /api/accounts {address,password} → {id,address,token},
// GET /api/accounts/{email}/messages?page=1, GET .../messages/{id}, DELETE /api/accounts/{email}.
// Rate limit: tạo mailbox 1 lần/giây, route khác 10 lần/giây. Interface giống TempMailAPI
// (createEmail → {email, sidToken=email}, pollForOtp → {otp, subject, mailId}).
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const KEY_FILE = path.join(__dirname, 'mailtd_key.txt')
const DEFAULT_API_KEY = 'td_89315499a3d798e83ae710af29dacb66ce4516d4c71c8e6f6acdb1ea41dd089b'
let API_KEY = DEFAULT_API_KEY
try {
  const saved = fs.readFileSync(KEY_FILE, 'utf8').trim()
  if (saved) API_KEY = saved
} catch {}

const FALLBACK_DOMAINS = ['nqmo.com', 'end.tw', 'uuf.me', '6n9.net', 'sugtbt.com', 'qabq.com']

class MailTd {
  constructor(baseUrl = 'https://api.mail.td', timeoutMs = 15000) {
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
      req.on('timeout', () => { req.destroy(new Error('Timeout Mail.td')) })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  _isErr(res) {
    return !res || (res.error && !res.domains && !res.messages && !res.id && !res.address)
  }

  async getDomains() {
    if (this._domains && this._domains.length) return this._domains
    try {
      const res = await this._req('GET', '/api/domains')
      const list = res && Array.isArray(res.domains) ? res.domains : []
      const ds = list.filter(d => d && d.domain && d.is_active !== false && !d.pro_only).map(d => d.domain)
      if (ds.length) { this._domains = ds; return ds }
    } catch {}
    return FALLBACK_DOMAINS
  }

  async createEmail(domain = null) {
    if (!domain) {
      try {
        const ds = await this.getDomains()
        if (Array.isArray(ds) && ds.length) domain = ds[Math.floor(Math.random() * ds.length)]
      } catch {}
    }
    const user = 'fb' + crypto.randomBytes(5).toString('hex') + Math.floor(Math.random() * 90 + 10)
    const address = `${user}@${domain || FALLBACK_DOMAINS[0]}`
    const password = crypto.randomBytes(12).toString('hex')
    // Rate limit tạo mailbox 1 lần/giây → 429 thì chờ 1.5s thử lại 1 lần
    let res = null
    for (let i = 0; i < 2; i++) {
      res = await this._req('POST', '/api/accounts', { address, password })
      if (!(res && res.error === 'rate_limit_exceeded')) break
      await new Promise(r => setTimeout(r, 1500))
    }
    if (!res || !res.address) {
      const msg = (res && (res.message || res.error)) || 'Không tạo được email từ mail.td'
      throw new Error(msg)
    }
    return { email: res.address, sidToken: res.address }
  }

  async getEmailList(sidToken, limit = 20) {
    const res = await this._req('GET', `/api/accounts/${encodeURIComponent(sidToken)}/messages?page=1`)
    if (res && res.error) throw new Error(res.message || res.error)
    const arr = res && Array.isArray(res.messages) ? res.messages : []
    return arr.slice(0, limit).map(e => ({
      mail_id: String(e.id || ''),
      id: e.id,
      mail_subject: e.subject || '',
      mail_from: e.sender || e.from || ''
    }))
  }

  async fetchEmail(sidToken, mailId) {
    const res = await this._req('GET', `/api/accounts/${encodeURIComponent(sidToken)}/messages/${encodeURIComponent(mailId)}`)
    if (res && res.error) throw new Error(res.message || res.error)
    const body = (res && (res.html_body || res.text_body)) || ''
    const subject = (res && res.subject) || ''
    return { ...res, mail_subject: subject, mail_body: body }
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
        if (/not_found|404/i.test(err.message)) return null
      }
      await new Promise(r => setTimeout(r, intervalMs))
    }
    return null
  }
}

module.exports = MailTd
module.exports.getApiKey = () => API_KEY
module.exports.setApiKey = (k) => {
  API_KEY = String(k || '').trim()
  try { if (API_KEY) fs.writeFileSync(KEY_FILE, API_KEY, 'utf8') } catch {}
}
