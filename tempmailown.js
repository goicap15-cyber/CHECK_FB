// Temp Mail Owner client — https://mail.genblackmmoonline.online/api/v1 (mail server tự xây, catch-all)
// Đặc điểm:
//  - CATCH-ALL: mọi địa chỉ *@khangvitoro.store / *@genblackmmoonline.online đều hợp lệ,
//    KHÔNG cần gọi API tạo mailbox -> createEmail() instant, chạy 100 luồng song song tự do
//  - GET /api/v1/mailbox?address=... -> {messages:[{id, from, subject, preview, otp, ...}]}
//    otp đã được bóc sẵn phía server (4-8 số gần từ khóa code/OTP/verify)
//  - GET /api/v1/message/{id}?mailbox=... -> chi tiết {subject, body:{text,html}}
//  - Không cần auth. Giới hạn 300 request/phút/IP. Thư tự xóa sau 24h.
// Interface tương thích TempMailAPI: createEmail()->{email, sidToken}, getEmailList, fetchEmail, extractOtp, pollForOtp
const https = require('https')

const BASE_HOST = 'mail.genblackmmoonline.online'
const OWN_DOMAINS = ['khangvitoro.store', 'genblackmmoonline.online']

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randStr(n) {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const all = letters + '0123456789'
  let s = letters[Math.floor(Math.random() * letters.length)]
  for (let i = 1; i < (n || 10); i++) s += all[Math.floor(Math.random() * all.length)]
  return s
}

function httpReq(method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BASE_HOST,
      path: urlPath,
      method,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0' },
      timeout: 15000
    }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', c => { raw += c })
      res.on('end', () => { try { resolve({ s: res.statusCode, j: JSON.parse(raw) }) } catch { resolve({ s: res.statusCode, raw }) } })
    })
    req.on('timeout', () => req.destroy(new Error('Timeout mail server')))
    req.on('error', reject)
    req.end()
  })
}

class TempMailOwn {
  constructor() { this.domains = OWN_DOMAINS.slice() }

  // Catch-all: chỉ cần SINH địa chỉ — không gọi API, không rate limit, không xếp hàng
  async createEmail() {
    const domain = this.domains[Math.floor(Math.random() * this.domains.length)]
    const email = 'fb' + randStr(6) + randStr(4) + '@' + domain
    return { email, sidToken: email }
  }

  async getEmailList(sidToken, limit = 50) {
    const addr = encodeURIComponent(String(sidToken || '').trim())
    const r = await httpReq('GET', '/api/v1/mailbox?address=' + addr + '&page=1&page_size=' + Math.min(limit || 50, 100))
    if (r.s !== 200 || !r.j || !Array.isArray(r.j.messages)) return []
    return r.j.messages.map(e => ({
      mail_id: String(e.id != null ? e.id : ''),
      id: e.id,
      mail_subject: e.subject || '',
      mail_from: e.from || '',
      otp: e.otp || null,
      preview: e.preview || ''
    }))
  }

  async fetchEmail(sidToken, mailId) {
    const addr = encodeURIComponent(String(sidToken || '').trim())
    const r = await httpReq('GET', '/api/v1/message/' + encodeURIComponent(mailId) + '?mailbox=' + addr)
    if (r.s !== 200 || !r.j) return null
    const d = r.j
    const body = (d.body && (d.body.text || d.body.html)) || d.preview || ''
    return { ...d, mail_subject: d.subject || '', mail_body: body, otp: d.otp || null }
  }

  extractOtp(subject = '', bodyHtml = '', length = 5) {
    const subjMatches = subject.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`))
    if (subjMatches && subjMatches[1]) return subjMatches[1]
    const cleanText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const ctxRegex = new RegExp(`(?:code|mã|ma|xác|xac|nhận|nhan|fb|facebook|otp|verify)[^\\d]{0,35}(\\d{${length}})(?!\\d)`, 'i')
    const ctxMatch = cleanText.match(ctxRegex)
    if (ctxMatch && ctxMatch[1]) return ctxMatch[1]
    const fallbackMatches = cleanText.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`))
    return fallbackMatches ? fallbackMatches[1] : null
  }

  // Ưu tiên otp server bóc sẵn; thiếu thì fallback bóc client-side từ subject/preview/body
  async pollForOtp(sidToken, existingMailIds = new Set(), maxAttempts = 25, intervalMs = 6000, logCallback = () => {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logCallback(`[mail own] Chờ OTP lần ${attempt}/${maxAttempts}...`)
      try {
        const msgs = await this.getEmailList(sidToken, 20)
        const news = msgs.filter(m => !existingMailIds.has(String(m.mail_id || '')))
        if (news.length > 0) {
          const msg = news[0]
          logCallback(`[mail own] Email mới: ${msg.mail_subject}`)
          let body = msg.preview || ''
          try { const d = await this.fetchEmail(sidToken, msg.mail_id); if (d) body = d.mail_body || body } catch {}
          // ƯU TIÊN SUBJECT — nó luôn chứa mã ("703455 is your code to confirm this email address").
          // Server otp bóc SAI thực tế (trả 5 số 94025 thay 6 số 703455) -> chỉ dùng làm phương án cuối
          const subj = msg.mail_subject || ''
          // Subject FB LUÔN bắt đầu bằng mã — token 4-8 số đầu tiên (5/6/8 số đều ăn)
          const subjM = subj.replace(/s+/g, ' ').match(/(d{4,8})/)
          let otp = (subjM && subjM[1]) || null
              || this.extractOtp('', body, 8)          // mã 8 số trong body
              || this.extractOtp('', body, 6)          // mã 6 số trong body
              || (msg.otp && String(msg.otp).length >= 5 ? String(msg.otp) : null)  // server otp
              || this.extractOtp(subj, '', 5)          // subject 5 số
              || this.extractOtp('', body, 5)          // body 5 số
          if (otp) {
            logCallback(`[mail own] OTP: ${otp}`)
            return { otp, subject: msg.mail_subject, mailId: msg.mail_id }
          }
          existingMailIds.add(String(msg.mail_id || ''))
        }
      } catch (err) { logCallback(`[mail own] Lỗi: ${err.message}`) }
      if (attempt < maxAttempts) await sleep(intervalMs)
    }
    return null
  }
}

module.exports = TempMailOwn
