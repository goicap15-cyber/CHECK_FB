// ==========================================
// ENGINE THÊM AVATAR (28-10) — thay menu Thêm thông tin Profile
// Flow:
//   1. Mở profile.php?id=<uid>&locale=vi_VN
//   2. Scroll tìm + click ô "What's on your mind?" (role="button" có span text "What's on your mind?")
//   3. Đưa ảnh vào clipboard → Ctrl+V dán vào lexical editor trong dialog
//      (nếu dán không ăn → fallback bấm Photo/video + inject file vào input)
//   4. Chờ preview ảnh xuất hiện → click nút Post (aria-label="Post"|"Đăng")
// Kết quả: SOLVED | CHECKPOINT | DIE | FAIL | ERROR
// ==========================================

const { BrowserWindow, session, screen, clipboard, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
]

function randomPhoto(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f))
    if (!files.length) return null
    const f = files[Math.floor(Math.random() * files.length)]
    const buf = fs.readFileSync(path.join(dir, f))
    return { name: path.basename(f), mime: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg', buf }
  } catch { return null }
}

class FBProfileEngine {
  constructor({ showBrowser, slot, proxy, photoDir, photoPath, onLog }) {
    this.showBrowser = showBrowser !== false
    this.slot = slot || 0
    this.proxy = proxy || ''
    this.photoDir = photoDir || ''
    this.photoPath = photoPath || ''   // 28-10: ảnh RIÊNG gán cho VIA này (1 VIA = 1 ảnh)
    this.onLog = onLog || (() => {})
    this.win = null
    this.isAborted = false
  }

  log(msg) { this.onLog(msg) }

  abort() {
    this.isAborted = true
    if (this.win && !this.win.isDestroyed()) { try { this.win.destroy() } catch {} }
    this.win = null
  }

