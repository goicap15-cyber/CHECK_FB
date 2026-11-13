// ==========================================
// TempMailAPI Client for Node.js
// Base API: https://tempmailapi.io.vn/public_api.php
// Actions: domains | create | list | read | delete_mail
// Luật docs: luôn list trước -> lưu uid -> đọc bằng uid
//   (KHÔNG dùng lại id=1 khi có mail mới đến)
// ==========================================

const https = require('https')
const fs = require('fs')
const path = require('path')

// Key mặc định; có thể đổi runtime qua setApiKey() (lưu ra tempmail_key.txt cạnh file này)
const KEY_FILE = path.join(__dirname, 'tempmail_key.txt')
const DEFAULT_API_KEY = 'tm_48b38f7e8cb2147dd3e31635de41df169e01978ca1ae1beb'
let API_KEY = DEFAULT_API_KEY
try {
  const saved = fs.readFileSync(KEY_FILE, 'utf8').trim()
  if (saved) API_KEY = saved
} catch {}

const FALLBACK_DOMAINS = ['tempmailapi.io.vn', 'gamene.online', 'hust.edu.pl', 'apponi.site']

class TempMailAPI {
  constructor(baseUrl = 'https://tempmailapi.io.vn', timeoutMs = 15000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.endpoint = `${this.baseUrl}/public_api.php`
    this.timeoutMs = timeoutMs
  }

