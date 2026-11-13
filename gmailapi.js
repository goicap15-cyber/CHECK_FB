// Gmail API (OAuth REST) client — Auto Reg FB v2
// Lấy OTP qua Gmail API v1 (gmail.googleapis.com) — search REALTIME (cùng backend Gmail web, không lag như IMAP)
// Auth: refresh_token (OAuth) -> access_token (hết hạn 1h, tự refresh)
//  - Cần file gmailapi_client.txt cạnh app, dòng đầu: client_id|client_secret (OAuth Client ID dạng Desktop)
//  - Input từng nick: gmail|refresh_token
// Interface giống TempMailAPI: createEmail() -> {email, sidToken}, pollForOtp(...)
const https = require('https')
const fs = require('fs')
const path = require('path')

const CLIENT_FILE = path.join(__dirname, 'gmailapi_client.txt')
const API_HOST = 'gmail.googleapis.com'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randStr(n) {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const all = letters + '0123456789'
  let s = letters[Math.floor(Math.random() * letters.length)]
  for (let i = 1; i < (n || 8); i++) s += all[Math.floor(Math.random() * all.length)]
  return s
}

function getClient() {
  try {
    const line = fs.readFileSync(CLIENT_FILE, 'utf8').trim().split(/\r?\n/)[0] || ''
    const [id, secret] = line.split('|').map(x => x.trim())
    if (id && secret) return { id, secret }
  } catch {}
  return null
}

function httpReq(method, host, urlPath, bodyStr, headers) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128' }, headers || {})
    if (bodyStr) { h['Content-Type'] = h['Content-Type'] || 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(bodyStr) }
    const req = https.request({ hostname: host, path: urlPath, method, headers: h, timeout: 20000 }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', c => { raw += c })
      res.on('end', () => { try { resolve({ s: res.statusCode, j: JSON.parse(raw) }) } catch { resolve({ s: res.statusCode, raw }) } })
    })
    req.on('timeout', () => req.destroy(new Error('Timeout Gmail API')))
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// ── Access token cache (mỗi refresh token 1 token, hạn 1h — refresh lại trước 55 phút) ──
const _tokens = new Map()
async function accessToken(refreshToken) {
  const cached = _tokens.get(refreshToken)
  if (cached && Date.now() < cached.exp) return cached.token
  const client = getClient()
  if (!client) throw new Error('Thiếu gmailapi_client.txt cạnh app — dòng: client_id|client_secret')
  const body = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  }).toString()
  const r = await httpReq('POST', 'oauth2.googleapis.com', '/token', body, { 'Content-Type': 'application/x-www-form-urlencoded' })
  if (!r.j || !r.j.access_token) {
    throw new Error('Refresh token lỗi: ' + ((r.j && (r.j.error_description || r.j.error)) || ('HTTP ' + r.s)))
  }
  _tokens.set(refreshToken, { token: r.j.access_token, exp: Date.now() + 50 * 60 * 1000 })
  return r.j.access_token
}

