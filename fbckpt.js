// ==========================================
// GIẢI CHECKPOINT ENGINE v2 (m.facebook.com mobile)
// Nạp cookie -> mở m.facebook.com (UA mobile) -> checkpoint flow:
//   1. Continue (màn "locked tạm thời")
//   2. CAPTCHA số: chụp ảnh captcha trong trang -> OCR tesseract (digits) -> điền -> Continue
//      (OCR trượt thì bấm ảnh lấy captcha mới, tối đa 5 lần)
//   3. Upload ảnh xác minh: bấm "Tải hình ảnh lên hoặc chụp ảnh" -> nhét ảnh random
//      từ thư mục ảnh vào input[type=file] -> bấm "Gửi" -> chờ FB duyệt
//   4. Email OTP / 2FA / reset pass / save browser như bản trước
// Kết quả: SOLVED | PENDING_REVIEW (đã gửi ảnh, chờ duyệt — main hẹn 2h check lại)
//          | STILL_CHECKPOINT | DIE | ERROR
// ==========================================

const { BrowserWindow, session, screen, net } = require('electron')
const { parseAccountLine, totpFromSecret } = require('./fbnuoi.js')
const TempMailAPI = require('./tempmail.js')
const fs = require('fs')
const path = require('path')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// UA mobile (giống Auto Reg mobile) — checkpoint m.facebook render MContainer mobile
const UA_MOBILE = [
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; SM-A528B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
]

// Thư mục ảnh xác minh: jpg/png/jpeg — engine chọn random 1 ảnh/nick
function randomVerifyPhoto(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f))
    if (!files.length) return null
    const f = files[Math.floor(Math.random() * files.length)]
    const buf = fs.readFileSync(path.join(dir, f))
    return { name: path.basename(f), mime: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg', b64: buf.toString('base64') }
  } catch { return null }
}

// ── OCR captcha số (tesseract LSTM, traineddata local tessdata/) ──
let ocrWorkerP = null
async function getOcrWorker() {
  if (!ocrWorkerP) {
    const { createWorker } = require('tesseract.js')
    ocrWorkerP = createWorker('eng', 1, { langPath: path.join(__dirname, 'tessdata'), gzip: false })
      .then(async w => { await w.setParameters({ tessedit_char_whitelist: '0123456789' }); return w })
  }
  return ocrWorkerP
}
async function ocrDigits(pngBase64) {
  try {
    const w = await getOcrWorker()
    const { data } = await w.recognize(Buffer.from(pngBase64, 'base64'))
    const digits = String(data.text || '').replace(/\D/g, '')
    return { digits, conf: data.confidence || 0 }
  } catch (e) { return { digits: '', conf: 0, err: e.message } }
}

// ── AI đọc captcha (model vision qua OpenRouter — chính chính hơn tesseract nhiều
// với font captcha FB bị nét nguệch ngoạc đè chữ) ──
const AI_CONFIG_FILE = path.join(__dirname, 'captcha_ai.json')
let ckptStopAll = false   // main.js set true khi bấm Dừng -> hủy cả các lần gọi AI đang chờ
function loadAiConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'))
    if (c && c.key) return c
  } catch {}
  return { enabled: true, key: process.env.OPENROUTER_API_KEY || '', model: 'nvidia/nemotron-3.5-super-vl:free' }
}
try {
  if (!fs.existsSync(AI_CONFIG_FILE)) {
    fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify({
      enabled: true,
      key: process.env.OPENROUTER_API_KEY || '',
      model: 'nvidia/nemotron-3.5-super-vl:free',
      _ghiChu: 'AI đọc captcha qua OpenRouter. Đổi key/model tại đây nếu cần. enabled:false -> chỉ dùng tesseract.'
    }, null, 2), 'utf8')
  }
} catch {}