  _get(params = {}) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams({ api_key: API_KEY, ...params })
      const url = `${this.endpoint}?${qs.toString()}`
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        },
        timeout: this.timeoutMs
      }, (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { raw += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (err) {
            reject(new Error('Phản hồi không phải JSON: ' + raw.substring(0, 150)))
          }
        })
      })
      req.on('timeout', () => {
        req.destroy(new Error(`Timeout sau ${this.timeoutMs}ms kết nối tempmailapi.io.vn`))
      })
      req.on('error', err => reject(err))
    })
  }

  async getDomains() {
    try {
      const res = await this._get({ action: 'domains' })
      const list = Array.isArray(res) ? res : (res.domains || res.data || [])
      if (Array.isArray(list) && list.length > 0) {
        return list.map(d => typeof d === 'string' ? d : (d.domain || d.name || '')).filter(Boolean)
      }
    } catch (err) {
      console.warn('[TempMailAPI] getDomains lỗi, dùng domain mặc định:', err.message)
    }
    return FALLBACK_DOMAINS
  }

  // API này không có session token — mọi thao tác đều keyed theo email.
  // Giữ khớp interface cũ: sidToken = chính email đó (hòm thư), consumers khỏi đổi.
  async createEmail(domain = null) {
    const params = { action: 'create' }
    if (!domain) {
      // "Tự động chọn": phải tự random domain MỖI LẦN tạo. Bỏ trống domain thì server
      // luôn trả cùng một domain -> chạy 3 Chrome song song ra 3 nick cùng domain.
      try {
        const ds = await this.getDomains()
        if (Array.isArray(ds) && ds.length) domain = ds[Math.floor(Math.random() * ds.length)]
      } catch {}
    }
    if (domain) params.domain = domain
    const res = await this._get(params)
    const email = typeof res === 'string' ? res
      : (res.email || res.email_address || res.address || res.mail
        || (typeof res.data === 'string' ? res.data : (res.data && (res.data.email || res.data.email_address)))
        || '')
    if (!email) {
      const msg = (res && (res.msg || res.message || res.error)) || 'Không tạo được email từ tempmailapi.io.vn'
      throw new Error(msg)
    }
    return { email, sidToken: email }
  }

  async getEmailList(sidToken, limit = 20) {
    const res = await this._get({ action: 'list', email: sidToken, limit: String(limit) })
    const arr = Array.isArray(res) ? res : (res.emails || res.list || res.data || [])
    return (Array.isArray(arr) ? arr : []).map(e => ({
      mail_id: String(e.uid != null ? e.uid : (e.id != null ? e.id : '')),
      uid: e.uid,
      id: e.id,
      msgno: e.msgno,
      mail_subject: e.subject || e.mail_subject || '',
      mail_from: e.from || e.mail_from || ''
    }))
  }

  async fetchEmail(sidToken, mailId) {
    // Đọc bằng uid theo docs (uid ưu tiên; id/msgno chỉ là fallback)
    const res = await this._get({ action: 'read', email: sidToken, uid: String(mailId) })
    // Shape thật: {"success":true,"email":{id,uid,from,subject,body_html,...}}
    const src = (res && typeof res.email === 'object' && res.email !== null) ? res.email
      : (res && Array.isArray(res.emails) && res.emails[0]) ? res.emails[0]
      : (res && res.data && typeof res.data === 'object' ? res.data : (res || {}))
    const body = src.body || src.body_html || src.html || src.mail_body || src.content || src.text || ''
    const subject = src.subject || src.mail_subject || ''
    return { ...src, mail_subject: subject, mail_body: body }
  }

  /**
   * Trích xuất mã OTP từ tiêu đề hoặc nội dung email
   * Facebook OTP thường có 5 chữ số
   */
  extractOtp(subject = '', bodyHtml = '', length = 5) {
    // 1. Tìm trực tiếp trong tiêu đề email
    const subjMatches = subject.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`))
    if (subjMatches && subjMatches[1]) {
      return subjMatches[1]
    }

    // 2. Làm sạch nội dung HTML
    const cleanText = bodyHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    // 3. Tìm gần các từ khóa xác thực
    const ctxRegex = new RegExp(`(?:code|mã|ma|xác|xac|nhận|nhan|fb|facebook)[^\\d]{0,35}(\\d{${length}})(?!\\d)`, 'i')
    const ctxMatch = cleanText.match(ctxRegex)
    if (ctxMatch && ctxMatch[1]) {
      return ctxMatch[1]
    }

    // 4. Fallback: tìm chuỗi 5 số bất kỳ
    const fallbackMatches = cleanText.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`))
    if (fallbackMatches && fallbackMatches[1]) {
      return fallbackMatches[1]
    }

    return null
  }

  /**
   * Polling liên tục chờ email OTP từ Facebook
   * @param {string} sidToken (chính là địa chỉ email)
   * @param {Set<string>} Danh sách uid đã có từ trước để bỏ qua
   */
  async pollForOtp(sidToken, existingMailIds = new Set(), maxAttempts = 20, intervalMs = 8000, logCallback = () => {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logCallback(`Đang chờ email OTP từ Facebook (lần ${attempt}/${maxAttempts})...`)
      try {
        const emails = await this.getEmailList(sidToken)
        const newEmails = emails.filter(e => !existingMailIds.has(String(e.mail_id || '')))

        if (newEmails.length > 0) {
          const latestMail = newEmails[0]
          const mailId = latestMail.mail_id
          logCallback(`Phát hiện email mới: uid=${mailId}. Đang đọc nội dung...`)

          const detail = await this.fetchEmail(sidToken, mailId)
          const subject = detail.mail_subject || latestMail.mail_subject || ''
          const body = detail.mail_body || ''

          const otp = this.extractOtp(subject, body, 6) || this.extractOtp(subject, body, 5)
          if (otp) {
            logCallback(`Tìm thấy mã OTP Facebook: ${otp}`)
            return {
              otp,
              subject,
              mailId
            }
          } else {
            logCallback(`Đã nhận email "${subject}" nhưng chưa trích xuất được mã 5 số. Đang tiếp tục thử lại...`)
          }
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

module.exports = TempMailAPI
module.exports.getApiKey = () => API_KEY
module.exports.setApiKey = (k) => {
  API_KEY = String(k || '').trim()
  try { if (API_KEY) fs.writeFileSync(KEY_FILE, API_KEY, 'utf8') } catch {}
}