// Bóc text từ payload Gmail API (base64url, đệ quy multipart)
function extractText(payload) {
  let out = ''
  if (!payload) return out
  if (payload.mimeType && payload.mimeType.indexOf('text/') === 0 && payload.body && payload.body.data) {
    try { out += Buffer.from(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') + ' ' } catch {}
  }
  for (const p of (payload.parts || [])) out += extractText(p)
  return out
}

// Subject FB LUÔN bắt đầu bằng mã — token số 4-8 chữ số đầu tiên (5/6/8 số đều ăn)
function extractCodeFromSubject(subject) {
  if (!subject) return null
  const m = subject.replace(/\s+/g, ' ').match(/\b(\d{4,8})\b/)
  return m ? m[1] : null
}

// Lọc số rác HTML (style/màu/px) — dùng chung logic với gmailotp
function stripHtmlNoise(text) {
  let t = text || ''
  t = t.replace(/--[A-Za-z0-9]+/g, ' ')
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  t = t.replace(/<[^>]+>/g, ' ')
  t = t.replace(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g, ' ')
  t = t.replace(/\b(?:font-size|letter-spacing|padding|margin|width|height|line-height|opacity|min-width|max-width|border-radius|top|left|right|bottom|z-index|font-weight)\s*[:=]\s*[^;\s"'<>]{1,15}/gi, ' ')
  t = t.replace(/\b\d+(?:\.\d+)?px\b/gi, ' ')
  t = t.replace(/\b[0-9a-f]{20,}\b/gi, ' ')
  t = t.replace(/Content-(Type|Transfer-Encoding|Disposition|ID)[^;]{0,80}/gi, ' ')
  return t
}

function extractFbCode(text) {
  if (!text) return null
  let t = stripHtmlNoise(text).replace(/\s+/g, ' ')
  const m6 = t.match(/\b(\d{3})[ \-](\d{3})\b/)
  if (m6) return m6[1] + m6[2]
  const m8 = t.match(/\b(\d{4})[ \-](\d{4})\b/)
  if (m8) return m8[1] + m8[2]
  const kw8 = t.match(/(?:code|mã|ma|xác nhận|xac nhan|confirm|verify|facebook)[^0-9]{0,40}(\d{8})(?!\d)/i)
  if (kw8) return kw8[1]
  const kw = t.match(/(?:code|mã|ma|xác nhận|xac nhan|confirm|verify|facebook)[^0-9]{0,40}(\d{6})(?!\d)/i)
  if (kw) return kw[1]
  const s6 = t.match(/(?<!\d)(\d{6})(?!\d)/)
  if (s6) return s6[1]
  const s5 = t.match(/(?:code|mã|ma|confirm|verify|facebook)[^0-9]{0,40}(\d{5})(?!\d)/i)
  if (s5) return s5[1]
  const f5 = t.match(/(?<!\d)(\d{5})(?!\d)/)
  return f5 ? f5[1] : null
}

// Sinh variant gmail (plus/dot/googlemail/luân phiên) — dùng chung cho cả cookie flow
function makeGmailVariant(base, mode, holder) {
  const at = base.indexOf('@')
  const local = base.substring(0, at)
  const domain = base.substring(at + 1)
  let m = mode
  if (m === 'all') {
    holder._modeCycle = ((holder._modeCycle || 0) + 1) % 3
    m = ['plus', 'dot', 'gmx'][holder._modeCycle]
  }
  if (m === 'dot' && local.replace(/./g, '').length >= 6) {
    const clean = local.replace(/./g, '')
    const nDots = 1 + Math.floor(Math.random() * Math.min(2, clean.length - 2))
    const positions = new Set()
    while (positions.size < nDots) positions.add(2 + Math.floor(Math.random() * (clean.length - 2)))
    const posList = [...positions].sort((a, b) => b - a)
    let dotted = clean
    for (const p of posList) dotted = dotted.substring(0, p) + '.' + dotted.substring(p)
    return dotted + '@' + domain
  }
  if (m === 'gmx') return local + '+' + randStr(8) + '@googlemail.com'
  return local + '+' + randStr(8) + '@' + domain
}

class GmailApiProvider {
  // accounts: [{ gmail: 'nangamy4@gmail.com', refreshToken: '1//0g...' }]
  constructor(accounts) {
    this.accounts = (accounts || []).filter(a => a && a.gmail && a.refreshToken)
    this.variantMode = 'plus'
    this._rr = 0
  }

  _pick() {
    if (!this.accounts.length) throw new Error('Chưa có Gmail nào — nhập Gmail | Refresh token vào tab Reg v2')
    const a = this.accounts[this._rr % this.accounts.length]
    this._rr++
    return a
  }

  makeVariant(base, mode) {
    return makeGmailVariant(base, mode, this)
  }

  async createEmail() {
    const acc = this._pick()
    const variant = this.makeVariant(acc.gmail, this.variantMode)
    return { email: variant, sidToken: JSON.stringify({ r: acc.refreshToken, v: variant }) }
  }

  async getEmailList() { return [] }
  async fetchEmail() { return null }
  extractOtp(subject, body) { return extractCodeFromSubject(subject) || extractFbCode(body) }

  async pollForOtp(sidToken, existingMailIds = new Set(), maxAttempts = 45, intervalMs = 6000, logCallback = () => {}) {
    let info
    try { info = JSON.parse(sidToken) } catch { throw new Error('Gmail sidToken không đọc được') }
    this._seen = this._seen || new Set()
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logCallback(`[gmail-api] Chờ OTP cho ${info.v} (lần ${attempt}/${maxAttempts})...`)
      try {
        const tok = await accessToken(info.r)
        const q = encodeURIComponent(`from:facebookmail.com to:"${info.v}"`)
        const list = await httpReq('GET', API_HOST, '/gmail/v1/users/me/messages?maxResults=5&q=' + q, null, { Authorization: 'Bearer ' + tok })
        if (list.s === 401) throw new Error('Access token hết hạn/không hợp lệ')
        const msgs = (list.j && list.j.messages) || []
        for (const msg of msgs) {
          if (this._seen.has(msg.id)) continue
          const meta = await httpReq('GET', API_HOST, `/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=To`, null, { Authorization: 'Bearer ' + tok })
          if (meta.s !== 200 || !meta.j || !meta.j.payload) { this._seen.add(msg.id); continue }
          const headers = meta.j.payload.headers || []
          const subject = (headers.find(h => h.name === 'Subject') || {}).value || ''
          const to = ((headers.find(h => h.name === 'To') || {}).value || '')
          if (to.toLowerCase().indexOf(info.v.toLowerCase()) === -1) { this._seen.add(msg.id); continue }
          // 1) Subject chứa sẵn mã — mọi độ dài 5/6/8 số
          let otp = extractCodeFromSubject(subject)
          if (otp) {
            this._seen.add(msg.id)
            logCallback(`[gmail-api] OTP (subject "${subject.substring(0, 60)}"): ${otp}`)
            return { otp, subject, mailId: msg.id }
          }
          // 2) Body decode base64url
          const full = await httpReq('GET', API_HOST, `/gmail/v1/users/me/messages/${msg.id}?format=full`, null, { Authorization: 'Bearer ' + tok })
          if (full.s === 200 && full.j && full.j.payload) {
            const text = extractText(full.j.payload)
            otp = extractFbCode(text)
            this._seen.add(msg.id)
            if (otp) {
              logCallback(`[gmail-api] OTP (từ body): ${otp}`)
              return { otp, subject, mailId: msg.id }
            }
          }
          this._seen.add(msg.id)
        }
      } catch (err) {
        logCallback(`[gmail-api] Lỗi: ${err.message}`)
      }
      if (attempt < maxAttempts) await sleep(intervalMs)
    }
    return null
  }
}

module.exports = GmailApiProvider
module.exports.makeGmailVariant = makeGmailVariant
module.exports.extractFbCode = extractFbCode
module.exports.extractCodeFromSubject = extractCodeFromSubject
