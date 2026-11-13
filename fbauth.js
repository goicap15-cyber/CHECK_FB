// Engine AUTHENTICATION: nạp cookie từ menu trái (loadedEntries) -> mở session + inject cookie
// -> xác minh LIVE -> mở Accounts Center contact_points -> thêm email temp mới + xác minh OTP
// -> xóa contact cũ (SĐT thuê từ reg SMS) -> lấy cookie mới.
// Phần đổi thông tin tái dùng FBRegisterEngine.postRegContactFlow (fbreg.js) qua 1 helper instance.
const { BrowserWindow, session } = require('electron')
const FBRegisterEngine = require('./fbreg.js')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

class FBAuthEngine {
  constructor({ showBrowser, slot, proxy, emailProvider = 'tempmailapi', onLog }) {
    this.showBrowser = showBrowser !== false
    this.slot = slot || 0
    this.proxy = proxy || ''
    this.emailProvider = emailProvider || 'tempmailapi'
    this.onLog = onLog || (() => {})
    this.win = null
    this.isAborted = false
    // Helper chạy postRegContactFlow: chỉ dùng isAborted + các provider mail của nó
    this.helper = new FBRegisterEngine({})
  }

  log(msg) { this.onLog(msg) }

  abort() {
    this.isAborted = true
    this.helper.isAborted = true
    if (this.win && !this.win.isDestroyed()) { try { this.win.destroy() } catch {} }
    this.win = null
  }

