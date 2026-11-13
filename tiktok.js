// Engine REG TIKTOK: nạp cookie FB -> facebook.com (xác nhận phiên) -> tiktok.com/login
// -> "Tiếp tục với Facebook" -> OAuth popup "Continue as X" -> chọn Tháng/Ngày/Năm
// -> nút "Tiếp" (data-e2e=next-button) -> "Bỏ qua" -> lấy cookie TikTok (sessionid)
const { BrowserWindow, session, screen } = require('electron')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const TIKTOK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

class TikTokEngine {
  constructor({ cookie, showBrowser, slot, onLog, proxy }) {
    this.cookie      = cookie
    this.showBrowser = showBrowser !== false
    this.slot        = slot || 0
    this.onLog       = onLog || (() => {})
    this.proxy       = proxy || ''
    this.win         = null
    this.popups      = []
    this.isAborted   = false
    this.fbName      = ''
    this.allowClose  = false
  }

  log(msg) { this.onLog(msg) }

  abort() {
    this.isAborted = true
    for (const p of this.popups) { try { if (!p.isDestroyed()) p.close() } catch {} }
    this.popups = []
    if (this.win && !this.win.isDestroyed()) { try { this.win.close() } catch {} }
    this.win = null
  }

  // Hỗ trợ cả 1 dòng "a=b; c=d" lẫn Netscape nhiều dòng (tab)
  parseFBCookies(raw) {
    const out = []
    if (!raw) return out
    if (raw.indexOf('\n') !== -1 && raw.indexOf('\t') !== -1) {
      for (let line of raw.split(/\r?\n/)) {
        line = line.trim()
        if (!line) continue
        if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
        if (line.startsWith('#')) continue
        const f = line.split('\t')
        if (f.length >= 7) {
          out.push({ domain: f[0], path: f[2] || '/', secure: f[3] === 'TRUE', httpOnly: false, name: f[5], value: f.slice(6).join('\t') })
        }
      }
      if (out.length) return out
    }
    return raw.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
      const idx = pair.indexOf('=')
      return { domain: '.facebook.com', path: '/', secure: true, httpOnly: false,
        name: idx > -1 ? pair.substring(0, idx).trim() : pair.trim(),
        value: idx > -1 ? pair.substring(idx + 1).trim() : '' }
    }).filter(c => c.name)
  }

  async injectCookies(ses, pairs) {
    for (const c of pairs) {
      let domain = (c.domain || '.facebook.com').trim()
      if (!domain.startsWith('.')) domain = '.' + domain
      try {
        await ses.cookies.set({
          url: 'https://' + domain.replace(/^\./, '') + '/',
          name: c.name, value: c.value,
          domain, path: c.path || '/',
          secure: c.secure !== false,
          httpOnly: !!c.httpOnly,
          expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
        })
      } catch (e) { this.log(`⚠ Cookie ${c.name}: ${e.message}`) }
    }
  }

  async clickAt(wc, x, y) {
    try {
      if (!wc || wc.isDestroyed()) return
      wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
      await sleep(80)
      if (!wc || wc.isDestroyed()) return
      wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
      await sleep(250)
    } catch {}
  }

  async run() {
    const pairs = this.parseFBCookies(this.cookie)
    if (!pairs.length) return { success: false, reason: 'Cookie không đọc được (định dạng lạ)' }
    const uidCookie = pairs.find(c => c.name === 'c_user')
    const uid = uidCookie ? uidCookie.value : ''

    const ses = session.fromPartition('persist:ttreg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8))
    ses.setUserAgent(TIKTOK_UA)

    if (this.proxy && this.proxy.trim()) {
      try {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: this.proxy.trim() })
        this.log(`🌐 Proxy áp dụng cho phiên này: ${this.proxy.trim()}`)
      } catch (pe) {
        this.log(`⚠ Proxy lỗi (${pe.message}) - chạy bằng IP máy thật`)
      }
    }

    this.log(`📥 Nạp ${pairs.length} cookie FB vào trình duyệt...`)
    await this.injectCookies(ses, pairs)

    // Cửa sổ cỡ điện thoại, xếp lưới theo slot (giống Auto Reg)
    const winPos = {}
    let winW = 412, winH = 860
    if (this.showBrowser) {
      try {
        const wa = screen.getPrimaryDisplay().workArea
        winW = Math.min(412, wa.width)
        winH = Math.min(860, wa.height)
        const cols = Math.max(1, Math.floor(wa.width / winW))
        const rows = Math.max(1, Math.floor(wa.height / winH))
        const cells = cols * rows
        const s = this.slot % cells
        winPos.x = wa.x + (s % cols) * winW
        winPos.y = wa.y + Math.floor(s / cols) * winH
      } catch {}
    }

    const win = new BrowserWindow({
      width: winW, height: winH, show: Boolean(this.showBrowser), ...winPos,
      title: 'Reg TikTok - ' + (uid || 'cookie'),
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false }
    })
    this.win = win
    const wc = win.webContents
    wc.setWindowOpenHandler(() => ({ action: 'allow' }))
    wc.on('did-create-window', (child) => {
      this.popups.push(child)
      this.log('🪟 Facebook mở popup OAuth')
    })
    // TikTok/FB gọi window.close() khi xong OAuth -> chặn để engine kịp lấy cookie
    win.on('close', (e) => {
      if (!this.allowClose && !this.isAborted) {
        e.preventDefault()
        this.log('🛡 Trang muốn đóng cửa sổ giữa chừng - chặn lại để chạy tiếp')
      }
    })

    const cleanup = async () => {
      this.allowClose = true
      for (const p of this.popups) { try { if (!p.isDestroyed()) p.destroy() } catch {} }
      this.popups = []
      try { if (!win.isDestroyed()) win.destroy() } catch {}
      try { await ses.clearStorageData() } catch {}
      try { await ses.clearCache() } catch {}
    }

    try {
      // ── Bước 1: Facebook xác nhận phiên ──
      this.log('🌐 Bước 1/5: Mở Facebook để nạp phiên đăng nhập...')
      await wc.loadURL('https://www.facebook.com/').catch(() => {})
      const fbOk = await this.waitFacebookLogin(wc, 25000)
      if (!fbOk) {
        await cleanup()
        return { success: false, uid, reason: 'Cookie FB chết hoặc không đăng nhập được Facebook' }
      }
      this.log(`✅ Facebook OK - phiên ${uid} đã nạp`)

      // ── Bước 2: TikTok login ──
      this.log('🌐 Bước 2/5: Mở trang đăng nhập TikTok...')
      await wc.loadURL('https://www.tiktok.com/login').catch(() => {})
      await sleep(3000)

      // ── Bước 3: Tiếp tục với Facebook ──
      this.log('🖱️ Bước 3/5: Bấm "Tiếp tục với Facebook"...')
      const started = await this.startFacebookOAuth(wc)
      if (!started) {
        await cleanup()
        return { success: false, uid, reason: 'Bấm "Tiếp tục với Facebook" không có phản hồi (không popup, không chuyển trang)' }
      }

      // ── Bước 4: OAuth popup Continue as ──
      this.log('🔐 Bước 4/5: Chờ popup Facebook - bấm "Continue as..."...')
      const oauth = await this.handleOAuth(wc, ses, 90000)
      if (!oauth.ok) {
        await cleanup()
        return { success: false, uid, reason: oauth.reason || 'OAuth Facebook không hoàn tất' }
      }

      // ── Bước 5: Ngày sinh + Tiếp + Bỏ qua ──
      this.log('🎂 Bước 5/5: Chọn ngày sinh -> Tiếp -> Bỏ qua...')
      const done = await this.finishTikTokFlow(wc, ses)
      if (!done) {
        const maybe = await this.getTikTokCookie(ses)
        if (!maybe) {
          await cleanup()
          return { success: false, uid, reason: 'Kẹt ở bước chọn ngày sinh / Tiếp / Bỏ qua' }
        }
      }

      const ttCookie = await this.getTikTokCookie(ses)
      if (!ttCookie) {
        await cleanup()
        return { success: false, uid, reason: 'Đăng nhập xong nhưng không lấy được cookie TikTok (sessionid)' }
      }
      this.log('✅ TikTok đăng nhập thành công!')
      await cleanup()
      return { success: true, status: 'OK', uid, fbName: this.fbName, ttCookie }
    } catch (err) {
      await cleanup()
      return { success: false, uid, reason: 'Lỗi: ' + (err && err.message ? err.message : err) }
    }
  }

  // Facebook coi là đăng nhập khi: URL là facebook.com, không phải trang login/checkpoint, không có ô password
  async waitFacebookLogin(wc, timeout) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (this.isAborted) return false
      const st = await wc.executeJavaScript(`
        (function(){
          var url = location.href.toLowerCase();
          var text = (document.body ? document.body.innerText.slice(0, 500) : '').toLowerCase();
          return { url: url.slice(0, 160), pass: !!document.querySelector('input[name="pass"]'), text: text };
        })()
      `).catch(() => null)
      if (st && st.url.indexOf('facebook.com') !== -1) {
        const loginPage = st.url.indexOf('/login') !== -1 || st.pass
          || st.text.indexOf('đăng nhập facebook') !== -1 || st.text.indexOf('log in to facebook') !== -1
        const checkpoint = st.url.indexOf('checkpoint') !== -1 || st.text.indexOf('xác minh danh tính') !== -1
        if (!loginPage && !checkpoint) return true
        if (checkpoint) return false
      }
      await sleep(1000)
    }
    return false
  }

  // Bấm nút Facebook và XÁC MINH có phản hồi (popup mở / URL đổi / kênh login biến mất).
  // Không phản hồi => bấm lại (trang chưa kịp gắn handler React).
  async startFacebookOAuth(wc, maxTries = 4) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      if (this.isAborted) return false
      const before = await wc.executeJavaScript('location.href').catch(() => '')
      const btn = await this.waitFacebookButton(wc, 15000)
      if (!btn) return false
      await this.clickAt(wc, btn.x, btn.y)
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        await sleep(800)
        if (this.popups.length > 0) return true
        const now = await wc.executeJavaScript(`
          (function(){ return { url: location.href, items: document.querySelectorAll('[data-e2e="channel-item"]').length }; })()
        `).catch(() => null)
        if (now && now.url !== before) return true
        if (now && now.items === 0) return true
      }
      this.log(`⚠ Bấm "Tiếp tục với Facebook" lần ${attempt} chưa ăn - thử lại...`)
    }
    return false
  }

  async waitFacebookButton(wc, timeout) {
    const deadline = Date.now() + timeout
    let bannerTried = 0
    while (Date.now() < deadline) {
      if (this.isAborted) return null
      const st = await wc.executeJavaScript(`
        (function(){
          var t;
          var btns = Array.from(document.querySelectorAll('button,[role="button"]'));
          for (var i = 0; i < btns.length; i++) {
            t = (btns[i].innerText || '').toLowerCase().trim();
            if (t === 'allow all' || t === 'accept all' || t === 'cho phép tất cả' || t === 'chấp nhận tất cả') {
              var rb = btns[i].getBoundingClientRect();
              return { banner: true, x: Math.round(rb.left + rb.width / 2), y: Math.round(rb.top + rb.height / 2) };
            }
          }
          var items = document.querySelectorAll('[data-e2e="channel-item"]');
          for (var k = 0; k < items.length; k++) {
            var tt = (items[k].innerText || '').toLowerCase();
            if (tt.indexOf('facebook') !== -1) {
              items[k].scrollIntoView({ block: 'center' });
              var r = items[k].getBoundingClientRect();
              return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          var els = Array.from(document.querySelectorAll('button,[role="button"],a,div')).filter(function(e) {
            var s = (e.innerText || '').toLowerCase();
            var r = e.getBoundingClientRect();
            return (s.indexOf('tiếp tục với facebook') !== -1 || s.indexOf('continue with facebook') !== -1
              || s.indexOf('log in with facebook') !== -1) && r.width > 0 && r.height > 0;
          });
          if (els.length) {
            els.sort(function(a, b) { return a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height });
            var r2 = els[0].getBoundingClientRect();
            return { found: true, x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2) };
          }
          return {};
        })()
      `).catch(() => null)
      if (st && st.banner && bannerTried < 3) {
        bannerTried++
        await this.clickAt(wc, st.x, st.y)
        await sleep(1500)
        continue
      }
      if (st && st.found) return st
      await sleep(1200)
    }
    return null
  }

  // OAuth chạy trên popup (nếu có) hoặc chính tab chính. Bấm "Continue as X",
  // sau đó bấm tiếp các nút Continue/OK trên màn hình xin phép nếu hiện.
  async handleOAuth(wc, ses, timeout) {
    const deadline = Date.now() + timeout
    let clickedContinueAs = false
    let diagCount = 0
    while (Date.now() < deadline) {
      if (this.isAborted) return { ok: false, reason: 'Đã dừng' }
      // dọn popup đã đóng (OAuth xong popup tự close)
      this.popups = this.popups.filter(p => { try { return !p.isDestroyed() } catch { return false } })
      const targets = [wc]
      const addWC = (w) => {
        try {
          if (w && !w.isDestroyed() && !targets.includes(w)) targets.push(w)
        } catch {}
      }
      for (const p of this.popups) addWC(p.webContents)
      // window.open con của cửa sổ chính (phòng when did-create-window miss)
      try {
        if (this.win && !this.win.isDestroyed()) {
          for (const cw of this.win.getChildWindows()) addWC(cw.webContents)
        }
      } catch {}
      for (const target of targets) {
        const st = await target.executeJavaScript(`
          (function(){
            var url = location.href.toLowerCase();
            var onFb = url.indexOf('facebook.com') !== -1;
            var pi = document.querySelector('input[name="pass"]');
            var passVisible = !!(pi && pi.offsetWidth > 0 && pi.offsetParent !== null);
            var matches = [];
            var els = Array.from(document.querySelectorAll('button,[role="button"],div[role="none"],div,span'));
            for (var i = 0; i < els.length; i++) {
              var t = (els[i].innerText || '').toLowerCase().replace(/\\s+/g, ' ').trim();
              var r = els[i].getBoundingClientRect();
              if (r.width < 10 || r.height < 10) continue;
              // KHÔNG dùng offsetParent: modal position:fixed có offsetParent = null dù vẫn hiện
              var cs = getComputedStyle(els[i]);
              if (cs.visibility === 'hidden' || cs.display === 'none') continue;
              var isAs = t.indexOf('continue as ') === 0 || (t.indexOf('tiếp tục với') === 0 && t.length < 60);
              var isGo = (t === 'continue' || t === 'ok' || t === 'tiếp tục' || t === 'đồng ý' || t === 'xác nhận' || t === 'allow' || t === 'cho phép');
              if (isAs || isGo) matches.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: t.slice(0, 50), area: r.width * r.height, isAs: isAs });
            }
            matches.sort(function(a, b) { return a.area - b.area });
            return { onFb: onFb, passVisible: passVisible, matches: matches.slice(0, 3), url: url.slice(0, 160),
              text: (document.body ? document.body.innerText.slice(0, 200) : '').toLowerCase() };
          })()
        `).catch(() => null)
        if (!st) continue
        if (st.matches.length) {
          const m = st.matches[0]
          if (m.isAs) {
            clickedContinueAs = true
            this.fbName = m.text.replace(/^continue as /i, '').replace(/^tiếp tục với\s*/i, '').trim()
            this.log(`👤 ${m.text.slice(0, 40)}`)
          }
          await this.clickAt(target, m.x, m.y)
          await sleep(2500)
        } else if (st.passVisible && st.onFb) {
          this.log(`🔍 Popup OAuth (${st.url}) đang hiện form đăng nhập FB`)
          return { ok: false, reason: 'FB bắt đăng nhập lại trong popup OAuth - cookie không đủ quyền' }
        } else if (st.onFb && st.text.indexOf('page isn') !== -1) {
          return { ok: false, reason: 'Popup OAuth báo trang lỗi (page not available)' }
        }
      }
      // Chẩn đoán định kỳ: mỗi webContents đang ở trang nào
      if (++diagCount % 5 === 1) {
        for (const t of targets) {
          const d = await t.executeJavaScript(
            `location.href.toLowerCase().slice(0, 90) + ' || ' + (document.body ? document.body.innerText.slice(0, 130).replace(/\\n/g, ' ') : '(trang trắng)')`
          ).catch(() => null)
          if (d) this.log(`⏳ chờ OAuth: ${d}`)
        }
      }
      // Trang chính: TikTok đã trả kết quả chưa (age page / banned / rời trang login)?
      const main = await wc.executeJavaScript(`
        (function(){
          var text = (document.body ? document.body.innerText.slice(0, 2000) : '').toLowerCase();
          var ageCount = document.querySelectorAll('[data-e2e="select-container"],[role="combobox"]').length;
          var items = document.querySelectorAll('[data-e2e="channel-item"]').length;
          var banned = text.indexOf('was banned') !== -1 || text.indexOf('suspended') !== -1
            || text.indexOf('bị cấm') !== -1 || text.indexOf('đã bị khóa') !== -1 || text.indexOf('đã bị khoá') !== -1
            || text.indexOf('tạm khóa') !== -1 || text.indexOf('tạm khoá') !== -1;
          return { banned: banned, ageCount: ageCount, items: items, url: location.href.toLowerCase() };
        })()
      `).catch(() => null)
      if (main && main.banned) {
        return { ok: false, reason: 'Tài khoản TikTok liên kết FB này bị banned/suspended (checkpoint)' }
      }
      // Đã có session TikTok (FB đã authorize trước đó -> tự redirect ngầm) = xong luôn
      if (await this.getTikTokCookie(ses)) {
        this.log('✅ Đã có phiên TikTok (đăng nhập ngầm qua OAuth)')
        return { ok: true, name: this.fbName }
      }
      if (main && main.ageCount >= 3) return { ok: true, name: this.fbName }
      // URL rời hẳn trang login -> đã vào trong (feed/foryou/profile) = đăng nhập xong
      if (main && main.url.indexOf('tiktok.com') !== -1 && main.url.indexOf('/login') === -1
        && main.url.indexOf('facebook.com') === -1 && main.url.indexOf('/oauth') === -1
        && (main.url.indexOf('/foryou') !== -1 || main.url.indexOf('/following') !== -1
          || main.url.indexOf('/live') !== -1 || main.url.indexOf('/@') !== -1 || main.url.indexOf('/explore') !== -1)) {
        this.log(`🧭 TikTok đã vào ${main.url.slice(0, 60)} - coi như đăng nhập xong`)
        return { ok: true, name: this.fbName }
      }
      // Hoàn tất khi TRANG CHÍNH chuyển thật sự (popup OAuth đóng + rời /login hoặc age page hiện)
      if (main && clickedContinueAs && this.popups.length === 0
        && (main.url.indexOf('/login') === -1 || main.items === 0)) {
        this.log(`🧭 TikTok chuyển trang: ${main.url.slice(0, 80)}`)
        return { ok: true, name: this.fbName }
      }
      await sleep(1500)
    }
    return { ok: false, reason: clickedContinueAs
      ? 'Đã bấm Continue as nhưng không quay về TikTok'
      : 'Không thấy nút Continue as và TikTok không chuyển trang sau khi bấm Tiếp tục với Facebook' }
  }

  // Chọn Tháng/Ngày/Năm (combobox data-e2e=select-container) -> Tiếp -> Bỏ qua
  async finishTikTokFlow(wc, ses) {
    // đã có session TikTok (OAuth ngầm) thì khỏi chọn ngày sinh
    const early = await this.getTikTokCookie(ses, true)
    if (early) {
      this.log('✅ Đã đăng nhập sẵn, bỏ qua bước chọn ngày sinh')
      return true
    }
    // chờ trang chọn ngày sinh
    const deadline = Date.now() + 45000
    let agePage = false
    while (Date.now() < deadline) {
      if (this.isAborted) return false
      const n = await wc.executeJavaScript(`document.querySelectorAll('[data-e2e="select-container"],[role="combobox"]').length`).catch(() => 0)
      if (n >= 3) { agePage = true; break }
      await sleep(1000)
    }
    if (!agePage) {
      const diag = await wc.executeJavaScript(
        `location.href.slice(0,100) + ' || ' + (document.body ? document.body.innerText.slice(0, 250).replace(/\\n/g, ' ') : '')`
      ).catch(() => 'không đọc được trang')
      this.log('⚠ Không thấy trang chọn ngày sinh. Trang hiện tại: ' + diag)
      return false
    }
    this.log('🎂 Trang chọn ngày sinh đã hiện')

    const year = 1988 + Math.floor(Math.random() * 16)   // 1988-2003
    const month = Math.floor(Math.random() * 12)          // index 0-11
    const day = Math.floor(Math.random() * 28) + 1        // 1-28
    this.log(`🎂 Chọn sinh nhật: ${day}/${month + 1}/${year}`)

    const picks = [
      { label: 'Tháng', match: ['tháng', 'month'], kind: 'Month', idx: month },
      { label: 'Ngày', match: ['ngày', 'day'], kind: 'Day', idx: day - 1 },
      { label: 'Năm', match: ['năm', 'year'], kind: 'Year', idx: 2025 - year },
    ]
    for (const p of picks) {
      if (this.isAborted) return false
      const ok = await this.pickCombo(wc, p, 2)
      if (!ok) { this.log(`⚠ Chọn ${p.label} thất bại`); return false }
      await sleep(600)
    }

    // nút Tiếp
    await sleep(800)
    const nextBtn = await wc.executeJavaScript(`
      (function(){
        var b = document.querySelector('[data-e2e="next-button"]');
        if (!b) {
          var els = Array.from(document.querySelectorAll('button,[role="button"]')).filter(function(e) {
            var t = (e.innerText || '').toLowerCase().trim();
            return t === 'tiếp' || t === 'next';
          });
          b = els[0] || null;
        }
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        var r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `).catch(() => null)
    if (!nextBtn) { this.log('⚠ Không thấy nút Tiếp'); return false }
    await this.clickAt(wc, nextBtn.x, nextBtn.y)
    this.log('⏭ Đã bấm Tiếp')
    await sleep(4000)

    // vòng lặp Bỏ qua cho tới khi có cookie sessionid của tiktok
    for (let round = 0; round < 10; round++) {
      if (this.isAborted) return false
      const hasSession = await this.getTikTokCookie(ses)
      if (hasSession) return true
      const skip = await wc.executeJavaScript(`
        (function(){
          var els = Array.from(document.querySelectorAll('div,button,span')).filter(function(e) {
            var t = (e.innerText || '').toLowerCase().trim();
            var r = e.getBoundingClientRect();
            return (t.indexOf('bỏ qua') === 0 || t.indexOf('skip') === 0 || t === 'not now' || t === 'để sau' || t === 'later')
              && r.width > 0 && r.height > 0 && r.height < 120;
          });
          if (!els.length) return null;
          els.sort(function(a, b) { return a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height });
          var r = els[0].getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()
      `).catch(() => null)
      if (!skip) {
        const st = await wc.executeJavaScript(
          `location.href.toLowerCase().slice(0, 100) + ' || ' + (document.body ? document.body.innerText.slice(0, 180).replace(/\\n/g, ' ') : '')`
        ).catch(() => '?')
        if (round < 3 || round % 3 === 0) this.log(`⏳ Không thấy nút Bỏ qua (vòng ${round + 1}): ${st}`)
        const url = String(st).split(' || ')[0]
        if (url.indexOf('/login') === -1 && url.indexOf('tiktok.com') !== -1) return true
        await sleep(2500)
        continue
      }
      await this.clickAt(wc, skip.x, skip.y)
      this.log('⏭ Bỏ qua bước phụ')
      await sleep(3000)
    }
    return Boolean(await this.getTikTokCookie(ses))
  }

  async comboVerified(wc, p) {
    return wc.executeJavaScript(`
      (function(){
        var combos = document.querySelectorAll('[data-e2e="select-container"],[role="combobox"]');
        for (var i = 0; i < combos.length; i++) {
          var lab = combos[i].getAttribute('aria-label') || '';
          if (${JSON.stringify(p.match)}.some(function(w){ return lab.toLowerCase().indexOf(w) !== -1 })) {
            var el = document.getElementById(${JSON.stringify(p.kind)} + '-options-item-' + ${p.idx});
            if (el && el.getAttribute('aria-selected') === 'true') return true;
            var lbl = combos[i].querySelector('[class*="DivSelectLabel"]');
            var t = lbl ? (lbl.innerText || '').replace(/\\s+/g, ' ').trim() : '';
            return !!t && ${JSON.stringify(p.match)}.every(function(w){ return t.toLowerCase() !== w });
          }
        }
        return false;
      })()
    `).catch(() => false)
  }

  async pickCombo(wc, p, tries = 3) {
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (this.isAborted) return false
      // 1. click combobox để mở dropdown
      const box = await wc.executeJavaScript(`
        (function(){
          var combos = document.querySelectorAll('[data-e2e="select-container"],[role="combobox"]');
          for (var i = 0; i < combos.length; i++) {
            var lab = combos[i].getAttribute('aria-label') || '';
            if (${JSON.stringify(p.match)}.some(function(w){ return lab.toLowerCase().indexOf(w) !== -1 })) {
              combos[i].scrollIntoView({ block: 'center' });
              var r = combos[i].getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()
      `).catch(() => null)
      if (!box) { this.log(`⚠ Không thấy ô ${p.label}`); return false }
      await this.clickAt(wc, box.x, box.y)
      // 2. đợi dropdown mở thật (aria-expanded / listbox visible)
      let opened = false
      for (let k = 0; k < 6; k++) {
        await sleep(400)
        opened = await wc.executeJavaScript(`
          (function(){
            var combos = document.querySelectorAll('[data-e2e="select-container"],[role="combobox"]');
            for (var i = 0; i < combos.length; i++) {
              var lab = combos[i].getAttribute('aria-label') || '';
              if (${JSON.stringify(p.match)}.some(function(w){ return lab.toLowerCase().indexOf(w) !== -1 })) {
                if (combos[i].getAttribute('aria-expanded') === 'true') return true;
                var lst = combos[i].querySelector('[role="listbox"],[data-e2e="select-list"]');
                if (lst && lst.offsetWidth > 0) return true;
              }
            }
            return false;
          })()
        `).catch(() => false)
        if (opened) break
      }
      // 3. chọn option (theo index) - phải visible mới bấm được
      const opt = await wc.executeJavaScript(`
        (function(){
          var el = document.getElementById(${JSON.stringify(p.kind)} + '-options-item-' + ${p.idx});
          if (!el) {
            var combos = document.querySelectorAll('[data-e2e="select-container"],[role="combobox"]');
            for (var i = 0; i < combos.length; i++) {
              var lab = combos[i].getAttribute('aria-label') || '';
              if (${JSON.stringify(p.match)}.some(function(w){ return lab.toLowerCase().indexOf(w) !== -1 })) {
                var opts = combos[i].querySelectorAll('[role="option"]');
                if (opts[${p.idx}]) el = opts[${p.idx}];
                break;
              }
            }
          }
          if (!el) return { missing: true };
          el.scrollIntoView({ block: 'center' });
          var r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
        })()
      `).catch(() => null)
      if (!opt || opt.missing) { this.log(`⚠ Không tìm thấy option ${p.label} thứ ${p.idx + 1}`); continue }
      if (!opt.w || !opt.h) { this.log(`⚠ Option ${p.label} chưa hiện ra (dropdown chưa mở)`); await sleep(1000); continue }
      await this.clickAt(wc, opt.x, opt.y)
      await sleep(600)
      // 4. xác nhận - chưa xong thì fallback JS click
      let verified = await this.comboVerified(wc, p)
      if (!verified) {
        await wc.executeJavaScript(`
          (function(){
            var el = document.getElementById(${JSON.stringify(p.kind)} + '-options-item-' + ${p.idx});
            if (!el) {
              var combos = document.querySelectorAll('[data-e2e="select-container"],[role="combobox"]');
              for (var i = 0; i < combos.length; i++) {
                var lab = combos[i].getAttribute('aria-label') || '';
                if (${JSON.stringify(p.match)}.some(function(w){ return lab.toLowerCase().indexOf(w) !== -1 })) {
                  var opts = combos[i].querySelectorAll('[role="option"]');
                  if (opts[${p.idx}]) el = opts[${p.idx}];
                  break;
                }
              }
            }
            if (el) { ['mousedown','mouseup','click'].forEach(function(t){ el.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, view:window})) }) }
          })()
        `).catch(() => {})
        await sleep(800)
        verified = await this.comboVerified(wc, p)
      }
      if (verified) return true
      this.log(`⚠ Chọn ${p.label} chưa ăn (lần ${attempt})`)
    }
    return false
  }

  async getTikTokCookie(ses, withDiag) {
    try {
      // API đọc cookie khác nhau tuỳ Electron - dùng cái nào có
      let cookies
      if (typeof ses.getCookies === 'function') cookies = await ses.getCookies({})
      else if (typeof ses.cookies.getCookies === 'function') cookies = await ses.cookies.getCookies({})
      else cookies = await ses.cookies.get({})
      cookies = cookies.filter(c => (c.domain || '').includes('tiktok'))
      const names = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss', 'odin_tt', 'tt-target-idc']
      const pairs = cookies.filter(c => names.includes(c.name)).map(c => `${c.name}=${c.value}`)
      if (!cookies.some(c => c.name === 'sessionid' || c.name === 'sessionid_ss')) {
        if (withDiag) this.log('🍪 Cookie TikTok (' + cookies.length + '): ' + (cookies.length ? cookies.map(c => c.name).join(', ').slice(0, 300) : 'KHÔNG có cookie nào'))
        return null
      }
      return pairs.join('; ')
    } catch (e) {
      if (withDiag) this.log('🍪 getTikTokCookie lỗi: ' + e.message)
      return null
    }
  }
}

module.exports = { TikTokEngine }
