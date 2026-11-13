// Gmail OTP provider — Auto Reg FB v2
// Nguyên lý:
//  1 Gmail thật + App Password (16 ký tự) -> sinh VÔ SỐ địa chỉ variant
//    (plus: goicap14+fb8xk2p1@gmail.com | dot: goi.cap14@gmail.com | googlemail: ...@googlemail.com)
//  - Mọi thư đều về CÙNG 1 hộp. Lấy OTP qua IMAP imap.gmail.com:993 (thuần node:tls, 0 dependency)
//  - Đa luồng KHÔNG nhầm OTP: mỗi variant là duy nhất -> IMAP SEARCH TO "variant" FROM "facebookmail.com"
//    lọc đúng thư của đúng nick ngay trên server
//  - Connection pool: 1 connection IMAP / 1 tài khoản Gmail, command xếp hàng (Gmail giới hạn ~15 conn)
const tls = require('tls')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randStr(n) {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const all = letters + '0123456789'
  let s = letters[Math.floor(Math.random() * letters.length)]
  for (let i = 1; i < (n || 8); i++) s += all[Math.floor(Math.random() * all.length)]
  return s
}

// ── IMAP thuần qua TLS ─────────────────────────────────────────────
class ImapLite {
  constructor(user, pass) {
    this.user = user
    this.pass = pass
    this.tagN = 0
    this.buf = ''
    this.connected = false
    this.pending = null
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = tls.connect({ host: 'imap.gmail.com', port: 993, rejectUnauthorized: false }, () => {})
      this.sock.setEncoding('utf8')
      this.sock.on('data', d => { this.buf += d; this._tryResolve() })
      this.sock.on('error', () => { if (this.pending) { const p = this.pending; this.pending = null; p.reject(new Error('IMAP lỗi kết nối')) } })
      this.sock.on('close', () => {
        this.connected = false
        if (this.pending) { const p = this.pending; this.pending = null; p.reject(new Error('IMAP đóng kết nối')) }
      })
      // Chờ greeting "* OK Gimap ready..."
      const t0 = Date.now()
      const wait = () => {
        if (/^\* OK/m.test(this.buf)) { this.buf = ''; return resolve() }
        if (Date.now() - t0 > 15000) return reject(new Error('IMAP không chào được (timeout)'))
        setTimeout(wait, 200)
      }
      wait()
    })
  }

  _tryResolve() {
    if (this.pending && this.pending.check(this.buf)) {
      const p = this.pending
      this.pending = null
      p.resolve()
    }
  }

  async cmd(cmdLine, timeout = 25000) {
    if (!this.sock || this.sock.destroyed) throw new Error('IMAP chưa kết nối')
    this.tagN++
    const tag = 'A' + this.tagN
    const re = new RegExp('^' + tag + ' (OK|NO|BAD)', 'm')
    this.buf = ''
    this.pending = {
      check: b => re.test(b),
      resolve: () => {},
      reject: () => {}
    }
    const result = new Promise((resolve, reject) => {
      this.pending.resolve = () => { const b = this.buf; this.buf = ''; resolve(b) }
      this.pending.reject = reject
      setTimeout(() => {
        if (this.pending && this.pending.reject === reject) {
          this.pending = null
          reject(new Error('IMAP timeout: ' + cmdLine.substring(0, 40)))
        }
      }, timeout)
    })
    this.sock.write(tag + ' ' + cmdLine + '\r\n')
    const buf = await result
    const m = buf.match(re)
    if (!m || m[1] !== 'OK') {
      throw new Error('IMAP ' + (m ? m[1] : 'ERR') + ': ' + buf.replace(/\r?\n/g, ' ').substring(0, 180))
    }
    return buf
  }

  async login() {
    // App Password chỉ chữ+số — bọc ngoặc kép an toàn
    await this.cmd('LOGIN "' + this.user + '" "' + this.pass + '"')
    await this.cmd('SELECT INBOX')
    this.connected = true
  }

  // Thư chưa đọc gửi ĐÚNG variant này từ Facebook
  async searchTo(variant) {
    // KHÔNG dùng UNSEEN: user mở thư tay là Gmail đánh dấu đã đọc -> search miss vĩnh viễn.
    // Variant duy nhất từng nick nên mọi thư TO variant đều là của nick đó
    const buf = await this.cmd('SEARCH TO "' + variant + '" FROM "facebookmail.com"')
    const m = buf.match(/\* SEARCH ([^\r\n]*)/)
    return m ? m[1].trim().split(/\s+/).filter(x => /^\d+$/.test(x)) : []
  }

  async fetchText(uid) {
    const buf = await this.cmd('UID FETCH ' + uid + ' (BODY.PEEK[TEXT])', 30000)
    const lit = buf.match(/\{(\d+)\}\r\n/)
    if (lit) {
      const n = parseInt(lit[1], 10)
      const start = buf.indexOf(lit[0]) + lit[0].length
      return buf.substring(start, start + n)
    }
    return buf
  }

  // Lấy CẢ Subject + Body — subject FB chứa sẵn mã ("25210 is your Facebook confirmation code")
  async fetchHeaderAndText(uid) {
    const buf = await this.cmd('UID FETCH ' + uid + ' (BODY.PEEK[HEADER.FIELDS (SUBJECT)] BODY.PEEK[TEXT])', 30000)
    // Parse theo TÊN literal (Gmail đôi khi trả TEXT trước HEADER — không dựa thứ tự)
    let header = '', text = ''
    const hLit = buf.match(/BODY\[HEADER\.FIELDS \(SUBJECT\)\] \{(\d+)\}\r\n/)
    if (hLit) {
      const start = buf.indexOf(hLit[0]) + hLit[0].length
      header = buf.substring(start, start + parseInt(hLit[1], 10))
    }
    const tLit = buf.match(/BODY\[TEXT\] \{(\d+)\}\r\n/)
    if (tLit) {
      const start = buf.indexOf(tLit[0]) + tLit[0].length
      text = buf.substring(start, start + parseInt(tLit[1], 10))
    }
    if (!header && !text) {
      // Fallback: quét literal theo thứ tự
      const lits = []
      const re = /\{(\d+)\}\r\n/g
      let m
      while ((m = re.exec(buf)) !== null) {
        const n = parseInt(m[1], 10)
        const start = m.index + m[0].length
        lits.push(buf.substring(start, start + n))
        re.lastIndex = start + n
      }
      header = lits[0] || ''
      text = lits[1] || ''
    }
    return { header, text }
  }

  // Mốc UID hiện tại của hộp (để poll nhanh: chỉ FETCH thư UID mới hơn mốc — không dùng SEARCH index chậm)
  async statusUidNext() {
    const buf = await this.cmd('STATUS "INBOX" (UIDNEXT)', 15000)
    const m = buf.match(/UIDNEXT (\d+)/)
    return m ? parseInt(m[1], 10) : 0
  }

  // Lấy TO + Subject của mọi thư có UID > minUid (FETCH trực tiếp — REAL-TIME, không qua search index)
  async fetchHeadersSince(minUid) {
    const buf = await this.cmd('UID FETCH ' + (minUid + 1) + ':* (BODY.PEEK[HEADER.FIELDS (TO SUBJECT)])', 25000)
    const out = []
    const re = /BODY\[HEADER\.FIELDS \(TO SUBJECT\)\] \{(\d+)\}\r\n/g
    let m
    while ((m = re.exec(buf)) !== null) {
      const n = parseInt(m[1], 10)
      const start = m.index + m[0].length
      const raw = buf.substring(start, start + n)
      // UID nằm ngay TRƯỚC literal ("* 105 FETCH (UID 105 FLAGS ... BODY[HEADER...")
      const before = buf.substring(Math.max(0, m.index - 60), m.index)
      const um = before.match(/UID (\d+)/)
      const toM = raw.match(/To: ([^\r\n]*)/i)
      const suM = raw.match(/Subject: ([^\r\n]*)/i)
      out.push({
        uid: um ? parseInt(um[1], 10) : 0,
        to: toM ? toM[1].replace(/\s+/g, ' ').trim() : '',
        subject: suM ? suM[1].replace(/\s+/g, ' ').trim() : ''
      })
      re.lastIndex = start + n
    }
    return out.filter(x => x.uid && x.uid > minUid)
  }

  destroy() { this.connected = false; try { this.sock.destroy() } catch {} }
}

