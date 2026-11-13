// Engine REG PAGE: nạp cookie -> mở https://www.facebook.com/pages/creation/
// -> điền tên Page (lấy từ file txt theo thứ tự từng cookie) -> category "fan" x3
// (gõ fan -> mũi tên xuống -> Enter) -> Create Page -> Next -> Next -> Skip -> Next -> Done
// Không có bước xuất file — kết quả chỉ hiện trong bảng (uid page + link).
const { BrowserWindow, session } = require('electron')
const FBRegisterEngine = require('./fbreg.js')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const CREATE_URL = 'https://www.facebook.com/pages/creation/?ref_type=launch_point'

class FBPageEngine {
  constructor({ showBrowser, slot, proxy, onLog }) {
    this.showBrowser = showBrowser !== false
    this.slot = slot || 0
    this.proxy = proxy || ''
    this.onLog = onLog || (() => {})
    this.win = null
    this.isAborted = false
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

  async run(account, pageName) {
    const acc = {
      uid: account.uid || '', email: account.email || '', pass: account.pass || '',
      twofa: account.twofa || '', cookie: account.cookie || ''
    }
    const label = acc.uid || acc.email || '(cookie trần)'
    this.log(`📄 REG PAGE: mở phiên cho ${label} — tên page: "${pageName}"`)

    const partitionName = `persist:fbpage_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const ses = session.fromPartition(partitionName)
    if (this.proxy && this.proxy.trim()) {
      try {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: this.proxy.trim() })
        this.log(`🌐 Proxy áp dụng: ${this.proxy.trim()}`)
      } catch (pe) { this.log(`⚠ Proxy lỗi: ${pe.message}`) }
    }
    ses.setUserAgent(UA_DESKTOP)

    const posX = 60 + (this.slot % 4) * 445
    const posY = 40 + Math.floor(this.slot / 4) * 850
    const win = new BrowserWindow({
      x: posX, y: posY,
      width: 430, height: 830,
      show: Boolean(this.showBrowser),
      title: `REG PAGE - ${label}`,
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

    const result = { success: false, status: 'ERROR', uid: acc.uid, pageName, pageUrl: '', cookie: acc.cookie, error: '' }

    try {
      // 1. Nạp cookie
      const pairs = this.parseFBCookies(acc.cookie)
      if (!pairs.length) {
        result.error = 'Không đọc được cookie nào từ dòng này'
        this.log(`❌ ${label}: không đọc được cookie`)
        await cleanup()
        return result
      }
      const ok = await this.injectCookies(ses, pairs)
      this.log(`🍪 ${label}: đã nạp ${ok}/${pairs.length} cookie`)

      const { sleep: zzz, clickText, fillInput, loadPage, dumpPageState } = this.helper._pageHelpers(win, wc, (m) => this.log(m), 'REG PAGE')

      // 2. Mở thẳng trang tạo Page — cookie chết thì FB đá về login
      this.log('⏳ Mở trang pages/creation...')
      let loaded = false
      for (let i = 0; i < 2 && !loaded && !this.isAborted; i++) {
        loaded = await loadPage(CREATE_URL)
      }
      if (this.isAborted) { result.error = 'Đã hủy'; await cleanup(); return result }
      if (!loaded) {
        result.status = 'ERROR'
        result.error = 'Không tải được trang tạo Page (proxy chết/chậm?)'
        result.proxyFail = true
        await cleanup()
        return result
      }

      // Phân loại: đá về login = cookie chết; checkpoint = checkpoint
      const st = await this.js(wc, `(function(){
        var path = location.pathname || '';
        var t = ((document.body && document.body.innerText) || '').toLowerCase();
        if (path.indexOf('/checkpoint') === 0 || path.indexOf('/confirmidentity') === 0) return 'CHECKPOINT';
        if (location.href.indexOf('login.php') !== -1 || /log in to facebook|đăng nhập facebook/.test(t)) return 'DIE';
        if (document.querySelector('input[type="text"]')) return 'FORM';
        return 'UNKNOWN';
      })()`)
      this.log(`🔍 Trạng thái: ${st}`)
      if (st === 'CHECKPOINT') {
        result.status = 'CHECKPOINT'
        result.error = 'Cookie dính checkpoint - không tạo Page được'
        await cleanup()
        return result
      }
      if (st === 'DIE') {
        result.status = 'DIE'
        result.error = 'Cookie chết (bị đá ra trang đăng nhập)'
        await cleanup()
        return result
      }

      // 3. Điền tên Page (chờ input xuất hiện, tối đa ~30s)
      let nameOk = false
      for (let i = 0; i < 10 && !nameOk && !this.isAborted && !win.isDestroyed(); i++) {
        nameOk = await fillInput({ sel: 'input[type="text"]', val: pageName })
        if (!nameOk) await zzz(2500)
      }
      if (!nameOk) { await dumpPageState('không điền được tên Page'); result.error = 'Không điền được tên Page'; await cleanup(); return result }
      this.log(`✏️ Đã điền tên: "${pageName}"`)

      // 4. Category: gõ "fan" -> ArrowDown -> Enter, lặp 3 lần (3 chip category)
      //    CHÚ Ý: thanh search FB ở header cũng là input[type="search"] và đứng TRƯỚC trong DOM —
      //    phải nhắm đúng ô Category qua aria-label, fallback type=search nhưng loại name="q"
      const catSels = ['input[aria-label*="ategory" i]', 'input[aria-label*="huyên mục" i]', 'input[type="search"]:not([name="q"]):not([id="q"])']
      const dismissLeave = async () => {
        await clickText(['Leave Page', 'Leave site?', 'Rời trang'], true, 1500).catch(() => null)
      }
      for (let i = 0; i < 3 && !this.isAborted && !win.isDestroyed(); i++) {
        await dismissLeave()
        let filled = false
        for (const sel of catSels) {
          filled = await fillInput({ sel, val: 'fan' })
          if (filled) break
        }
        if (!filled) { this.log(`⚠ Category lần ${i + 1}: không điền được ô Category — bỏ qua`) }
        await zzz(600)
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
        await zzz(300)
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        await zzz(1500)
        this.log(`🏷 Category lần ${i + 1}/3: gõ "fan" -> Down -> Enter`)
      }

      // 5. Create Page -> Next -> Next -> Skip -> Next -> Done (đúng thứ tự UI 21-10)
      // FB chặn tạo page thì hiện toast "An error occurred while creating the page..." —
      // gặp là dừng ngay nick này, báo lỗi (status BLOCKED) chứ không mò tiếp các bước sau
      const detectCreateError = async () => await this.js(wc, `(function(){
        var t = (document.body ? document.body.innerText : '');
        var m = t.match(/An error occurred while creating the page[\\s\\S]{0,100}|Đã xảy ra lỗi khi tạo Trang[\\s\\S]{0,100}|error occurred while creating[\\s\\S]{0,100}/i);
        return m ? m[0].replace(/\\s+/g, ' ').trim() : null;
      })()`)
      const failCreateError = async (errTxt) => {
        this.log(`⛔ FB báo lỗi khi tạo Page: ${errTxt}`)
        result.success = false
        result.status = 'BLOCKED'
        result.error = 'FB chặn tạo Page: ' + errTxt
        await cleanup()
        return result
      }
      const steps = [
        { texts: ['Create Page', 'Create a Page', 'Tạo trang'], name: 'Create Page' },
        { texts: ['Next', 'Tiếp theo', 'Tiep theo'], name: 'Next 1' },
        { texts: ['Next', 'Tiếp theo', 'Tiep theo'], name: 'Next 2' },
        { texts: ['Skip', 'Bỏ qua'], name: 'Skip' },
        { texts: ['Next', 'Tiếp theo', 'Tiep theo'], name: 'Next 3' },
        { texts: ['Done', 'Xong'], name: 'Done' }
      ]
      for (const step of steps) {
        if (this.isAborted || win.isDestroyed()) { result.error = 'Đã hủy'; await cleanup(); return result }
        await dismissLeave()
        const errBefore = await detectCreateError()
        if (errBefore) return await failCreateError(errBefore)
        const hit = await clickText(step.texts, true, 30000)
        if (!hit) { await dumpPageState(`không thấy nút ${step.name}`); result.error = `Kẹt ở bước ${step.name}`; await cleanup(); return result }
        this.log(`👉 Đã bấm ${step.name}`)
        await zzz(3000)
        // Vừa bấm Create Page: toast lỗi hiện ra sau 1-3s — theo dõi sát vài giây
        if (step.name === 'Create Page') {
          for (let t = 0; t < 5; t++) {
            const errTxt = await detectCreateError()
            if (errTxt) return await failCreateError(errTxt)
            await zzz(1200)
          }
        }
      }

      // 6. Xác nhận: chờ URL đổi sang trang Page mới, bắt page id
      let pageId = ''
      for (let i = 0; i < 10 && !pageId && !this.isAborted && !win.isDestroyed(); i++) {
        const u = await this.js(wc, 'location.href')
        if (u) {
          let m = u.match(/profile\.php\?id=(\d+)/) || u.match(/facebook\.com\/(?:pages\/)?[^/?]*\/(\d{6,})(?:[/?]|$)/)
          if (m) pageId = m[1]
        }
        if (!pageId) await zzz(2000)
      }
      const finalUrl = await this.js(wc, 'location.href').catch(() => '')
      result.success = true
      result.status = 'LIVE'
      result.uid = pageId || acc.uid
      result.pageUrl = finalUrl || ''
      result.cookie = await this.extractCookieString(ses) || acc.cookie
      this.log(`🎉 ${label}: tạo Page "${pageName}" thành công${pageId ? ` — page id: ${pageId}` : ''}`)
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

module.exports = { FBPageEngine }