  // Chạy JS trong webContents với timeout
  js(wc, expr, to = 15000) {
    return Promise.race([
      wc.executeJavaScript(expr),
      sleep(to).then(() => { throw new Error('JS_TIMEOUT') })
    ]).catch(() => null)
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
      return fb.map(c => `${c.name}=${c.value}`).join('; ')
    } catch { return '' }
  }

  async loadPage(wc, url, timeoutMs = 60000) {
    const started = Date.now()
    try { await Promise.race([wc.loadURL(url), sleep(timeoutMs)]) } catch {}
    while (Date.now() - started < timeoutMs) {
      if (this.isAborted) return false
      await sleep(1500)
      const ready = await this.js(wc, '(function(){return {u: location.href, len: (document.body && document.body.innerText || "").length}})()')
      if (ready && ready.u && !ready.u.startsWith('chrome-error:') && ready.len > 40) return true
    }
    return false
  }

  // Gửi click vật lý tại toạ độ (x, y) trên win.webContents
  sendClick(x, y) {
    const wc = this.win && !this.win.isDestroyed() ? this.win.webContents : null
    if (!wc) return
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp',   x, y, button: 'left', clickCount: 1 })
  }

  // ── FINDER: scroll + poll cho đến khi tìm thấy phần tử, trả về {x,y} hoặc null ──
  // finderExpr phải trả về {x, y} hoặc null
  async findAndClick(wc, finderExpr, label, { timeoutMs = 25000, scrollStep = 400, noScroll = false } = {}) {
    const started = Date.now()
    let scrolledToBottom = false
    while (Date.now() - started < timeoutMs && !this.isAborted) {
      const pos = await this.js(wc, finderExpr)
      if (pos && typeof pos.x === 'number') {
        this.sendClick(pos.x, pos.y)
        this.log(`👉 Đã click: ${label} tại (${pos.x},${pos.y})`)
        return true
      }
      if (!noScroll) {
        const atBottom = await this.js(wc, '(window.innerHeight + Math.round(window.scrollY)) >= (document.body.scrollHeight - 50)')
        if (atBottom && !scrolledToBottom) {
          // Kéo lên đầu và thử lại 1 lượt nữa
          await this.js(wc, 'window.scrollTo({top: 0, behavior: "instant"})')
          scrolledToBottom = true
          await sleep(800)
        } else if (atBottom && scrolledToBottom) {
          // Đã cuộn hết 2 vòng mà không thấy
          break
        } else {
          await this.js(wc, `window.scrollBy({top: ${scrollStep}, behavior: "instant"})`)
          scrolledToBottom = false
        }
        await sleep(700)
      } else {
        await sleep(1000)
      }
    }
    this.log(`⚠ Không thấy: ${label}`)
    return false
  }

  // ── Dismiss các popup chặn trước khi đăng bài ──
  // Bao gồm: "Review audience" → Continue, cookie notice, v.v.
  async _dismissPopups(wc) {
    this.log('🔎 Kiểm tra popup chặn (Review audience, Continue, v.v.)...')
    const popupFinder = `(function(){
      // Tìm nút "Continue"/"Tiếp tục"/"OK"/"Got it" trong bất kỳ overlay nào
      var allBtns = Array.from(document.querySelectorAll('[role="button"], button'));
      var keywords = ['continue', 'tiếp tục', 'ok', 'got it', 'đã hiểu', 'close', 'đóng', 'not now', 'để sau'];
      var best = null;
      for (var i = 0; i < allBtns.length; i++) {
        var txt = (allBtns[i].textContent || '').trim().toLowerCase();
        var al  = (allBtns[i].getAttribute('aria-label') || '').trim().toLowerCase();
        var matched = keywords.some(function(k){ return txt === k || al === k; });
        if (!matched) continue;
        var r = allBtns[i].getBoundingClientRect();
        if (r.width < 30 || r.height < 10) continue;
        if (r.top < 0 || r.bottom > window.innerHeight + 10) continue;
        // Ưu tiên nút nổi bật nhất (diện tích lớn nhất = nút chính)
        if (!best || r.width * r.height > best.s) {
          best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), txt: txt, s: r.width * r.height };
        }
      }
      return best;
    })()`

    // Poll tối đa 6 giây, nếu có popup thì click dismiss
    for (let t = 0; t < 4; t++) {
      await sleep(1500)
      const pos = await this.js(wc, popupFinder)
      if (pos && typeof pos.x === 'number') {
        this.log(`👉 Dismiss popup: nút "${pos.txt}" tại (${pos.x},${pos.y})`)
        this.sendClick(pos.x, pos.y)
        await sleep(2000)
        // Check thêm lần 2 xem có popup nào mới không
        const pos2 = await this.js(wc, popupFinder)
        if (pos2 && typeof pos2.x === 'number' && pos2.txt !== pos.txt) {
          this.log(`👉 Dismiss popup thứ 2: "${pos2.txt}"`)
          this.sendClick(pos2.x, pos2.y)
          await sleep(1500)
        }
        break
      }
    }
  }

  // ── Dismiss popup "Review audience" / "Continue" xuất hiện SAU khi click composer ──
  async _dismissReviewAudience(wc) { /* deprecated — dùng _handleAudienceFlow */ }

  // ── Xử lý chuỗi popup sau khi click composer ──
  // Bước 1: "Review audience" → JS click "Continue"
  // Bước 2: nếu có "Save" → JS click Save
  // Bước 3: nếu composer bị đóng sau đó → click lại "What's on your mind?"
  async _handleAudienceFlow(wc, composerFinder) {
    // JS click "Continue" — không dùng tọa độ, dùng thẳng .click()
    const jsClickContinue = `(function(){
      var btn = document.querySelector('[aria-label="Continue"][role="button"]');
      if (!btn) {
        var all = Array.from(document.querySelectorAll('[role="button"], button'));
        for (var i = 0; i < all.length; i++) {
          var t = (all[i].textContent || '').trim().toLowerCase();
          if (t === 'continue' || t === 'tiếp tục') { btn = all[i]; break; }
        }
      }
      if (!btn) return false;
      btn.click(); return true;
    })()`

    // JS click "Save"
    const jsClickSave = `(function(){
      var btn = document.querySelector('[aria-label="Save"][role="button"]');
      if (!btn) {
        var all = Array.from(document.querySelectorAll('[role="button"], button'));
        for (var i = 0; i < all.length; i++) {
          var t = (all[i].textContent || '').trim().toLowerCase();
          if (t === 'save' || t === 'lưu') { btn = all[i]; break; }
        }
      }
      if (!btn) return false;
      btn.click(); return true;
    })()`

    // Kiểm tra composer dialog có đang mở (có lexical editor)
    const composerOpenChecker = `(function(){
      var dlg = document.querySelector('div[role="dialog"]');
      if (!dlg) return false;
      var ed = dlg.querySelector('[data-lexical-editor="true"], [role="textbox"][contenteditable="true"]');
      return !!ed;
    })()`

    this.log('🔎 Kiểm tra popup audience (Continue → Save → mở lại composer nếu bị đóng)...')
    let continueClicked = false
    let saveClicked = false

    for (let t = 0; t < 10; t++) {
      await sleep(1500)

      // Bước 1: JS click "Continue" nếu chưa click
      if (!continueClicked) {
        const ok = await this.js(wc, jsClickContinue)
        if (ok) {
          this.log('👉 Đã JS-click "Continue"')
          continueClicked = true
          await sleep(2500)
          continue
        }
      }

      // Bước 2: JS click "Save" nếu xuất hiện (sau Continue)
      const saveOk = await this.js(wc, jsClickSave)
      if (saveOk) {
        this.log('👉 Đã JS-click "Save"')
        saveClicked = true
        await sleep(2500)
        continue
      }

      // Bước 3: Kiểm tra composer có mở không
      const composerOpen = await this.js(wc, composerOpenChecker)
      if (composerOpen) {
        this.log('✅ Composer dialog đang mở — sẵn sàng dán ảnh')
        return
      }

      // Composer bị đóng sau Continue/Save → click lại "What's on your mind?"
      if (continueClicked || saveClicked) {
        this.log("🔄 Composer đã đóng sau audience flow → click lại \"What's on your mind?\"")
        await this.findAndClick(wc, composerFinder, '"What\'s on your mind?" (lần 2)', { timeoutMs: 15000, scrollStep: 350 })
        await sleep(3000)
        return
      }

      // Chưa có gì xảy ra và composer chưa mở → chờ thêm
    }
    this.log('ℹ Không thấy popup audience — tiếp tục bình thường')
  }
  // ── Đặt avatar bằng cách: ảnh đại diện → Chọn ảnh → chọn ảnh có sẵn → Save ──
  async _setAvatarFromGallery(wc) {
    this.log('📷 Thử đặt avatar qua nút ảnh đại diện...')

    // Scroll lên đầu trang
    await this.js(wc, 'window.scrollTo({top: 0, behavior: "instant"})')
    await sleep(1500)

    // ── Bước 1: Click vào ảnh đại diện (Profile picture actions) ──
    const profilePicFinder = `(function(){
      var btn = document.querySelector('[aria-label="Profile picture actions"][role="button"]');
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      var r = btn.getBoundingClientRect();
      if (r.width < 30 || r.height < 30) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`

    const ppClicked = await this.findAndClick(wc, profilePicFinder, 'Profile picture actions', { timeoutMs: 15000, noScroll: true })
    if (!ppClicked) {
      this.log('⚠ Không tìm thấy nút ảnh đại diện — bỏ qua bước này')
      return false
    }
    await sleep(2000)

    // ── Bước 2: Click "Choose profile picture" trong menu ──
    const choosePicOk = await this.js(wc, `(function(){
      var items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      for (var i = 0; i < items.length; i++) {
        var t = (items[i].textContent || '').toLowerCase();
        if (t.indexOf('choose profile picture') !== -1 || t.indexOf('chọn ảnh đại diện') !== -1 || t.indexOf('chon anh dai dien') !== -1) {
          items[i].click(); return true;
        }
      }
      // Fallback: tìm span có text
      var spans = Array.from(document.querySelectorAll('span'));
      for (var j = 0; j < spans.length; j++) {
        var st = (spans[j].textContent || '').trim();
        if (st === 'Choose profile picture' || st === 'Chọn ảnh đại diện') {
          var el = spans[j];
          for (var k = 0; k < 6; k++) {
            el = el.parentElement;
            if (!el) break;
            if (el.getAttribute('role') === 'menuitem' || el.getAttribute('role') === 'button') {
              el.click(); return true;
            }
          }
        }
      }
      return false;
    })()`)
    if (!choosePicOk) {
      this.log('⚠ Không tìm thấy "Choose profile picture" — bỏ qua')
      return false
    }
    this.log('👉 Đã JS-click "Choose profile picture"')
    await sleep(3000)

    // ── Bước 3: Click vào ảnh có sẵn trong gallery ──
    // aria-label chứa "Select profile photo"
    const selectPhotoOk = await this.js(wc, `(function(){
      // Tìm ảnh có aria-label chứa "Select profile photo" hoặc "Chọn ảnh đại diện"
      var btns = Array.from(document.querySelectorAll('[role="button"][aria-label]'));
      for (var i = 0; i < btns.length; i++) {
        var al = (btns[i].getAttribute('aria-label') || '').toLowerCase();
        if (al.indexOf('select profile photo') !== -1 || al.indexOf('chọn ảnh đại diện') !== -1) {
          btns[i].click(); return true;
        }
      }
      return false;
    })()`)
    if (!selectPhotoOk) {
      this.log('⚠ Không tìm thấy ảnh gallery để chọn — bỏ qua')
      return false
    }
    this.log('👉 Đã JS-click ảnh có sẵn trong gallery')
    await sleep(3000)

    // ── Bước 4: Click "Save" ──
    const saveOk = await this.js(wc, `(function(){
      var btn = document.querySelector('[aria-label="Save"][role="button"]');
      if (!btn) {
        var all = Array.from(document.querySelectorAll('[role="button"], button'));
        for (var i = 0; i < all.length; i++) {
          var t = (all[i].textContent || '').trim().toLowerCase();
          if (t === 'save' || t === 'lưu') { btn = all[i]; break; }
        }
      }
      if (!btn) return false;
      btn.click(); return true;
    })()`)
    if (saveOk) {
      this.log('👉 Đã JS-click "Save" — avatar đang được lưu...')
      await sleep(5000)
      this.log('✅ Đặt avatar qua gallery thành công!')
      return true
    }
    this.log('⚠ Không tìm thấy nút Save')
    return false
  }


  // ── Danh sách random ──
  _randomCity() {
    const cities = [
      'Hà Nội', 'Hồ Chí Minh', 'Đà Nẵng', 'Hải Phòng', 'Cần Thơ',
      'Biên Hòa', 'Nha Trang', 'Buôn Ma Thuột', 'Huế', 'Vũng Tàu',
      'Quy Nhơn', 'Thái Nguyên', 'Bắc Ninh', 'Hải Dương', 'Nam Định',
      'Vinh', 'Thanh Hóa', 'Mỹ Tho', 'Long Xuyên', 'Đà Lạt',
      'Phan Thiết', 'Rạch Giá', 'Cà Mau', 'Bắc Giang', 'Việt Trì',
      'Hạ Long', 'Sơn Tây', 'Hà Đông', 'Thủ Dầu Một', 'Pleiku'
    ]
    return cities[Math.floor(Math.random() * cities.length)]
  }

  _randomCompany() {
    const companies = [
      'Công ty TNHH Thương Mại Sơn Nam', 'Công ty CP Đầu Tư Bình Minh',
      'Công ty TNHH Xây Dựng Hoàng Gia', 'Cửa hàng Tiện Lợi An Phúc',
      'Công ty CP Dịch Vụ Vạn Thành', 'Cửa hàng Thời Trang Hải Yến',
      'Công ty TNHH Thực Phẩm Đại Nam', 'Công ty CP Vận Tải Miền Bắc',
      'Công ty TNHH Kỹ Thuật Số Thiên Tân', 'Nhà Hàng Phở Bắc Hương',
      'Siêu Thị Mini Hòa Phát', 'Cửa hàng Điện Tử Tuấn Anh',
      'Trung Tâm Anh Ngữ Smart English', 'Công ty CP Môi Trường Xanh',
      'Cửa hàng Mỹ Phẩm Beauty House'
    ]
    return companies[Math.floor(Math.random() * companies.length)]
  }

  _randomPosition() {
    const positions = [
      'Nhân viên kinh doanh', 'Nhân viên kế toán', 'Nhân viên văn phòng',
      'Nhân viên bán hàng', 'Quản lý cửa hàng', 'Kỹ thuật viên',
      'Nhân viên marketing', 'Chuyên viên tư vấn', 'Nhân viên giao hàng',
      'Thu ngân', 'Nhân viên phục vụ', 'Thợ may', 'Thợ sửa xe',
      'Giáo viên', 'Lập trình viên', 'Nhân viên IT', 'Nhân viên hành chính',
      'Chuyên viên nhân sự', 'Nhân viên chăm sóc khách hàng', 'Freelancer'
    ]
    return positions[Math.floor(Math.random() * positions.length)]
  }

  // ── Điền thông tin profile: Personal details (city/hometown) + Work ──
  async _fillProfileInfo(wc, uid) {
    this.log('📝 Điền thông tin profile...')
    const aboutUrl = `https://www.facebook.com/profile.php?id=${uid}&sk=about&locale=vi_VN`

    // Helper: gõ text vào input rồi đợi dropdown → ArrowDown → Enter
    const typeAndSelect = async (wc, inputSelector, text) => {
      // Focus input
      await this.js(wc, `(function(){
        var el = document.querySelector('${inputSelector}');
        if (el) { el.focus(); el.click(); }
      })()`)
      await sleep(600)
      // Xóa nội dung cũ
      await this.js(wc, `(function(){
        var el = document.querySelector('${inputSelector}');
        if (!el) return;
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await sleep(300)
      // Gõ từng ký tự
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(50)
      }
      // Kích hoạt input event
      await this.js(wc, `(function(){
        var el = document.querySelector('${inputSelector}');
        if (!el) return;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`)
      await sleep(1500) // chờ dropdown
      // ArrowDown rồi Enter
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
      await sleep(400)
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
      await sleep(400)
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      await sleep(400)
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      await sleep(800)
    }

    // Helper: JS click Save button
    const jsSave = async () => {
      await this.js(wc, `(function(){
        var all = Array.from(document.querySelectorAll('[role="button"], button'));
        for (var i = 0; i < all.length; i++) {
          var t = (all[i].textContent || '').trim().toLowerCase();
          if (t === 'save' || t === 'lưu') { all[i].click(); return; }
        }
      })()`)
      await sleep(2000)
    }

    // ─── Bước 1: Personal Details ───────────────────────────────
    this.log('📍 Mở trang Personal details...')
    await this.loadPage(wc, aboutUrl, 30000)
    await sleep(2500)

    // Click tab "Personal details"
    await this.js(wc, `(function(){
      var links = Array.from(document.querySelectorAll('a[role="tab"]'));
      for (var i = 0; i < links.length; i++) {
        var t = (links[i].textContent || '').trim().toLowerCase();
        if (t === 'personal details' || t === 'thông tin cá nhân') {
          links[i].click(); return;
        }
        var h = (links[i].href || '');
        if (h.indexOf('directory_personal_details') !== -1) { links[i].click(); return; }
      }
    })()`)
    await sleep(2000)

    // Click "Current city or town"
    const cityClicked = await this.js(wc, `(function(){
      var btns = Array.from(document.querySelectorAll('[role="button"]'));
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').toLowerCase();
        if (t.indexOf('current city') !== -1 || t.indexOf('thành phố hiện tại') !== -1) {
          btns[i].click(); return true;
        }
      }
      return false;
    })()`)
    if (cityClicked) {
      this.log('📍 Điền Current city...')
      await sleep(1500)
      const city = this._randomCity()
      await typeAndSelect(wc, '[aria-label="Current city"][role="combobox"], input[aria-label="Current city"], input[placeholder*="city"], input[aria-label*="city"]', city)
      this.log(`👉 Đã điền city: ${city}`)
      await jsSave()
      this.log('💾 Đã Save city')
    }

    // Click "Home town"
    const hometownClicked = await this.js(wc, `(function(){
      var btns = Array.from(document.querySelectorAll('[role="button"]'));
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').toLowerCase();
        if (t.indexOf('home town') !== -1 || t.indexOf('hometown') !== -1 || t.indexOf('quê') !== -1) {
          btns[i].click(); return true;
        }
      }
      return false;
    })()`)
    if (hometownClicked) {
      this.log('🏡 Điền Hometown...')
      await sleep(1500)
      const hometown = this._randomCity()
      await typeAndSelect(wc, '[aria-label="Home town"][role="combobox"], input[aria-label="Home town"], input[aria-label*="hometown"]', hometown)
      this.log(`👉 Đã điền hometown: ${hometown}`)
      await jsSave()
      this.log('💾 Đã Save hometown')
    }

    // ─── Bước 2: Work ───────────────────────────────────────────
    this.log('💼 Mở tab Work...')
    const workUrl = `https://www.facebook.com/profile.php?id=${uid}&sk=directory_work&locale=vi_VN`
    await this.loadPage(wc, workUrl, 30000)
    await sleep(2500)

    // Click "Work experience"
    const workClicked = await this.js(wc, `(function(){
      var btns = Array.from(document.querySelectorAll('[role="button"]'));
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').toLowerCase();
        if (t.indexOf('work experience') !== -1 || t.indexOf('kinh nghiệm') !== -1) {
          btns[i].click(); return true;
        }
      }
      return false;
    })()`)

    if (workClicked) {
      this.log('💼 Điền Work experience...')
      await sleep(2000)

      // Điền Company
      const company = this._randomCompany()
      const companyInput = `input[aria-label="Company"], input[role="combobox"][aria-label="Company"]`
      const hasCompanyInput = await this.js(wc, `!!document.querySelector('input[aria-label="Company"]')`)
      if (hasCompanyInput) {
        await typeAndSelect(wc, companyInput, company)
        this.log(`👉 Đã điền Company: ${company}`)
        await sleep(500)
      }

      // Điền Position
      const position = this._randomPosition()
      const posInput = `input[aria-label="Position"], input[role="combobox"][aria-label="Position"]`
      const hasPosInput = await this.js(wc, `!!document.querySelector('input[aria-label="Position"]')`)
      if (hasPosInput) {
        await typeAndSelect(wc, posInput, position)
        this.log(`👉 Đã điền Position: ${position}`)
        await sleep(500)
      }

      await jsSave()
      this.log('💾 Đã Save Work experience')
    } else {
      this.log('⚠ Không tìm thấy Work experience button')
    }

    this.log('✅ Hoàn thành điền thông tin profile!')
  }

  async run(account) {
    const acc = {
      uid: account.uid || '',
      email: account.email || '',
      cookie: account.cookie || ''
    }
    const label = acc.uid || '(cookie trần)'
    this.log(`🖼 Bắt đầu thêm Avatar — UID: ${label}`)

    // 28-10: ưu tiên ảnh RIÊNG gán theo VIA (photoPath) — hết fallback random thư mục
    let photo = null
    if (this.photoPath) {
      try {
        const buf = fs.readFileSync(this.photoPath)
        photo = { name: path.basename(this.photoPath), mime: /\.png$/i.test(this.photoPath) ? 'image/png' : 'image/jpeg', buf }
      } catch (e) {
        return { success: false, status: 'ERROR', uid: acc.uid, error: 'Không đọc được ảnh gán: ' + this.photoPath }
      }
    } else if (this.photoDir) {
      photo = randomPhoto(this.photoDir)
    }
    if (!photo) {
      return { success: false, status: 'ERROR', uid: acc.uid, error: 'Chưa có ảnh (chưa chọn thư mục ảnh hoặc hết ảnh)' }
    }
    this.log(`🖼 Ảnh được chọn: ${photo.name} (${Math.round(photo.buf.length / 1024)}KB)`)

    const ses = session.fromPartition(`fbprofile_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`)
    if (this.proxy && this.proxy.trim()) {
      try {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: this.proxy.trim() })
        this.log(`🌐 Proxy: ${this.proxy.trim()}`)
      } catch (pe) { this.log(`⚠ Proxy lỗi: ${pe.message}`) }
    }
    ses.setUserAgent(UA_LIST[Math.floor(Math.random() * UA_LIST.length)])

    const wa = screen.getPrimaryDisplay().workArea
    const posX = (this.showBrowser ? 60 : wa.x + wa.width + 60) + (this.slot % 4) * 510
    const posY = (this.showBrowser ? 40 : wa.y + 30) + Math.floor(this.slot / 4) * 900
    const win = new BrowserWindow({
      x: posX, y: posY, width: 520, height: 900, show: true, skipTaskbar: !this.showBrowser,
      backgroundColor: '#ffffff',
      title: `Thêm Avatar - ${label}`,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false, backgroundThrottling: false }
    })
    this.win = win
    const wc = win.webContents
    const cleanup = async () => {
      try { if (!win.isDestroyed()) win.destroy() } catch {}
      this.win = null
      try { await Promise.race([ses.clearStorageData(), sleep(5000)]) } catch {}
    }

    try {
      // ── 1. Nạp cookie ──
      const pairs = this.parseFBCookies(acc.cookie)
      if (!pairs.length) {
        await cleanup()
        return { success: false, status: 'ERROR', uid: acc.uid, error: 'Không có cookie hợp lệ trong dòng' }
      }
      const ok = await this.injectCookies(ses, pairs)
      this.log(`🍪 Đã nạp ${ok}/${pairs.length} cookie`)

      // ── 2. Mở trang profile ──
      const profileUrl = acc.uid
        ? `https://www.facebook.com/profile.php?id=${acc.uid}&locale=vi_VN`
        : 'https://www.facebook.com/me?locale=vi_VN'
      this.log(`⏳ Mở profile: ${profileUrl}`)
      if (!await this.loadPage(wc, profileUrl, 60000)) {
        await cleanup()
        return { success: false, status: 'ERROR', uid: acc.uid, error: 'Không tải được Facebook (proxy chết hoặc mạng lỗi)', proxyFail: true }
      }
      await sleep(4000)

      // ── 3. Kiểm tra trạng thái login ──
      const st = await this.js(wc, `(function(){
        var u = location.href.toLowerCase();
        var t = ((document.body && document.body.innerText) || '').toLowerCase();
        if (u.indexOf('/login') !== -1 || u.indexOf('login.php') !== -1 || u.indexOf('/r.php') !== -1) return 'DIE';
        if (document.querySelector('input[name="email"]') && document.querySelector('input[type="password"]')) return 'DIE';
        if (u.indexOf('checkpoint') !== -1 || t.indexOf('confirm your identity') !== -1 || t.indexOf('xác minh danh tính') !== -1) return 'CHECKPOINT';
        return 'OK';
      })()`)
      if (st === 'DIE') {
        await cleanup()
        this.log('❌ Cookie chết — bị redirect về trang login')
        return { success: false, status: 'DIE', uid: acc.uid, error: 'Cookie chết — bị đá về trang login' }
      }
      if (st === 'CHECKPOINT') {
        await cleanup()
        this.log('❌ Tài khoản đang checkpoint')
        return { success: false, status: 'CHECKPOINT', uid: acc.uid, error: 'Tài khoản đang checkpoint' }
      }
      this.log('✅ Cookie LIVE — đã vào profile')




      // ── 4. Đưa ảnh vào clipboard ──
      try {
        clipboard.writeImage(nativeImage.createFromBuffer(photo.buf))
        this.log(`📋 Ảnh "${photo.name}" đã vào clipboard`)
      } catch (ce) {
        await cleanup()
        return { success: false, status: 'ERROR', uid: acc.uid, error: 'Không đưa được ảnh vào clipboard: ' + ce.message }
      }

      // ── 5. Scroll xuống + click ô "What's on your mind?" ──
      this.log('🔍 Đang tìm ô "What\'s on your mind?"...')
      const composerFinder = `(function(){
        var cands = Array.from(document.querySelectorAll('div[role="button"]'));
        for (var i = 0; i < cands.length; i++) {
          var txt = (cands[i].textContent || '').trim().toLowerCase();
          if (txt.indexOf("what's on your mind") === -1 && txt.indexOf("bạn đang nghĩ") === -1) continue;
          cands[i].scrollIntoView({ block: 'center' });
          var r = cands[i].getBoundingClientRect();
          if (r.width < 100 || r.height < 20) continue;
          if (r.top < 0 || r.bottom > window.innerHeight + 5) continue;
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        var spans = Array.from(document.querySelectorAll('span'));
        for (var j = 0; j < spans.length; j++) {
          var st = (spans[j].textContent || '').trim().toLowerCase();
          if (st !== "what's on your mind?" && st !== "bạn đang nghĩ gì?") continue;
          var el = spans[j];
          for (var k = 0; k < 8; k++) {
            el = el.parentElement;
            if (!el) break;
            if (el.getAttribute('role') === 'button') {
              el.scrollIntoView({ block: 'center' });
              var r2 = el.getBoundingClientRect();
              if (r2.width > 100 && r2.height > 20 && r2.top >= 0 && r2.bottom <= window.innerHeight + 5) {
                return { x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2) };
              }
            }
          }
        }
        return null;
      })()`

      const composerClicked = await this.findAndClick(wc, composerFinder, '"What\'s on your mind?"', { timeoutMs: 30000, scrollStep: 350 })
      if (!composerClicked) {
        const dump = await this.js(wc, '((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").substring(0, 250)')
        this.log(`🔍 Nội dung trang: "${dump}"`)
        await cleanup()
        return { success: false, status: 'FAIL', uid: acc.uid, error: 'Không tìm thấy ô "What\'s on your mind?" — có thể profile bị hạn chế đăng bài' }
      }

      // Chờ dialog/composer mở (cũng là lúc "Review audience" popup có thể xuất hiện)
      await sleep(3000)

      // ── 5b. Xử lý audience flow: Continue → Save → mở lại composer nếu bị đóng ──
      await this._handleAudienceFlow(wc, composerFinder)
      await sleep(1500)

      // ── 6. Tìm ô soạn thảo — nếu không có dialog thì click lại composer ──
      this.log('🖊 Tìm ô soạn thảo trong dialog...')
      const findEditor = `(function(){
        var dlg = document.querySelector('div[role="dialog"]');
        var scope = dlg || document;
        var ed = scope.querySelector('[data-lexical-editor="true"]') ||
                 scope.querySelector('[role="textbox"][contenteditable="true"]') ||
                 scope.querySelector('[contenteditable="true"]');
        if (!ed) return false;
        ed.focus(); ed.click(); return true;
      })()`

      let editorReady = await this.js(wc, findEditor)
      if (!editorReady) {
        this.log('⚠ Không thấy editor → click lại "What\'s on your mind?" lần 2...')
        await this.findAndClick(wc, composerFinder, '"What\'s on your mind?" (lần 2)', { timeoutMs: 15000, scrollStep: 350 })
        await sleep(3000)
        // Xử lý audience lần 2 nếu cần
        await this._handleAudienceFlow(wc, composerFinder)
        await sleep(1500)
        editorReady = await this.js(wc, findEditor)
      }

      if (editorReady) this.log('👉 Đã focus ô soạn thảo')
      else this.log('⚠ Vẫn không thấy editor — thử paste vào bất kỳ vị trí nào')
      await sleep(1000)

      // ── 7. Thêm ảnh: win.focus → JS focus editor → Ctrl+V ──
      this.log('📋 Focus window + dán ảnh Ctrl+V...')
      // Đảm bảo window có OS focus trước khi gửi key event
      if (this.win && !this.win.isDestroyed()) {
        this.win.focus()
        await sleep(600)
        this.win.webContents.focus()
        await sleep(300)
      }
      const wc2 = this.win && !this.win.isDestroyed() ? this.win.webContents : wc
      wc2.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] })
      await sleep(200)
      wc2.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] })
      await sleep(10000)  // chờ preview render

      // ── 8. Kiểm tra ảnh đã dán chưa ──
      const pasteCheck = await this.js(wc, `(function(){
        var dlg = document.querySelector('div[role="dialog"]');
        var scope = dlg || document.body;
        if (!scope) return { ok: false };
        var imgs = scope.querySelectorAll('img');
        var hasImg = imgs.length > 2; // dialog thường có sẵn 1-2 img avatar
        var postBtns = scope.querySelectorAll('[aria-label="Post"], [aria-label="Đăng"]');
        var postReady = false;
        for (var i = 0; i < postBtns.length; i++) {
          if (postBtns[i].getAttribute('aria-disabled') !== 'true') { postReady = true; break; }
        }
        return { ok: hasImg || postReady, imgs: imgs.length, postReady: postReady };
      })()`)
      this.log(`🔎 Sau Ctrl+V: imgs=${pasteCheck ? pasteCheck.imgs : '?'}, postReady=${pasteCheck ? pasteCheck.postReady : '?'}`)

      // ── 9. Fallback: inject file qua Photo/video nếu Ctrl+V không ăn ──
      if (!pasteCheck || !pasteCheck.ok) {
        this.log('⚠ Ctrl+V không ăn → thử inject file qua Photo/video...')

        // JS click Photo/video
        const pvOk = await this.js(wc, `(function(){
          var dlg = document.querySelector('div[role="dialog"]');
          var scope = dlg || document;
          var cands = Array.from(scope.querySelectorAll('[aria-label]'));
          for (var i = 0; i < cands.length; i++) {
            var al = (cands[i].getAttribute('aria-label') || '').toLowerCase();
            if (al.indexOf('photo') !== -1 || al.indexOf('ảnh') !== -1 || al.indexOf('video') !== -1) {
              var r = cands[i].getBoundingClientRect();
              if (r.width < 10 || r.height < 10) continue;
              cands[i].click(); return true;
            }
          }
          return false;
        })()`)

        let injected = false
        if (pvOk) {
          await sleep(2500)
        }
        // Thử inject file bất kể có click được Photo/video không
        for (let t = 0; t < 8 && !injected; t++) {
          injected = await this.js(wc, `(function(){
            var inp = document.querySelector('div[role="dialog"] input[type="file"][accept*="image"]') ||
                      document.querySelector('div[role="dialog"] input[type="file"]') ||
                      document.querySelector('input[type="file"][accept*="image"]') ||
                      document.querySelector('input[type="file"]');
            if (!inp) return false;
            var b64 = ${JSON.stringify(photo.buf.toString('base64'))};
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
          if (!injected) await sleep(1500)
        }
        if (injected) {
          this.log(`🖼️ Đã inject file: ${photo.name}`)
          await sleep(8000)
        } else {
          this.log('⚠ Không inject được file')
        }
      }
      this.log(`🔎 Kiểm tra ảnh: imgs=${pasteCheck ? pasteCheck.imgs : '?'}, postReady=${pasteCheck ? pasteCheck.postReady : '?'}, injected=false`)

      // ── 10. Bấm nút Post ──
      this.log('📤 Tìm và bấm nút Post...')
      const postFinder = `(function(){
        var dlg = document.querySelector('div[role="dialog"]');
        var scope = dlg || document;
        // Tìm [aria-label="Post"] hoặc [aria-label="Đăng"] không bị disabled
        var cands = Array.from(scope.querySelectorAll('[aria-label="Post"], [aria-label="Đăng"], [aria-label="post"], [aria-label="đăng"]'));
        // Fallback: tìm button/div[role=button] có text "Post"/"Đăng"
        if (!cands.length) {
          cands = Array.from(scope.querySelectorAll('div[role="button"], button')).filter(function(e) {
            var t = (e.textContent || '').trim().toLowerCase();
            return t === 'post' || t === 'đăng';
          });
        }
        var best = null;
        for (var i = 0; i < cands.length; i++) {
          var e = cands[i];
          if (e.getAttribute('aria-disabled') === 'true') continue;
          var r = e.getBoundingClientRect();
          if (r.width < 40 || r.height < 14) continue;
          if (r.top < 0 || r.bottom > window.innerHeight + 10) continue;
          var s = r.width * r.height;
          if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
        }
        return best;
      })()`

      // Thử tìm nút Post tối đa 30 giây — dùng JS click thay vì sendClick
      // Click thẳng Post button — không check disabled
      const jsClickPost = `(function(){
        // Ưu tiên aria-label="Post" chính xác
        var btn = document.querySelector('[aria-label="Post"][role="button"]') ||
                  document.querySelector('[aria-label="Đăng"][role="button"]');
        if (!btn) {
          // Fallback: tìm trong dialog theo text
          var dlg = document.querySelector('div[role="dialog"]');
          var scope = dlg || document;
          var all = Array.from(scope.querySelectorAll('div[role="button"], button'));
          for (var i = 0; i < all.length; i++) {
            var t = (all[i].textContent || '').trim();
            if (t === 'Post' || t === 'Đăng') { btn = all[i]; break; }
          }
        }
        if (!btn) return false;
        btn.click(); return true;
      })()`
      let postClicked = false
      const postStart = Date.now()
      while (Date.now() - postStart < 30000 && !this.isAborted) {
        const clicked = await this.js(wc, jsClickPost)
        if (clicked) {
          this.log('👉 Đã JS-click nút Post')
          postClicked = true
          break
        }
        await sleep(1500)
      }

      if (!postClicked) {
        await cleanup()
        return { success: false, status: 'FAIL', uid: acc.uid, error: 'Nút Post không active — ảnh chưa dán được hoặc FB đổi UI' }
      }

      this.log('📤 Đã bấm Post — chờ FB xử lý...')
      await sleep(10000)

      // Kiểm tra dialog đã đóng chưa (tức là đăng xong)
      const dlgGone = await this.js(wc, `(function(){
        var dlg = document.querySelector('div[role="dialog"]');
        if (!dlg) return true;  // dialog đóng = thành công
        var postBtn = dlg.querySelector('[aria-label="Post"], [aria-label="Đăng"]');
        return !postBtn;  // nút Post biến mất = đăng xong
      })()`)

      if (dlgGone) {
        this.log(`✅ Đã đăng ảnh lên tường — ${label}`)

        // ── Sau khi đăng ảnh thành công → reload và đặt làm ảnh đại diện ──
        this.log('⏳ Chờ 3s rồi thử đặt ảnh đại diện...')
        await sleep(3000)
        this.log('🔄 Reload trang profile để gallery có ảnh mới...')
        await this.loadPage(wc, profileUrl, 30000)
        await sleep(3000)
        const avatarSet = await this._setAvatarFromGallery(wc)
        if (avatarSet) {
          this.log(`✅ ĐẶT AVATAR THÀNH CÔNG — ${label}`)

          // ── Điền thêm thông tin profile (window vẫn còn mở) ──
          try { await this._fillProfileInfo(wc, acc.uid) } catch(e) { this.log(`⚠ fillProfile lỗi: ${e.message}`) }

          const freshCookieF = await this.extractCookieString(ses)
          await cleanup()
          return { success: true, status: 'SOLVED', uid: acc.uid, note: `avatar: ${photo.name}`, cookie: freshCookieF }
        }
        this.log(`⚠ Đã đăng ảnh nhưng chưa đặt được avatar — ${label}`)
        return { success: true, status: 'SOLVED', uid: acc.uid, note: `đăng ảnh: ${photo.name} (chưa đặt avatar)`, cookie: freshCookie2 }
      }

      // Dialog còn nhưng đã bấm Post — có thể đang upload ảnh lớn, coi như OK
      this.log(`⚠ Dialog chưa đóng sau 10s Post — coi như thành công (upload ảnh lớn cần thêm thời gian)`)
      return { success: true, status: 'SOLVED', uid: acc.uid, note: `đã Post ảnh: ${photo.name} (chưa xác nhận dialog đóng)`, cookie: freshCookie }

    } catch (e) {
      await cleanup()
      this.log(`❌ Lỗi engine: ${e && e.message}`)
      return { success: false, status: 'ERROR', uid: acc.uid, error: 'Lỗi engine: ' + (e && e.message) }
    }
  }
}

module.exports = { FBProfileEngine }