// Connection pool: 1 connection / 1 Gmail, command xếp hàng tuần tự
const _pool = new Map()  // key -> { chain, client }
function withImap(key, user, pass, fn) {
  if (!_pool.has(key)) _pool.set(key, { chain: Promise.resolve(), client: null })
  const entry = _pool.get(key)
  const run = entry.chain.then(async () => {
    if (!entry.client || !entry.client.connected) {
      const c = new ImapLite(user, pass)
      await c.connect()
      await c.login()
      entry.client = c
    }
    try {
      return await fn(entry.client)
    } catch (e) {
      entry.client.destroy()
      entry.client = null
      throw e
    }
  })
  entry.chain = run.catch(() => {})
  return run
}

// ── Decode MIME thô (FB email hay base64/quoted-printable/RFC2047) ──
function decodeMimeText(raw) {
  let out = raw || ''
  // RFC2047 ?B? / ?Q? trong Subject/Headers
  out = out.replace(/=\?[^?]+\?[Bb]\?([A-Za-z0-9+/=]+)\?=/g, (m, b) => {
    try { return Buffer.from(b, 'base64').toString('utf8') } catch { return m }
  })
  out = out.replace(/=\?[^?]+\?[Qq]\?(.*?)\?=/g, (m, q) => {
    try {
      const qp = q.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16)))
      return Buffer.from(qp, 'binary').toString('utf8')
    } catch { return m }
  })
  // Block base64 dài >= 40 ký tự (body FB thường encode base64; đoạn ngắn cũng phải bắt)
  const runs = out.match(/[A-Za-z0-9+/=\r\n]{40,}/g) || []
  for (const b of runs) {
    try { out += ' ' + Buffer.from(b.replace(/\s+/g, ''), 'base64').toString('utf8') } catch {}
  }
  // Quoted-printable =XX
  out = out.replace(/=([0-9A-Fa-f]{2})/g, (m, h) => {
    const c = parseInt(h, 16)
    return (c >= 32 && c < 127) || c === 10 || c === 13 ? String.fromCharCode(c) : m
  })
  return out
}