let aiLastCallAt = 0
// Track usage token mỗi lần gọi AI (nhìn thấy key sắp cạn/rate-limit ở đâu)
const AI_USAGE_FILE = path.join(__dirname, 'captcha_ai_usage.json')
function bumpAiUsage(usage) {
  try {
    let j = { totalCalls: 0, promptTokens: 0, completionTokens: 0, errors429: 0, byDay: {} }
    try { j = JSON.parse(fs.readFileSync(AI_USAGE_FILE, 'utf8')) || j } catch {}
    const day = new Date().toISOString().slice(0, 10)
    j.totalCalls = (j.totalCalls || 0) + 1
    j.promptTokens = (j.promptTokens || 0) + ((usage && usage.prompt_tokens) || 0)
    j.completionTokens = (j.completionTokens || 0) + ((usage && usage.completion_tokens) || 0)
    j.byDay = j.byDay || {}
    const d = j.byDay[day] || { calls: 0, prompt: 0, completion: 0, errors429: 0 }
    d.calls = (d.calls || 0) + 1
    d.prompt = (d.prompt || 0) + ((usage && usage.prompt_tokens) || 0)
    d.completion = (d.completion || 0) + ((usage && usage.completion_tokens) || 0)
    j.byDay[day] = d
    fs.writeFileSync(AI_USAGE_FILE, JSON.stringify(j), 'utf8')
  } catch {}
}
function bumpAi429() {
  try {
    let j = { totalCalls: 0, promptTokens: 0, completionTokens: 0, errors429: 0, byDay: {} }
    try { j = JSON.parse(fs.readFileSync(AI_USAGE_FILE, 'utf8')) || j } catch {}
    const day = new Date().toISOString().slice(0, 10)
    j.errors429 = (j.errors429 || 0) + 1
    j.byDay = j.byDay || {}
    const d = j.byDay[day] || { calls: 0, prompt: 0, completion: 0, errors429: 0 }
    d.errors429 = (d.errors429 || 0) + 1
    j.byDay[day] = d
    fs.writeFileSync(AI_USAGE_FILE, JSON.stringify(j), 'utf8')
  } catch {}
}
function getAiUsageSummary() {
  try { return JSON.parse(fs.readFileSync(AI_USAGE_FILE, 'utf8')) } catch { return null }
}
async function aiReadOnce(b64Png, log) {
  const cfg = loadAiConfig()
  if (!cfg || cfg.enabled === false || !cfg.key) return null
  // ví dụ số trong prompt random mỗi lần — chống model nháy lại ví dụ
  const ex = String(Math.floor(100000 + Math.random() * 900000))
  for (let t = 1; t <= 3; t++) {
    if (ckptStopAll) return null
    try {
      const waitMs = 1600 - (Date.now() - aiLastCallAt)
      if (waitMs > 0) await sleep(waitMs)
      aiLastCallAt = Date.now()
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), 45000)
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Authorization': `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model || 'nvidia/nemotron-3.5-super-vl:free',
          temperature: 0, max_tokens: 900,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: `Read the 6 digits in this Facebook captcha image (bold digits, ignore curved noise lines). Output format: DIGITS:${ex}` },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${b64Png}` } }
            ]
          }]
        })
      })
      clearTimeout(to)
      const j = await r.json().catch(() => ({}))
      if (j.usage) bumpAiUsage(j.usage)
      if (j.error) {
        if (String((j.error && j.error.code) || '') === '429') bumpAi429()
        log(`⚠ AI captcha lỗi API (lần ${t}/3): ${String((j.error && j.error.message) || 'lỗi').substring(0, 90)}`); await sleep(3500); continue
      }
      const m = j.choices && j.choices[0] && j.choices[0].message
      if (!m) { await sleep(3500); continue }
      const mm = `${m.content || ''} ${m.reasoning || ''}`
      const d = mm.match(/DIGITS:?\s*(\d{6})/)
      if (d && d[1] !== ex) return d[1]
      const d2 = mm.replace(/\D/g, '')
      if (d2.length === 6 && d2 !== ex) return d2
    } catch (e) { await sleep(3500) }
  }
  return null
}

// đọc 3 lần + bình chọn đa số từng vị trí (chống model lag/ảo ở vài chữ số)
async function aiSolveCaptcha(b64Png, log = () => {}) {
  const reads = []
  for (let k = 0; k < 3; k++) {
    if (ckptStopAll) return null
    const r = await aiReadOnce(b64Png, log)
    reads.push(r)
    if (r && reads.filter(x => x === r).length >= 2) return r
  }
  const valid = reads.filter(Boolean)
  if (!valid.length) return null
  let out = ''
  for (let p = 0; p < 6; p++) {
    const cnt = {}
    valid.forEach(rd => { cnt[rd[p]] = (cnt[rd[p]] || 0) + 1 })
    out += Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0]
  }
  return out
}

class FBCkptEngine {
  constructor({ showBrowser, slot, proxy, photoDir, onLog }) {
    this.showBrowser = showBrowser !== false
    this.slot = slot || 0
    this.proxy = proxy || ''
    this.photoDir = photoDir || ''
    this.onLog = onLog || (() => {})
    this.win = null
    this.isAborted = false
  }

  log(msg) { this.onLog(msg) }

  async js(wc, expr, to = 12000) {
    return Promise.race([
      wc.executeJavaScript(expr),
      sleep(to).then(() => { throw new Error('JS_TIMEOUT') })
    ]).catch(() => null)
  }

  abort() {
    this.isAborted = true
    if (this.win && !this.win.isDestroyed()) { try { this.win.destroy() } catch {} }
    this.win = null
  }

  parseFBCookies(raw) {
    if (!raw) return []
    return raw.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
      const idx = pair.indexOf('=')
      return { name: idx > -1 ? pair.substring(0, idx).trim() : pair.trim(), value: idx > -1 ? pair.slice(idx + 1).trim() : '' }
    }).filter(c => c.name && c.value)
  }

  async injectCookies(ses, pairs) {
    let ok = 0
    for (const c of pairs) {
      try {
        await ses.cookies.set({
          url: 'https://facebook.com/', name: c.name, value: c.value,
          domain: '.facebook.com', path: '/', secure: true, httpOnly: false,
          expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
        })
        ok++
      } catch (e) { this.log(`⚠ Cookie ${c.name}: ${e.message}`) }
    }
    return ok
  }

  async extractCookieString(ses) {
    try {
      const list = await ses.cookies.get({})
      const fb = list.filter(c => (c.domain || '').includes('facebook.com'))
      const prio = ['c_user', 'xs', 'datr', 'fr', 'sb']
      fb.sort((a, b) => {
        const ia = prio.indexOf(a.name), ib = prio.indexOf(b.name)
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      })
      return fb.map(c => `${c.name}=${c.value}`).join('; ')
    } catch { return '' }
  }

  async loadPage(wc, url, timeoutMs = 60000) {
    const started = Date.now()
    try { await Promise.race([wc.loadURL(url), sleep(timeoutMs)]) } catch {}
    while (Date.now() - started < timeoutMs) {
      if (this.isAborted) return false
      await sleep(1500)
      try {
        const ready = await this.js(wc, '(function(){return {u: location.href, len: (document.body && document.body.innerText || "").length}})()')
        if (ready && ready.u && !ready.u.startsWith('chrome-error:') && ready.len > 40) return true
      } catch {}
    }
    return false
  }

  async detectState(wc) {
    return await this.js(wc, `
      (function() {
        var path = location.pathname || '';
        var t = ((document.body && document.body.innerText) || '').toLowerCase();
        var two = document.getElementById('approvals_code') || document.querySelector('input[name="approvals_code"]') || document.querySelector('input[autocomplete="one-time-code"]');
        if (two && two.offsetWidth > 0) return { state: 'NEED_2FA' };
        if (document.querySelector('img[alt*="Captcha challenge" i], img[src*="/captcha/"]')) return { state: 'CAPTCHA' };
        if (path.indexOf('/checkpoint') === 0 || path.indexOf('/confirmidentity') === 0) return { state: 'CHECKPOINT', url: location.href };
        if (path.indexOf('/disabled') === 0 || path.indexOf('/suspended') === 0) return { state: 'DIE' };
        var up = Array.from(document.querySelectorAll('[aria-label]')).some(function(e){
          var a = (e.getAttribute('aria-label') || '').toLowerCase();
          return a.indexOf('tải hình ảnh lên') !== -1 || a.indexOf('upload a photo') !== -1 || a.indexOf('take a photo') !== -1;
        });
        if (up) return { state: 'PHOTO_UPLOAD' };
        var email = document.getElementById('email') || document.querySelector('input[name="email"]');
        var pass = document.getElementById('pass') || document.querySelector('input[name="pass"]');
        if (email && pass && email.offsetWidth > 0 && pass.offsetWidth > 0) return { state: 'LOGIN_FORM' };
        var feed = document.querySelector('div[role="feed"]') || document.querySelector('a[aria-label="Home"], a[aria-label="Trang chủ"]');
        if (feed) return { state: 'FEED' };
        if (t.indexOf('confirm your identity') !== -1 || t.indexOf('xác minh danh tính') !== -1
          || t.indexOf('verify your identity') !== -1 || t.indexOf('đang xem xét') !== -1
          || t.indexOf('under review') !== -1 || t.indexOf('we\\u2019ll review') !== -1 || t.indexOf("we'll review") !== -1) return { state: 'CHECKPOINT_TEXT' };
        if (t.length > 200) return { state: 'PAGE' };
        return { state: 'UNKNOWN', url: location.href };
      })()
    `)
  }

  // Điền ô input theo selector JS: click tâm + Ctrl+A + Backspace + insertText + verify
  async fillBySelector(wc, selectorJs, text) {
    const ok = await this.js(wc, `(function(){ var el = ${selectorJs}; if (!el || el.offsetWidth <= 0) return false; el.scrollIntoView({ block: 'center' }); var r = el.getBoundingClientRect(); window.__ckFill = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; return true; })()`)
    if (!ok) return false
    const pos = await this.js(wc, 'window.__ckFill')
    if (!pos) return false
    const wc2 = this.win ? this.win.webContents : wc
    wc2.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(70)
    wc2.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(150)
    wc2.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    wc2.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await sleep(40)
    wc2.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    wc2.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await sleep(40)
    try { await wc2.insertText(String(text)) } catch { return false }
    await sleep(300)
    return await this.js(wc, `(function(){ var el = ${selectorJs}; return !!el && el.value === ${JSON.stringify(String(text))}; })()`)
  }

  // Click nút theo text — hỗ trợ CẢ nút MContainer của m.facebook (div role=none chỉ chứa
  // span "Continue"/"Gửi" — không phải role=button): tìm phần tử lá có text khớp, bấm
  // chuột vật lý vào tâm để sự kiện bubble lên container bắt sự kiện
  async clickTextM(wc, texts, maxWaitMs = 15000) {
    const start = Date.now()
    while (Date.now() - start < maxWaitMs && !this.isAborted) {
      const pos = await this.js(wc, `(function(){
        var texts = ${JSON.stringify(texts.map(t => t.toLowerCase()))};
        function norm(s){ return (s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
        var all = document.querySelectorAll('button, [role="button"], div, span');
        var best = null;
        for (var i = 0; i < all.length; i++) {
          var e = all[i];
          if (e.offsetWidth <= 0 || e.offsetHeight <= 0) continue;
          var t = norm(e.innerText || e.textContent);
          if (!t || t.length > 40) continue;
          var hit = false;
          for (var j = 0; j < texts.length; j++) if (t === texts[j]) { hit = true; break; }
          if (!hit) continue;
          // lá (không có con cùng text) + nhỏ nhất -> bấm đúng nút không dính container
          var leaf = !Array.from(e.children).some(function(c){ return norm(c.innerText) === t; });
          if (!leaf) continue;
          var r = e.getBoundingClientRect();
          var s = r.width * r.height;
          if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
        }
        if (!best) return null;
        return { x: best.x, y: best.y };
      })()`)
      if (pos) {
        const wc2 = this.win ? this.win.webContents : wc
        wc2.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
        await sleep(80)
        wc2.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
        return true
      }
      await sleep(800)
    }
    return false
  }

  // ── Điền mã captcha vào ô nhập (2 cách: gõ vật lý + DOM native setter cho React) ──
  async fillCaptchaInput(wc, digits) {
    digits = String(digits).replace(/\D/g, '')
    const FIND_JS = `(function(){
      var bad = ['submit','button','checkbox','radio','file','hidden','image'];
      var ins = Array.from(document.querySelectorAll('input')).filter(function(i){
        if (bad.indexOf(i.type) !== -1) return false;
        var r = i.getBoundingClientRect();
        return r.width > 20 && r.height > 10;
      });
      var pri = ins.filter(function(i){
        var l = ((i.getAttribute('aria-label')||'') + ' ' + (i.placeholder||'') + ' ' + (i.id||'')).toLowerCase();
        return /mã|code|xác nhận|confirm|captcha|otp|_r_/.test(l);
      });
      var el = pri[0] || ins[0];
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), id: el.id || '', type: el.type || 'text', label: el.getAttribute('aria-label') || '' };
    })()`
    const found = await this.js(wc, FIND_JS)
    if (!found) {
      const diag = await this.js(wc, `(function(){
        return Array.from(document.querySelectorAll('input')).slice(0, 8).map(function(i){
          var r = i.getBoundingClientRect();
          return (i.type||'?') + '/' + (i.id||'?') + '/' + Math.round(r.width) + 'x' + Math.round(r.height);
        }).join(', ') || 'KHÔNG CÓ INPUT NÀO';
      })()`)
      this.log(`⚠ Không thấy ô nhập mã trên trang (inputs: ${diag})`)
      return false
    }
    this.log(`🖊 Ô nhập: type=${found.type}${found.id ? ' #' + found.id : ''}${found.label ? ` "${found.label}"` : ''}`)
    const wc2 = this.win ? this.win.webContents : wc
    // Cách 1: click + Ctrl+A + Backspace + gõ vật lý
    wc2.sendInputEvent({ type: 'mouseDown', x: found.x, y: found.y, button: 'left', clickCount: 1 })
    await sleep(70)
    wc2.sendInputEvent({ type: 'mouseUp', x: found.x, y: found.y, button: 'left', clickCount: 1 })
    await sleep(250)
    wc2.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    wc2.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await sleep(40)
    wc2.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    wc2.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await sleep(40)
    try { await wc2.insertText(digits) } catch {}
    await sleep(450)
    let ok = await this.js(wc, `(function(){
      var bad = ['submit','button','checkbox','radio','file','hidden','image'];
      return Array.from(document.querySelectorAll('input')).some(function(i){
        if (bad.indexOf(i.type) !== -1) return false;
        return (i.value || '').replace(/\\D/g, '') === '${digits}';
      });
    })()`)
    if (ok) { this.log('✅ Đã điền mã captcha (gõ vật lý)'); return true }
    // Cách 2: DOM native setter + sự kiện input/change (input do React điều khiển)
    ok = await this.js(wc, `(function(){
      var bad = ['submit','button','checkbox','radio','file','hidden','image'];
      var ins = Array.from(document.querySelectorAll('input')).filter(function(i){
        if (bad.indexOf(i.type) !== -1) return false;
        var r = i.getBoundingClientRect();
        return r.width > 20 && r.height > 10;
      });
      var pri = ins.filter(function(i){
        var l = ((i.getAttribute('aria-label')||'') + ' ' + (i.placeholder||'') + ' ' + (i.id||'')).toLowerCase();
        return /mã|code|xác nhận|confirm|captcha|otp|_r_/.test(l);
      });
      var el = pri[0] || ins[0];
      if (!el) return false;
      try { el.focus(); } catch (e) {}
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '${digits}');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return (el.value || '') === '${digits}';
    })()`)
    if (ok) { this.log('✅ Đã điền mã captcha (DOM setter)'); return true }
    this.log('⚠ Điền mã 2 cách đều không ăn — thử captcha khác...')
    return false
  }

  // Tải bytes ảnh captcha qua net (Node) kèm cookie của phiên — dùng khi canvas trong
  // trang bị chặn SecurityError (ảnh nằm domain cross-origin fbcdn -> canvas tainted)
  async fetchCaptchaBytes(url) {
    const doFetch = (opts) => new Promise((resolve) => {
      try {
        const req = net.request(opts)
        const chunks = []
        req.on('response', (res) => {
          res.on('data', c => chunks.push(c))
          res.on('end', () => {
            const buf = Buffer.concat(chunks)
            if (!buf || buf.length < 200) return resolve(null)
            let mime = 'image/png'
            if (buf[0] === 0xFF && buf[1] === 0xD8) mime = 'image/jpeg'
            else if (buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) mime = 'image/webp'
            else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif'
            resolve({ b64: buf.toString('base64'), mime })
          })
        })
        req.on('error', () => resolve(null))
        req.end()
      } catch { resolve(null) }
    })
    const headers = { 'Referer': 'https://m.facebook.com/', 'Accept': 'image/png,image/jpeg,image/*;q=0.8' }
    if (this.win && !this.win.isDestroyed()) {
      const r = await doFetch({ url, useSessionCookies: true, session: this.win.webContents.session, headers })
      if (r) return r
    }
    return doFetch({ url, useSessionCookies: true, headers })
  }

  // Vẽ 1 ảnh (data-URI) vào canvas trang: phóng to 3x + nhị phân hoá -> b64 PNG.
  // Data-URI không bị coi là cross-origin nên canvas luôn vẽ được.
  binarizeInPage(wc, srcJsExpr) {
    return this.js(wc, `(function(){
      return new Promise(function(done){
        var img = new Image();
        img.onload = function(){
          try {
            if (!img.naturalWidth) return done({ err: 'KICH_THUOC_0' });
            var scale = 3;
            var c = document.createElement('canvas');
            c.width = img.naturalWidth * scale; c.height = img.naturalHeight * scale;
            var ctx = c.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(img, 0, 0, c.width, c.height);
            var d = ctx.getImageData(0, 0, c.width, c.height);
            var px = d.data, sum = 0, n = 0;
            for (var i = 0; i < px.length; i += 4) { sum += (px[i] + px[i+1] + px[i+2]) / 3; n++; }
            var avg = sum / n;
            for (var i = 0; i < px.length; i += 4) {
              var v = ((px[i] + px[i+1] + px[i+2]) / 3) < avg ? 0 : 255;
              px[i] = px[i+1] = px[i+2] = v; px[i+3] = 255;
            }
            ctx.putImageData(d, 0, 0);
            done(c.toDataURL('image/png').split(',')[1]);
          } catch (e) { done({ err: String(e && e.name || e) }) }
        };
        img.onerror = function(){ done({ err: 'IMG_DECODE_LOI' }) };
        img.src = ${srcJsExpr};
      });
    })()`, 25000)
  }

  // ── BƯỚC CAPTCHA: lấy ảnh captcha (3 đường: canvas trực tiếp / fetch trong trang /
  // Node tải kèm cookie) -> phóng to + nhị phân -> OCR số -> điền -> Continue ──
  async solveCaptcha(wc) {
    for (let tryN = 1; tryN <= 5 && !this.isAborted; tryN++) {
      await sleep(1500)
      // Thông tin ảnh captcha (src đầy đủ — dùng cho các đường tải fallback)
      const info = await this.js(wc, `(function(){
        var img = document.querySelector('img[alt*="Captcha challenge" i]') || document.querySelector('img[src*="/captcha/"]');
        if (!img) return null;
        try { img.scrollIntoView({ block: 'center' }); } catch (e) {}
        return { src: String(img.src || ''), w: img.naturalWidth, h: img.naturalHeight };
      })()`)
      if (!info || !info.src) { this.log('⚠ Không thấy ảnh captcha trên trang — chờ thử lại...'); continue }
      if (tryN === 1 || !info.w) this.log(`🖼 Captcha ${info.w || '?'}×${info.h || '?'}: ${info.src.substring(0, 70)}`)

      let b64 = null
      // Đường 1: vẽ trực tiếp ảnh trong trang vào canvas (chỉ được khi same-origin/data-URI)
      const direct = await this.js(wc, `(function(){
        try {
          var img = document.querySelector('img[alt*="Captcha challenge" i]') || document.querySelector('img[src*="/captcha/"]');
          if (!img || !img.naturalWidth) return null;
          var scale = 3;
          var c = document.createElement('canvas');
          c.width = img.naturalWidth * scale; c.height = img.naturalHeight * scale;
          var ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(img, 0, 0, c.width, c.height);
          var d = ctx.getImageData(0, 0, c.width, c.height);
          var px = d.data, sum = 0, n = 0;
          for (var i = 0; i < px.length; i += 4) { sum += (px[i] + px[i+1] + px[i+2]) / 3; n++; }
          var avg = sum / n;
          for (var i = 0; i < px.length; i += 4) {
            var v = ((px[i] + px[i+1] + px[i+2]) / 3) < avg ? 0 : 255;
            px[i] = px[i+1] = px[i+2] = v; px[i+3] = 255;
          }
          ctx.putImageData(d, 0, 0);
          return c.toDataURL('image/png').split(',')[1];
        } catch (e) { return { err: String(e && e.name || e) } }
      })()`, 20000)
      if (direct && typeof direct === 'string' && direct.length > 100) b64 = direct
      else if (direct && direct.err) this.log(`⚠ Canvas trang lỗi (${direct.err}) — thử đường khác...`)

      // Đường 2: fetch chính src trong trang -> data-URI (được với blob:/same-origin)
      let rawB64 = null   // ảnh GỐC (chưa xử lý) cho AI đọc — AI đọc ảnh gốc tốt hơn ảnh nhị phân
      if (!b64) {
        const inPage = await this.js(wc, `(function(){
          return fetch(${JSON.stringify(info.src)}).then(function(r){ return r.blob(); }).then(function(b){
            return new Promise(function(done){ var fr = new FileReader(); fr.onload = function(){ done(String(fr.result)); }; fr.onerror = function(){ done(null); }; fr.readAsDataURL(b); });
          }).catch(function(){ return null; });
        })()`, 20000)
        if (inPage && inPage.startsWith('data:image')) {
          rawB64 = inPage.split(',')[1]
          const pr = await this.binarizeInPage(wc, JSON.stringify(inPage))
          if (pr && typeof pr === 'string' && pr.length > 100) { b64 = pr; this.log('✅ Lấy ảnh captcha qua fetch trong trang') }
          else if (pr && pr.err) this.log(`⚠ Xử lý ảnh fetch lỗi (${pr.err})`)
        }
      }

      // Đường 3: Node tải bytes kèm cookie phiên -> data-URI -> vẽ (cross-origin fbcdn)
      if (!b64 && /^https?:/i.test(info.src)) {
        const dl = await this.fetchCaptchaBytes(info.src)
        if (dl) {
          rawB64 = dl.b64
          const pr = await this.binarizeInPage(wc, JSON.stringify(`data:${dl.mime};base64,${dl.b64}`))
          if (pr && typeof pr === 'string' && pr.length > 100) { b64 = pr; this.log('✅ Lấy ảnh captcha qua Node (kèm cookie phiên)') }
          else if (pr && pr.err) this.log(`⚠ Xử lý ảnh tải từ Node lỗi (${pr.err})`)
        } else this.log('⚠ Node tải ảnh captcha lỗi — thử lại...')
      }

      if (!b64) { this.log('⚠ Vẫn chưa lấy được ảnh captcha — chờ thử lại...'); continue }
      // Canvas trực tiếp ăn (same-origin) nhưng chưa có ảnh gốc -> tải raw 1 lần cho AI
      if (!rawB64 && /^https?:/i.test(info.src)) {
        const dl = await this.fetchCaptchaBytes(info.src)
        if (dl) rawB64 = dl.b64
      }
      // Lưu ảnh captcha đã xử lý ra captcha_debug/ (tune OCR + xem captcha thật của FB)
      try {
        const dbgDir = path.join(__dirname, 'captcha_debug')
        fs.mkdirSync(dbgDir, { recursive: true })
        fs.writeFileSync(path.join(dbgDir, `captcha_${Date.now()}_try${tryN}.png`), Buffer.from(b64, 'base64'))
      } catch {}

      // 1) ƯU TIÊN: AI vision đọc captcha (3 lần + bình chọn) — chính hơn tesseract với captcha FB
      let digits = ''
      if (rawB64) {
        const t0 = Date.now()
        digits = (await aiSolveCaptcha(rawB64, m => this.log(m))) || ''
        if (digits) this.log(`🤖 AI đọc captcha lần ${tryN}/5: "${digits}" (${Math.round((Date.now() - t0) / 1000)}s)`)
        else this.log('⚠ AI không đọc được — dùng tesseract dự phòng...')
      }
      // 2) Dự phòng: tesseract trên ảnh đã nhị phân hoá
      if (!digits) {
        const r = await ocrDigits(b64)
        if (r.digits && r.digits.length >= 3 && r.digits.length <= 8 && r.conf >= 50) {
          digits = r.digits
          this.log(`🤖 OCR tesseract lần ${tryN}/5: "${digits}" (độ tin cậy ${Math.round(r.conf)}%)`)
        }
      }

      if (digits) {
        // Điền mã vào ô nhập (2 cách: gõ vật lý + DOM setter cho React)
        const okFill = await this.fillCaptchaInput(wc, digits)
        if (okFill) {
          await this.clickTextM(wc, ['continue', 'tiếp tục', 'submit', 'gửi', 'ok'], 8000)
          // dự phòng: phím Enter nếu nút Continue không bấm được
          const wcE = this.win ? this.win.webContents : wc
          wcE.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          await sleep(70)
          wcE.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
          await sleep(5000)
          // Sau khi submit: captcha biến mất = ăn; còn hiện = trượt
          const still = await this.js(wc, '!!document.querySelector(\'img[alt*="Captcha challenge" i], img[src*="/captcha/"]\')')
          if (!still) { this.log('✅ Captcha đã qua'); return true }
          this.log('⚠ Captcha bị từ chối — bấm ảnh lấy captcha mới...')
        }
      }
      // Bấm vào ảnh captcha để lấy challenge mới rồi thử lại
      await this.js(wc, `(function(){ var img = document.querySelector('img[alt*="Captcha challenge" i]') || document.querySelector('img[src*="/captcha/"]'); if (img) { var r = img.getBoundingClientRect(); window.__capPos = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; return true; } return false; })()`)
      const cp = await this.js(wc, 'window.__capPos')
      if (cp && this.win) {
        this.win.webContents.sendInputEvent({ type: 'mouseDown', x: cp.x, y: cp.y, button: 'left', clickCount: 1 })
        await sleep(70)
        this.win.webContents.sendInputEvent({ type: 'mouseUp', x: cp.x, y: cp.y, button: 'left', clickCount: 1 })
        await sleep(2500)
      }
    }
    return false
  }

  // ── BƯỚC UPLOAD ẢNH XÁC MINH: bấm "Tải hình ảnh lên..." → nhét ảnh random vào input file → Gửi ──
  async uploadVerifyPhoto(wc) {
    if (!this.photoDir) { this.log('⚠ Chưa cấu hình thư mục ảnh xác minh — không upload được'); return false }
    const photo = randomVerifyPhoto(this.photoDir)
    if (!photo) { this.log(`⚠ Thư mục ${this.photoDir} không có ảnh jpg/png`); return false }

    // Bấm nút "Tải hình ảnh lên hoặc chụp ảnh" (aria-label)
    const clicked = await this.js(wc, `(function(){
      var els = Array.from(document.querySelectorAll('[aria-label]'));
      for (var i = 0; i < els.length; i++) {
        var a = (els[i].getAttribute('aria-label') || '').toLowerCase();
        if (a.indexOf('tải hình ảnh lên') !== -1 || a.indexOf('upload a photo') !== -1) {
          var r = els[i].getBoundingClientRect();
          window.__upBtn = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          return true;
        }
      }
      return false;
    })()`)
    if (clicked && this.win) {
      const p = await this.js(wc, 'window.__upBtn')
      if (p) {
        this.win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
        await sleep(80)
        this.win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      }
    }
    // Chờ input[type=file] xuất hiện sau khi bấm
    let hasInput = false
    for (let t = 0; t < 10 && !hasInput; t++) {
      await sleep(1000)
      hasInput = await this.js(wc, '!!document.querySelector(\'input[type="file"]\')')
    }
    if (!hasInput) { this.log('⚠ Không thấy input chọn file sau khi bấm upload'); return false }

    // Nhét ảnh vào input[type=file] qua DataTransfer (File từ base64) + dispatch change
    const injected = await this.js(wc, `(function(){
      var inp = document.querySelector('input[type="file"]');
      if (!inp) return false;
      var b64 = ${JSON.stringify(photo.b64)};
      var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      var file = new File([bytes], ${JSON.stringify(photo.name)}, { type: ${JSON.stringify(photo.mime)} });
      var dt = new DataTransfer();
      dt.items.add(file);
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, 20000)
    if (!injected) { this.log('⚠ Không nhét được ảnh vào input file'); return false }
    this.log(`🖼️ Đã nạp ảnh xác minh random: ${photo.name}`)

    // Chờ FB nhận ảnh rồi bấm "Gửi"
    await sleep(4000)
    const sent = await this.clickTextM(wc, ['gửi', 'submit', 'send', 'tiếp tục', 'continue'], 20000)
    if (!sent) { this.log('⚠ Không thấy nút Gửi sau khi nạp ảnh'); return false }
    this.log('📤 Đã bấm Gửi ảnh — chờ FB xác nhận...')
    await sleep(6000)
    return true
  }

  async pollEmailOtp(email, maxWaitMs = 180000) {
    const tm = new TempMailAPI()
    const start = Date.now()
    let logged = false
    while (Date.now() - start < maxWaitMs && !this.isAborted) {
      try {
        const otp = await tm.pollForOtp(email, new Set(), 1, 1, () => {})
        if (otp && otp.otp) return otp.otp
      } catch {}
      if (!logged) { this.log(`📬 Đang chờ mã FB gửi về ${email}...`); logged = true }
      await sleep(7000)
    }
    return ''
  }

  // Mở phiên nhanh chỉ để CHECK trạng thái (recheck sau 2h): feed = đã giải, checkpoint = die
  async quickCheck(account, { showBrowser } = {}) {
    const acc = { uid: account.uid || '', email: account.email || '', pass: account.pass || '', twofa: account.twofa || '', cookie: account.cookie || '' }
    const ses = session.fromPartition(`fbckpt_rc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    if (this.proxy && this.proxy.trim()) { try { await ses.setProxy({ mode: 'fixed_servers', proxyRules: this.proxy.trim() }) } catch {} }
    ses.setUserAgent(UA_MOBILE[0])
    const win = new BrowserWindow({
      width: 430, height: 830, show: showBrowser === true,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false, backgroundThrottling: false }
    })
    this.win = win
    const wc = win.webContents
    try {
      const pairs = this.parseFBCookies(acc.cookie)
      await this.injectCookies(ses, pairs)
      if (!await this.loadPage(wc, 'https://m.facebook.com/', 60000)) {
        return { status: 'ERROR', uid: acc.uid, error: 'Recheck: không tải được m.facebook (proxy?)' }
      }
      await sleep(3000)
      const st = await this.detectState(wc)
      const freshCookie = await this.extractCookieString(ses)
      if (!st) return { status: 'ERROR', uid: acc.uid, error: 'Recheck: không đọc được DOM' }
      if (st.state === 'FEED' || st.state === 'PAGE') return { status: 'SOLVED', uid: acc.uid, cookie: freshCookie }
      if (st.state === 'CHECKPOINT' || st.state === 'CHECKPOINT_TEXT' || st.state === 'CAPTCHA' || st.state === 'PHOTO_UPLOAD') {
        return { status: 'STILL_CHECKPOINT', uid: acc.uid, cookie: freshCookie, error: 'Vẫn checkpoint sau thời gian chờ' }
      }
      if (st.state === 'LOGIN_FORM') return { status: 'DIE', uid: acc.uid, error: 'Recheck: bị đá về login (cookie chết)' }
      if (st.state === 'DIE') return { status: 'DIE', uid: acc.uid, error: 'Tài khoản bị khóa' }
      return { status: 'STILL_CHECKPOINT', uid: acc.uid, cookie: freshCookie, error: 'Recheck: trạng thái ' + st.state }
    } finally {
      try { if (!win.isDestroyed()) win.destroy() } catch {}
      this.win = null
      try { await Promise.race([ses.clearStorageData(), sleep(5000)]) } catch {}
    }
  }

  _makeWindow(ses, label) {
    const winPos = {}
    let winW = 430, winH = 830
    if (this.showBrowser) {
      try {
        const wa = screen.getPrimaryDisplay().workArea
        const cols = Math.max(1, Math.floor(wa.width / winW))
        const rows = Math.max(1, Math.floor(wa.height / winH))
        const cells = cols * rows
        const s = this.slot % cells
        winPos.x = wa.x + (s % cols) * winW
        winPos.y = wa.y + Math.floor(s / cols) * winH
        if (this.slot >= cells) { winPos.x += (this.slot - cells + 1) * 28; winPos.y += (this.slot - cells + 1) * 28 }
      } catch {}
    }
    return new BrowserWindow({
      width: winW, height: winH, show: Boolean(this.showBrowser), ...winPos,
      title: `Giải Checkpoint - ${label}`,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false, backgroundThrottling: false }
    })
  }

  async run(account) {
    const acc = {
      uid: account.uid || '', email: account.email || '', pass: account.pass || '',
      twofa: account.twofa || '', cookie: account.cookie || ''
    }
    const label = acc.uid || acc.email || '(cookie trần)'
    this.log(`🔓 Bắt đầu giải checkpoint ${label} (m.facebook mobile)`)

    const ses = session.fromPartition(`fbckpt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`)
    if (this.proxy && this.proxy.trim()) {
      try {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: this.proxy.trim() })
        this.log(`🌐 Proxy áp dụng: ${this.proxy.trim()}`)
      } catch (pe) { this.log(`⚠ Proxy lỗi: ${pe.message}`) }
    }
    ses.setUserAgent(UA_MOBILE[Math.floor(Math.random() * UA_MOBILE.length)])

    const win = this._makeWindow(ses, label)
    this.win = win
    const wc = win.webContents
    const cleanup = async () => {
      try { if (!win.isDestroyed()) win.destroy() } catch {}
      this.win = null
      try { await Promise.race([ses.clearStorageData(), sleep(5000)]) } catch {}
    }

    try {
      const pairs = this.parseFBCookies(acc.cookie)
      if (!pairs.length) {
        await cleanup()
        return { success: false, status: 'ERROR', uid: acc.uid, error: 'Dòng không có cookie để nạp' }
      }
      const ok = await this.injectCookies(ses, pairs)
      this.log(`🍪 Đã nạp ${ok}/${pairs.length} cookie`)

      this.log('⏳ Mở m.facebook.com kiểm tra trạng thái...')
      if (!await this.loadPage(wc, 'https://m.facebook.com/', 60000)) {
        await cleanup()
        return { success: false, status: 'ERROR', uid: acc.uid, error: 'Không tải được Facebook (proxy chết?)', proxyFail: true }
      }

      let st = await this.detectState(wc)
      this.log(`🔍 Trạng thái: ${st ? st.state : 'không đọc được DOM'}`)
      if (!st) { await cleanup(); return { success: false, status: 'ERROR', uid: acc.uid, error: 'Không đọc được DOM trang Facebook' } }
      if (st.state !== 'CHECKPOINT' && st.state !== 'CHECKPOINT_TEXT' && st.state !== 'NEED_2FA'
        && st.state !== 'CAPTCHA' && st.state !== 'PHOTO_UPLOAD') {
        await cleanup()
        if (st.state === 'FEED' || st.state === 'PAGE') {
          this.log('ℹ Nick KHÔNG checkpoint (vào thẳng feed) - không cần giải')
          return { success: true, status: 'NO_CKPT', uid: acc.uid, cookie: await this.extractCookieString(ses) }
        }
        return { success: false, status: st.state === 'DIE' ? 'DIE' : 'ERROR', uid: acc.uid, error: 'Trạng thái: ' + st.state }
      }

      // ── Vòng giải: tối đa 8 bước ──
      let steps = 0
      let solved = false
      let pending = false
      let lastReason = 'checkpoint'
      while (steps < 8 && !this.isAborted) {
        steps++
        st = await this.detectState(wc)
        if (!st) { await sleep(3000); continue }

        if (st.state === 'FEED' || st.state === 'PAGE') { solved = true; break }
        if (st.state === 'DIE' || st.state === 'LOGIN_FORM') {
          lastReason = st.state === 'DIE' ? 'Tài khoản bị khóa (disabled)' : 'Bị đá về trang đăng nhập'
          break
        }

        // Màn captcha số
        if (st.state === 'CAPTCHA') {
          this.log('🤖 Màn CAPTCHA — OCR số...')
          const okCap = await this.solveCaptcha(wc)
          if (!okCap) { lastReason = 'Không giải được captcha (OCR trượt 5 lần)'; break }
          await sleep(4000)
          continue
        }

        // Màn upload ảnh xác minh
        if (st.state === 'PHOTO_UPLOAD') {
          this.log('🖼️ Màn upload ảnh xác minh...')
          const okUp = await this.uploadVerifyPhoto(wc)
          if (!okUp) { lastReason = 'Không upload được ảnh xác minh'; break }
          // Sau Gửi: FB thường báo "đang xem xét" -> chờ duyệt, hẹn recheck 2h
          const t = await this.js(wc, '((document.body && document.body.innerText) || "").toLowerCase()')
          if (t && (t.indexOf('đang xem xét') !== -1 || t.indexOf('under review') !== -1 || t.indexOf("we'll review") !== -1 || t.indexOf('we\u2019ll review') !== -1 || t.indexOf('review your') !== -1)) {
            pending = true
          } else {
            // Có thể chuyển tiếp màn khác — cho vòng lặp xử lý tiếp
            pending = true
          }
          break
        }

        // Màn nhập mã 2FA
        if (st.state === 'NEED_2FA') {
          if (!acc.twofa) { lastReason = 'Checkpoint hỏi mã 2FA nhưng dòng không có key 2FA'; break }
          let code = ''
          try { code = totpFromSecret(acc.twofa) } catch (e) { lastReason = 'Key 2FA không sinh được mã: ' + e.message; break }
          this.log(`🔐 Điền mã 2FA TOTP: ${code}`)
          if (!await this.fillBySelector(wc, "document.getElementById('approvals_code') || document.querySelector('input[name=\"approvals_code\"]') || document.querySelector('input[autocomplete=\"one-time-code\"]')", code)) {
            lastReason = 'Không điền được ô mã 2FA'; break
          }
          await this.clickTextM(wc, ['continue', 'tiếp tục', 'submit', 'gửi', 'ok'])
          await sleep(6000)
          continue
        }

        // Màn nhập mã email
        const hasCodeInput = await this.js(wc, `(function(){
          var ins = Array.from(document.querySelectorAll('input')).filter(function(i){ return i.offsetWidth > 0 && i.type !== 'hidden'; });
          var meta = ins.some(function(i){
            var m = ((i.name || '') + ' ' + (i.id || '') + ' ' + (i.getAttribute('aria-label') || '') + ' ' + (i.placeholder || '')).toLowerCase();
            return m.indexOf('code') !== -1 || m.indexOf('mã') !== -1 || m.indexOf('confirmation') !== -1;
          });
          var t = ((document.body && document.body.innerText) || '').toLowerCase();
          var textHit = t.indexOf('enter the code') !== -1 || t.indexOf('we sent a code') !== -1
            || t.indexOf('nhập mã') !== -1 || t.indexOf('chúng tôi đã gửi mã') !== -1;
          return (meta || textHit) && ins.length > 0;
        })()`)
        if (hasCodeInput && acc.email) {
          this.log('📧 Checkpoint hỏi mã gửi về email — chờ FB gửi rồi đọc OTP...')
          const otp = await this.pollEmailOtp(acc.email, 180000)
          if (!otp) { lastReason = 'Không nhận được mã OTP qua email trong 3 phút'; break }
          this.log(`🔑 Nhận mã email: ${otp} — điền vào...`)
          if (!await this.fillBySelector(wc, "(function(){ var ins = Array.from(document.querySelectorAll('input')).filter(function(i){ return i.offsetWidth>0 && i.type!=='hidden' && i.type!=='password'; }); return ins[0]; })()", otp)) {
            lastReason = 'Không điền được ô mã'; break
          }
          await this.clickTextM(wc, ['continue', 'tiếp tục', 'submit', 'gửi', 'xác nhận', 'confirm'])
          await sleep(6000)
          continue
        }

        // Màn đổi mật khẩu
        const passCount = await this.js(wc, `(function(){ return Array.from(document.querySelectorAll('input[type="password"]')).filter(function(i){ return i.offsetWidth > 0; }).length; })()`)
        if (passCount >= 1 && acc.pass) {
          this.log('🔑 Màn đặt lại mật khẩu — điền lại mật khẩu cũ...')
          const ok1 = await this.fillBySelector(wc, "(function(){ var ins = Array.from(document.querySelectorAll('input[type=\"password\"]')).filter(function(i){ return i.offsetWidth>0; }); return ins[0]; })()", acc.pass)
          let ok2 = true
          if (passCount >= 2) ok2 = await this.fillBySelector(wc, "(function(){ var ins = Array.from(document.querySelectorAll('input[type=\"password\"]')).filter(function(i){ return i.offsetWidth>0; }); return ins[1] || ins[0]; })()", acc.pass)
          if (!ok1 || !ok2) { lastReason = 'Không điền được ô mật khẩu'; break }
          await this.clickTextM(wc, ['continue', 'tiếp tục', 'submit', 'save', 'lưu', 'gửi'])
          await sleep(6000)
          continue
        }

        // Màn lưu trình duyệt / Continue đơn giản (nút MContainer mobile)
        const t2 = await this.js(wc, '((document.body && document.body.innerText) || "").toLowerCase()')
        if (t2 && (t2.indexOf('save this browser') !== -1 || t2.indexOf('lưu trình duyệt') !== -1 || t2.indexOf('continue') !== -1 || t2.indexOf('tiếp tục') !== -1)) {
          const c = await this.clickTextM(wc, ['continue', 'tiếp tục', 'ok', 'lưu', 'save'], 8000)
          if (c) { this.log('👉 Bấm Continue...'); await sleep(5000); continue }
        }

        // Màn chọn phương thức xác minh qua email
        const chose = await this.js(wc, `(function(){
          var els = Array.from(document.querySelectorAll('[role="button"], button, label, div[role="radio"], a'));
          var best = null;
          for (var i = 0; i < els.length; i++) {
            var e = els[i];
            if (e.offsetWidth <= 0) continue;
            var t = ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim();
            if (!t || t.length > 160) continue;
            var hasMail = /@/.test(t);
            var codeMail = /code.{0,20}email|email.{0,20}code|nhận mã.{0,20}(email|thư)/i.test(t);
            if (hasMail || codeMail) { var r = e.getBoundingClientRect(); var s = r.width * r.height; if (!best || s < best.s) best = { el: e, s: s, t: t.substring(0, 80) }; }
          }
          if (best) { best.el.scrollIntoView({ block: 'center' }); best.el.click(); return best.t; }
          return null;
        })()`)
        if (chose) {
          this.log(`👉 Chọn phương thức xác minh: "${chose}"`)
          await sleep(4000)
          continue
        }

        lastReason = 'Màn checkpoint không nhận diện được'
        if (steps === 1) {
          const dump = await this.js(wc, '((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").substring(0, 200)')
          if (dump) this.log(`🔍 Nội dung checkpoint: "${dump}"`)
        }
        await this.clickTextM(wc, ['continue', 'tiếp tục', 'ok', 'submit'], 6000)
        await sleep(4000)
      }

      const freshCookie = await this.extractCookieString(ses)
      await cleanup()
      if (solved) {
        this.log(`✅ ĐÃ GIẢI CHECKPOINT ${label}`)
        return { success: true, status: 'SOLVED', uid: acc.uid, cookie: freshCookie }
      }
      if (pending) {
        this.log(`⏳ Đã gửi ảnh xác minh ${label} — FB đang xem xét, hẹn 2 tiếng sau check lại`)
        return { success: true, status: 'PENDING_REVIEW', uid: acc.uid, cookie: freshCookie, recheckAt: Date.now() + 2 * 60 * 60 * 1000 }
      }
      this.log(`❌ Không giải được ${label}: ${lastReason}`)
      return { success: false, status: 'STILL_CHECKPOINT', uid: acc.uid, error: lastReason, cookie: freshCookie }
    } catch (e) {
      await cleanup()
      return { success: false, status: 'ERROR', uid: acc.uid, error: 'Lỗi engine: ' + (e && e.message) }
    }
  }
}

module.exports = { FBCkptEngine, parseAccountLine, setCkptStopAll: v => { ckptStopAll = !!v }, loadAiConfig, getAiUsageSummary }
