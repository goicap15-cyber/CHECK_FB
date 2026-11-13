// ==========================================
// TempMail.id.vn Client for Node.js
// Base API: https://tempmail.id.vn/api
// Auth: Bearer token (Laravel Sanctum)
// POST /api/email/create  -> {success, data:{id, email}}
// GET  /api/email/{id}    -> {success, data:{items:[...]}}
// GET  /api/message/{id}  -> {success, data:{...}}
// mail_id (data.id khi tạo) = token poll hòm thư
// ==========================================

const https = require('https')
const fs = require('fs')
const path = require('path')

const KEY_FILE = path.join(__dirname, 'tempmailid_key.txt')
const DEFAULT_API_KEY = '16252|aTt52xGa7srummvOO3GspLFVqcuxT32DShiwG4y87373f1f9'
let API_KEY = DEFAULT_API_KEY
try {
  const saved = fs.readFileSync(KEY_FILE, 'utf8').trim()
  if (saved) API_KEY = saved
} catch {}

class TempMailId {
  constructor(baseUrl = 'https://tempmail.id.vn', timeoutMs = 15000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  _req(method, urlPath, bodyObj = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + urlPath)
      const payload = bodyObj ? JSON.stringify(bodyObj) : null
      const req = https.request(url, {
        method,
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Accept': 'application/json',
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          } : {})
        },
        timeout: this.timeoutMs
      }, (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { raw += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch {
            reject(new Error('Phản hồi không phải JSON: ' + raw.substring(0, 150)))
          }
        })
      })
      req.on('timeout', () => req.destroy(new Error(`Timeout sau ${this.timeoutMs}ms kết nối tempmail.id.vn`)))
      req.on('error', err => reject(err))
      if (payload) req.write(payload)
      req.end()
    })
  }

  _unwrap(res) {
    if (res && res.success === false) {
      throw new Error(res.message || res.error || 'API tempmail.id.vn trả về lỗi')
    }
    return res && res.data != null ? res.data : res
  }

  // Danh sách domain hệ thống đang có (GET /api/domain). Lưu ý: API luôn random
  // domain khi tạo mail (JSON/form/query đều bị ignore) -> list chỉ để hiển thị.
  async getDomains() {
    try {
      const res = await this._req('GET', '/api/domain')
      const data = this._unwrap(res)
      const arr = Array.isArray(data) ? data : []
      const list = arr.map(d => typeof d === 'string' ? d : (d.name || d.domain || '')).filter(Boolean)
      if (list.length) return list
    } catch {}
    return ['tempmail.id.vn']
  }

  // Interface cũ: {email, sidToken}. sidToken = mail_id của hòm thư.
  // tempmail.id.vn không có endpoint list domain -> luôn tạo random, bỏ qua domain.
  async createEmail(_domain = null) {
    const res = await this._req('POST', '/api/email/create', {})
    const data = this._unwrap(res)
    const email = data && data.email
    if (!email) throw new Error('Không tạo được email từ tempmail.id.vn')
    return { email, sidToken: String(data.id) }
  }

  async getEmailList(sidToken) {
    const res = await this._req('GET', `/api/email/${encodeURIComponent(sidToken)}`)
    const data = this._unwrap(res)
    const items = data && Array.isArray(data.items) ? data.items
      : Array.isArray(data) ? data : []
    return items.map(e => ({
      mail_id: String(e.id != null ? e.id : (e.message_id != null ? e.message_id : '')),
      mail_subject: e.subject || e.mail_subject || '',
      mail_from: e.from || e.mail_from || '',
      _raw: e
    }))
  }

  // mailItem = phần tử trả về từ getEmailList (dự phòng khi message endpoint thiếu subject)
  async fetchEmail(mailItem, mailId) {
    let src = {}
    try {
      const res = await this._req('GET', `/api/message/${encodeURIComponent(mailId)}`)
      const data = this._unwrap(res)
      if (data && typeof data === 'object') src = data
    } catch {}
    if (!src.subject && mailItem && mailItem._raw) src = { ...src, ...mailItem._raw }
    const body = src.body || src.body_html || src.body_text || src.html
      || src.content || src.text || src.mail_body || ''
    const subject = src.subject || src.mail_subject || ''
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
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logCallback(`Đang chờ email OTP từ Facebook (lần ${attempt}/${maxAttempts})...`)
      try {
        const emails = await this.getEmailList(sidToken)
        const newEmails = emails.filter(e => !existingMailIds.has(String(e.mail_id || '')))

        if (newEmails.length > 0) {
          const latestMail = newEmails[0]
          const mailId = latestMail.mail_id
          logCallback(`Phát hiện email mới: id=${mailId}. Đang đọc nội dung...`)

          const detail = await this.fetchEmail(latestMail._raw, mailId)
          const subject = detail.mail_subject || latestMail.mail_subject || ''
          const body = detail.mail_body || ''

          const otp = this.extractOtp(subject, body, 6) || this.extractOtp(subject, body, 5)
          if (otp) {
            logCallback(`Tìm thấy mã OTP Facebook: ${otp}`)
            return { otp, subject, mailId }
          }
          logCallback(`Đã nhận email "${subject}" nhưng chưa trích xuất được mã 5 số. Đang tiếp tục thử lại...`)
        }
      } catch (err) {
        logCallback(`Lỗi kiểm tra hòm thư: ${err.message}`)
      }

      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, intervalMs))
      }
    }
    return null
  }
}

module.exports = TempMailId
module.exports.getApiKey = () => API_KEY
module.exports.setApiKey = (k) => {
  API_KEY = String(k || '').trim()
  try { if (API_KEY) fs.writeFileSync(KEY_FILE, API_KEY, 'utf8') } catch {}
}