// Lọc số rác của HTML email (style, màu hex, padding, font-size...) — nguyên nhân điền nhầm OTP 05050
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

// Subject FB LUÔN bắt đầu bằng mã — lấy token số 4-8 chữ số đầu tiên (bao cả 5/6/8 số)
function extractCodeFromSubject(subject) {
  if (!subject) return null
  const m = subject.replace(/\s+/g, ' ').match(/\b(\d{4,8})\b/)
  return m ? m[1] : null
}

// Bóc mã FB trong body: "317 806" (3+3), keyword gần mã 6/8 số, 6 số, 5 số
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

// ── Provider chính (interface giống TempMailAPI) ──
class GmailProvider {
  // accounts: [{ gmail: 'goicap14@gmail.com', appPass: 'abcd efgh ijkl mnop' }]
  constructor(accounts) {
    this.accounts = (accounts || []).filter(a => a && a.gmail && a.appPass)
    this.variantMode = 'plus'
    this._rr = 0
  }

  _pick() {
    if (!this.accounts.length) throw new Error('Chưa có Gmail nào — nhập Gmail + App Password vào tab Reg v2')
    const a = this.accounts[this._rr % this.accounts.length]
    this._rr++
    return a
  }

  // Sinh variant từ base gmail — mode: 'plus' | 'dot' | 'gmx' | 'all'
  makeVariant(base, mode) {
    const at = base.indexOf('@')
    const local = base.substring(0, at)
    const domain = base.substring(at + 1)  // gmail.com hoặc googlemail.com
    let m = mode
    if (m === 'all') {
      this._modeCycle = ((this._modeCycle || 0) + 1) % 3
      m = ['plus', 'dot', 'gmx'][this._modeCycle]
    }
    if (m === 'dot' && local.replace(/\./g, '').length >= 6) {
      // chèn 1-2 dấu chấm vào vị trí ngẫu nhiên (không đầu/cuối/kề nhau)
      const clean = local.replace(/\./g, '')
      const nDots = 1 + Math.floor(Math.random() * Math.min(2, clean.length - 2))
      const positions = new Set()
      while (positions.size < nDots) positions.add(2 + Math.floor(Math.random() * (clean.length - 2)))
      const posList = [...positions].sort((a, b) => b - a)
      let dotted = clean
      for (const p of posList) dotted = dotted.substring(0, p) + '.' + dotted.substring(p)
      return dotted + '@' + domain
    }
    if (m === 'gmx') return local + '+' + randStr(8) + '@googlemail.com'
    return local + '+' + randStr(8) + '@' + domain  // plus mặc định
  }