  async js(wc, expr, to = 10000) {
    return Promise.race([
      wc.executeJavaScript(expr),
      sleep(to).then(() => { throw new Error('JS_TIMEOUT') })
    ]).catch(() => null)
  }

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
          out.push({ domain: f[0], path: f[2] || '/', secure: f[3] === 'TRUE', name: f[5], value: f.slice(6).join('\t') })
        }
      }
      if (out.length) return out
    }
    return raw.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
      const idx = pair.indexOf('=')
      return { domain: '.facebook.com', path: '/', secure: true, name: idx > -1 ? pair.substring(0, idx).trim() : pair.trim(), value: idx > -1 ? pair.substring(idx + 1).trim() : '' }
    }).filter(c => c.name && c.value)
  }

  async injectCookies(ses, pairs) {
    let ok = 0
    for (const c of pairs) {
      let domain = (c.domain || '.facebook.com').trim()
      if (!domain.startsWith('.')) domain = '.' + domain
      try {
        await ses.cookies.set({
          url: 'https://' + domain.replace(/^\./, '') + '/',
          name: c.name, value: c.value,
          domain, path: c.path || '/',
          secure: c.secure !== false,
          httpOnly: false,
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
    try {
      await Promise.race([wc.loadURL(url), sleep(timeoutMs)])
    } catch {}
    while (Date.now() - started < timeoutMs) {
      if (this.isAborted) return false
      await sleep(1500)
      try {
        const ready = await this.js(wc, '(function(){return {u: location.href, len: (document.body && document.body.innerText || "").length}})()').catch(() => null)
        if (ready && ready.u && !ready.u.startsWith('chrome-error:') && ready.len > 40) return true
      } catch {}
    }
    return false
  }

  async detectState(wc) {
    return await this.js(wc, `
      (function() {
        var path = location.pathname || '';
        var href = location.href || '';
        var body = document.body;
        var t = ((body && body.innerText) || '').toLowerCase();
        var state = 'UNKNOWN';
        if (path.indexOf('/checkpoint') === 0 || path.indexOf('/confirmidentity') === 0) state = 'CHECKPOINT';
        else if (path.indexOf('/disabled') === 0 || path.indexOf('/suspended') === 0 || href.indexOf('260749603972907') !== -1) state = 'DIE';
        else {
          var two = document.getElementById('approvals_code') || document.querySelector('input[name="approvals_code"]') || document.querySelector('input[autocomplete="one-time-code"]');
          if (two && two.offsetWidth > 0) state = 'NEED_2FA';
          else {
            var email = document.getElementById('email') || document.querySelector('input[name="email"]');
            var pass = document.getElementById('pass') || document.querySelector('input[name="pass"]');
            if (email && pass && email.offsetWidth > 0 && pass.offsetWidth > 0) state = 'LOGIN_FORM';
            else {
              var useAnother = document.querySelector('a[href*="/login/device-based/regular/login/"]') ||
                Array.from(document.querySelectorAll('span, a, div[role="button"], button')).find(function(el) {
                  var tx = el.textContent || '';
                  return tx.indexOf('Use another profile') !== -1 || tx.indexOf('tài khoản khác') !== -1 || tx.indexOf('dụng tài khoản khác') !== -1;
                });
              if (useAnother && useAnother.offsetWidth > 0) state = 'CHOOSER';
              else {
                var fastPass = document.querySelector('input[type="password"]');
                if (fastPass && fastPass.offsetWidth > 0) state = 'FAST_PASS';
                else {
                  var feed = document.querySelector('div[role="feed"]') ||
                    document.querySelector('a[aria-label="Home"], a[aria-label="Trang chủ"], div[aria-label="Account"], div[aria-label="Tài khoản"]');
                  if (feed) state = 'FEED';
                  else if (t.indexOf('vào facebook') !== -1 || t.indexOf('log in to facebook') !== -1 || t.indexOf('đăng nhập facebook') !== -1) state = 'LOGIN_FORM';
                }
              }
            }
          }
        }
        return { state: state, title: (document.title || '').substring(0, 60) };
      })()
    `)
  }

  async run(account) {
    const acc = {
      uid: account.uid || '', email: account.email || '', pass: account.pass || '',
      twofa: account.twofa || '', cookie: account.cookie || ''
    }
    const label = acc.uid || acc.email || '(cookie trần)'
    this.log(`🔑 Authentication: mở phiên cho ${label}`)

    const partitionName = `persist:fbauth_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const ses = session.fromPartition(partitionName)
    if (this.proxy && this.proxy.trim()) {
      try {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: this.proxy.trim() })
        this.log(`🌐 Proxy áp dụng: ${this.proxy.trim()}`)
      } catch (pe) { this.log(`⚠ Proxy lỗi: ${pe.message}`) }
    }
    ses.setUserAgent(UA_DESKTOP)

    // Cửa sổ xếp lưới theo slot (4 cửa sổ/hàng — giống reg)
    const posX = 60 + (this.slot % 4) * 445
    const posY = 40 + Math.floor(this.slot / 4) * 850
    const win = new BrowserWindow({
      x: posX, y: posY,
      width: 430, height: 830,
      show: Boolean(this.showBrowser),
      title: `Authentication - ${label}`,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false }
    })
    this.win = win
    const wc = win.webContents
    win.on('closed', () => { this.win = null })
    const cleanup = async () => {
      this.log('🧹 Dọn dẹp phiên...')
      try { if (!win.isDestroyed()) win.destroy() } catch {}
      this.win = null
      try { await Promise.race([ses.clearStorageData(), sleep(5000)]) } catch {}
    }

    const result = { success: false, status: 'ERROR', uid: acc.uid, newEmail: null, deletedOld: false, cookie: acc.cookie, pass: acc.pass, twofa: acc.twofa, error: '' }

    try {
      // 1. Nạp cookie
      const pairs = this.parseFBCookies(acc.cookie)
      if (!pairs.length) {
        result.status = 'ERROR'
        result.error = 'Không đọc được cookie nào từ dòng này'
        this.log(`❌ ${label}: không đọc được cookie`)
        await cleanup()
        return result
      }
      const ok = await this.injectCookies(ses, pairs)
      this.log(`🍪 ${label}: đã nạp ${ok}/${pairs.length} cookie`)

      // 2. Mở facebook.com và phân loại
      this.log('⏳ Mở facebook.com kiểm tra phiên...')
      const loaded = await this.loadPage(wc, 'https://www.facebook.com/', 60000)
      if (this.isAborted) { result.status = 'ERROR'; result.error = 'Đã hủy'; await cleanup(); return result }
      if (!loaded) {
        result.status = 'ERROR'
        result.error = 'Không tải được Facebook (proxy chết/chậm?)'
        result.proxyFail = true
        await cleanup()
        return result
      }

      let st = await this.detectState(wc)
      this.log(`🔍 Trạng thái: ${st ? st.state : 'không đọc được DOM'}`)

      // CHOOSER (màn chọn profile): cookie còn sống - bấm fast-login "Continue <Tên>" như NUÔI
      if (st && st.state === 'CHOOSER') {
        const fast = await this.js(wc, `
          (function() {
            var btns = Array.from(document.querySelectorAll('div[role="button"], button'));
            var target = null;
            for (var i = 0; i < btns.length; i++) {
              var al = (btns[i].getAttribute('aria-label') || '').trim();
              var tx = (btns[i].textContent || '').trim();
              if (/^continue\\s+\\S/i.test(al) || /^(continue as|tiếp tục với)\\s+\\S/i.test(tx) || /^tiếp tục\\s+\\S/i.test(al)) {
                if (al.indexOf('Use another') === -1) { target = btns[i]; break; }
              }
            }
            if (!target) {
              for (var i = 0; i < btns.length; i++) {
                var al = (btns[i].getAttribute('aria-label') || '').trim();
                var tx = (btns[i].textContent || '').trim();
                if (al === 'Continue' || tx === 'Continue') { target = btns[i]; break; }
              }
            }
            if (target) { target.click(); return 'CLICKED_FAST'; }
            return 'NO_FAST';
          })()
        `)
        if (fast === 'CLICKED_FAST') {
          this.log('👉 Bấm fast-login "Continue <tên>" - phiên cookie còn sống')
          await sleep(6000)
          st = await this.detectState(wc)
          this.log(`🔍 Trạng thái sau fast-login: ${st ? st.state : '?'}`)
        }
      }

      if (st && (st.state === 'CHECKPOINT' || st.state === 'NEED_2FA')) {
        result.status = 'CHECKPOINT'
        result.error = 'Cookie dính checkpoint/2FA - không đổi thông tin được'
        await cleanup()
        return result
      }
      if (!st || (st.state !== 'FEED')) {
        result.status = 'DIE'
        result.error = 'Cookie chết (bị đá ra trang đăng nhập)'
        await cleanup()
        return result
      }
      this.log(`✅ ${label}: cookie LIVE — bắt đầu đổi thông tin`)

      // 3. Flow đổi thông tin: thêm email temp mới + xác minh OTP (tái dùng postRegContactFlow).
      //    User chốt 21-10: KHÔNG cần xóa SĐT cũ — chỉ thay email.
      const contactFlow = await this.helper.postRegContactFlow({
        win, wc, log: (m) => this.log(m),
        mode: 'sms',
        emailProvider: this.emailProvider,
        oldEmail: null,
        oldPhone: '',
        password: acc.pass
      })

      if (contactFlow && contactFlow.verified) {
        result.newEmail = contactFlow.verifiedEmail
        result.deletedOld = !!contactFlow.deletedOld
        result.emailProvider = contactFlow.mailProvider || this.emailProvider
        result.emailToken = contactFlow.mailToken || contactFlow.verifiedEmail

        // Bật 2FA (authentication app) qua Accounts Center — key lưu lại để lấy OTP sau này
        const twoFa = await this.helper.postRegTwoFactorFlow({
          win, wc, log: (m) => this.log(m),
          password: acc.pass
        })
        result.twoFaOk = !!(twoFa && twoFa.ok)
        if (twoFa && twoFa.ok && twoFa.key) result.twofa = twoFa.key

        result.success = true
        result.status = 'LIVE'
        const fresh = await this.extractCookieString(ses)
        if (fresh) result.cookie = fresh
        this.log(`🎉 ${label}: xong — email mới ${contactFlow.verifiedEmail}${contactFlow.deletedOld ? ', đã xóa SĐT cũ' : ''}${result.twoFaOk ? `, 2FA ON (key: ${result.twofa})` : ', chưa bật được 2FA'}`)
      } else {
        // Cookie vẫn LIVE, chỉ là chưa đổi được thông tin
        result.success = false
        result.status = 'LIVE'
        result.error = 'Cookie LIVE nhưng chưa đổi được thông tin (email chưa xác minh)'
        const fresh = await this.extractCookieString(ses)
        if (fresh) result.cookie = fresh
        this.log(`⚠ ${label}: cookie còn sống nhưng email mới chưa xác minh — giữ nguyên thông tin cũ`)
      }
      await cleanup()
      return result

    } catch (err) {
      this.log(`❌ ${label}: ${err.message}`)
      result.status = 'ERROR'
      result.error = err.message
      await cleanup()
      return result
    }
  }
}

module.exports = { FBAuthEngine }