  async createEmail() {
    const acc = this._pick()
    const variant = this.makeVariant(acc.gmail, this.variantMode)
    // sidToken gói đủ thông tin để poll OTP sau này (base + app password + variant)
    // Đánh dấu mốc UID NGAY LÚC TẠO EMAIL (FB chưa biết địa chỉ -> chưa có thư nào tới variant này)
    // poll sau này chỉ FETCH thư UID > mốc => lấy OTP REAL-TIME, không chờ Gmail search index
    try {
      const c = await this._connectFor(acc)
      this._maxUid = await c.statusUidNext() - 1
    } catch { this._maxUid = 0 }
    return { email: variant, sidToken: JSON.stringify({ b: acc.gmail, p: acc.appPass, v: variant }) }
  }

  _connectFor(acc) {
    return withImap(acc.gmail, acc.gmail, acc.appPass, c => c)
  }

  async getEmailList() { return [] }
  async fetchEmail() { return null }

  extractOtp(subject, body, length) { return extractFbCode(body || subject || '') }

  async pollForOtp(sidToken, existingMailIds = new Set(), maxAttempts = 25, intervalMs = 6000, logCallback = () => {}) {
    let info
    try { info = JSON.parse(sidToken) } catch { throw new Error('Gmail sidToken không đọc được') }
    this._seenUids = this._seenUids || new Set()
    // Fallback: mỗi 10 lần quét lại bằng SEARCH (bắt trường hợp mail về trước khi tạo email)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logCallback(`[gmail] Chờ OTP cho ${info.v} (lần ${attempt}/${maxAttempts})...`)
      try {
        let matched = null
        // ── CÁCH CHÍNH: FETCH trực tiếp thư UID > mốc — REAL-TIME, không chờ search index ──
        const msgs = await withImap(info.b, info.b, info.p, c => c.fetchHeadersSince(this._maxUid || 0))
        const fresh = msgs.slice().reverse() // mới nhất trước
        for (const msg of fresh) {
          if (this._seenUids.has(msg.uid)) continue
          if (msg.to.toLowerCase().indexOf(info.v.toLowerCase()) === -1) {
            this._seenUids.add(msg.uid)  // thư của nick khác — bỏ luôn
            continue
          }
          matched = msg
          break
        }
        // ── Fallback SEARCH mỗi 10 lần (phòng trực tiếp fetch hụt) ──
        if (!matched && attempt % 10 === 0) {
          const uids = await withImap(info.b, info.b, info.p, c => c.searchTo(info.v))
          const cand = uids.slice(-3).reverse().find(uid => !this._seenUids.has(uid))
          if (cand) matched = { uid: parseInt(cand, 10), to: info.v, subject: '' }
        }
        if (matched) {
          const { header, text } = await withImap(info.b, info.b, info.p, c => c.fetchHeaderAndText(matched.uid))
          const subject = (matched.subject ? decodeMimeText(matched.subject) : decodeMimeText(header)).replace(/\s+/g, ' ').trim()
          // 1) Subject chứa sẵn mã — LUÔN bắt đầu bằng mã (5/6/8 số): "41936482 is your Facebook code"
          let otp = extractCodeFromSubject(subject) || extractFbCode(subject)
          if (otp) {
            this._seenUids.add(matched.uid)
            logCallback(`[gmail] OTP (subject "${subject.substring(0, 60)}"): ${otp}`)
            return { otp, subject, mailId: matched.uid }
          }
          // 2) Body đã lọc sạch style/CSS/màu
          const cleaned = stripHtmlNoise(decodeMimeText(text))
          otp = extractFbCode(cleaned)
          this._seenUids.add(matched.uid)
          if (otp) {
            logCallback(`[gmail] OTP (từ body): ${otp}`)
            return { otp, subject, mailId: matched.uid }
          }
          logCallback(`[gmail] Có thư nhưng chưa bóc được mã — chờ thư mới...`)
        }
      } catch (err) {
        logCallback(`[gmail] Lỗi: ${err.message}`)
      }
      if (attempt < maxAttempts) await sleep(intervalMs)
    }
    return null
  }
}

module.exports = GmailProvider
module.exports.ImapLite = ImapLite
module.exports.extractCodeFromSubject = extractCodeFromSubject
module.exports.extractFbCode = extractFbCode
module.exports.decodeMimeText = decodeMimeText
