const { app, BrowserWindow, session } = require("electron")
const fs = require("fs")

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Ten owner cho modal tao BM (cung phong cach Auto Reg)
const FIRST_NAMES = [
  "Anh", "Binh", "Chau", "Dung", "Duc", "Duong", "Giang", "Ha", "Hai", "Hieu",
  "Hoang", "Huy", "Hung", "Khanh", "Khoi", "Linh", "Long", "Minh", "Nam", "Nghia",
  "Phong", "Phuc", "Quan", "Quang", "Sang", "Son", "Tai", "Tam", "Thang", "Thanh"
]
const LAST_NAMES = [
  "Nguyen", "Tran", "Le", "Pham", "Hoang", "Huynh", "Phan", "Vu", "Vo", "Dang",
  "Bui", "Do", "Ho", "Ngo", "Dinh", "Cao", "Trinh", "Luong"
]
function randName(arr) { return arr[Math.floor(Math.random() * arr.length)] }

class FBBMEngine {
  constructor({ cookie, bmName, email, proxy, showBrowser, onLog }) {
    this.cookie      = cookie
    this.bmName      = bmName
    this.email       = email
    this.proxy       = proxy || null
    this.showBrowser = showBrowser !== false
    this.onLog       = onLog || (() => {})
    this.win         = null
    this.isAborted   = false
  }

  log(msg) { this.onLog(msg); console.log("[FBBM]", msg) }

  abort() {
    this.isAborted = true
    if (this.win && !this.win.isDestroyed()) { try { this.win.close() } catch {} }
    this.win = null
  }

  parseCookieString(rawCookie) {
    return rawCookie.split(";").map(p => p.trim()).filter(Boolean).map(pair => {
      const idx = pair.indexOf("=")
      return {
        name:  idx > -1 ? pair.substring(0, idx).trim() : pair.trim(),
        value: idx > -1 ? pair.substring(idx + 1).trim() : ""
      }
    }).filter(c => c.name)
  }

  async mouseClick(wc, x, y) {
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 })
    await sleep(80)
    wc.sendInputEvent({ type: "mouseUp",   x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 })
    await sleep(200)
  }

  // Lay toa do element theo selector
  async getCoords(wc, selector) {
    return wc.executeJavaScript(
      "(function(){var e=document.querySelector(" + JSON.stringify(selector) + ");" +
      "if(!e)return null;" +
      "e.scrollIntoView({block:'center'});" +
      "var r=e.getBoundingClientRect();" +
      "if(r.width===0||r.height===0)return null;" +
      "return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})();"
    ).catch(() => null)
  }

  // Cho selector xuat hien
  async waitForEl(wc, selector, timeout) {
    timeout = timeout || 15000
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (this.isAborted) return false
      const c = await this.getCoords(wc, selector).catch(() => null)
      if (c) return true
      await sleep(500)
    }
    return false
  }

  // Diem tra URL sau khi navigate
  async waitForUrlMatch(wc, fn, timeout) {
    timeout = timeout || 20000
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (fn(wc.getURL())) return true
      await sleep(400)
    }
    return false
  }

  // Load URL va cho finish-load
  async loadAndWait(url, timeout) {
    timeout = timeout || 30000
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(false), timeout)
      this.win.webContents.once("did-finish-load", () => { clearTimeout(t); resolve(true) })
      this.win.loadURL(url)
    })
  }

  // Click nut theo text (div[role=button] hoac button). exact=true: so khop chinh xac
  // (tranh nham "OK" vao "Continue with Facebook" chua chu 'ok')
  async clickByText(wc, texts, exact) {
    if (!Array.isArray(texts)) texts = [texts]
    const textArr = JSON.stringify(texts)
    const coords = await wc.executeJavaScript(
      "(function(){" +
      "var texts=" + textArr + ";var exact=" + (exact ? "true" : "false") + ";" +
      "var btns=Array.from(document.querySelectorAll('div[role=\"button\"],button,[role=\"button\"],input[type=\"submit\"]'));" +
      "for(var i=0;i<btns.length;i++){" +
      "  var t=(btns[i].textContent||btns[i].value||'').trim().replace(/\\s+/g,' ');" +
      "  for(var j=0;j<texts.length;j++){" +
      "    var hit=exact?(t.toLowerCase()===texts[j].toLowerCase()):(t.toLowerCase().indexOf(texts[j].toLowerCase())!==-1);" +
      "    if(hit){" +
      "      var r=btns[i].getBoundingClientRect();" +
      "      if(r.width>0&&r.height>0){btns[i].scrollIntoView({block:'center'});return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:t};}" +
      "    }" +
      "  }" +
      "}" +
      "return null;" +
      "})();"
    ).catch(() => null)
    return coords
  }

  // Phan lochi cac o input cua form tao BM theo NHAN (aria-label / aria-labelledby / placeholder / cha),
  // du ngon (EN/ES/VI/ID). Cau truc form FB: ten business (o 1) -> person name(s) (o giua) -> email (o cuoi).
  // Variant: 2 o (loginpage), 3 o (business/Your name/business email), 4 o (business/first/last/email).
  // Tra ve { name, fullName, first, last, email } - moi truong = {id,type,x,y,label} hoac null
  async findBmInputs(wc, dialogOnly) {
    const raw = await wc.executeJavaScript(`(function(){
      function visible(e){ var r=e.getBoundingClientRect(); return r.width>0 && r.height>0 }
      var dlg = ${dialogOnly ? '(document.querySelector(\'div[role="dialog"]\') || document.body)' : 'document.body'}
      var ins = Array.prototype.slice.call(dlg.querySelectorAll('input[type="text"], input[type="email"], input:not([type])')).filter(visible)
      function labelText(e){
        var L = (e.getAttribute('aria-label') || '').trim()
        if (L) return L
        // Modal Meta: label nam o aria-labelledby (aria-label + placeholder + cha deu rong)
        var ids = e.getAttribute('aria-labelledby') || ''
        if (ids) {
          var parts = []
          ids.split(' ').forEach(function(id){
            var le = document.getElementById(id)
            if (le && le.innerText) parts.push(le.innerText)
          })
          L = parts.join(' ').replace(/\\s+/g, ' ').trim()
          if (L) return L
        }
        L = (e.placeholder || '').trim()
        if (L) return L
        var p = e, guard = 0
        while (p && p !== dlg && guard < 6) {
          p = p.parentElement
          guard++
          if (!p) break
          var t = (p.innerText || '').replace(/\\s+/g, ' ').trim()
          if (t && t.length > 3 && t.length < 130 && p.querySelector('input')) return t
        }
        return ''
      }
      function info(e){
        e.scrollIntoView({block:'center'})
        var r = e.getBoundingClientRect()
        return { id: e.id || '', type: e.type || '', x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), label: labelText(e).substring(0, 90) }
      }
      var out = { name: null, fullName: null, first: null, last: null, email: null }
      var taken = []
      ins.forEach(function(e){
        var L = labelText(e).toLowerCase()
        var ph = (e.placeholder || '').toLowerCase()
        var it = null
        if (e.type === 'email' || /e-?mail|correo electr/.test(L)) it = 'email'
        else if (ph.indexOf('market') !== -1) it = 'name'
        else if (/business|negocio|doanh ngh|usaha|empresa/.test(L) && /name|nombre|tên|ten|nama|account|cuenta|tài kho/.test(L)) it = 'name'
        else if (/your name|tu nombre|nombre completo|full name|first and last|tên của bạn|ten cua ban|họ tên|ho ten|nama lengkap/.test(L)) it = 'fullName'
        else if (/first name/.test(L) || L === 'tên' || L === 'ten') it = 'first'
        else if (/last name|apellido/.test(L) || L === 'họ' || L === 'ho') it = 'last'
        else if (/business|negocio|doanh ngh|usaha|empresa/.test(L)) it = 'name'
        else if (/search|buscar|tìm kiếm|tim kiem/.test(L)) it = null
        if (!it) return
        if (!out[it]) { out[it] = info(e); taken.push(e) }
      })
      function untaken(){
        return ins.filter(function(e){
          if (/search|buscar|tìm kiếm|tim kiem/.test(labelText(e).toLowerCase())) return false
          return taken.indexOf(e) === -1
        })
      }
      // Email = o chua phan loai CUOI CUNG (email luon o cuoi form FB: ten business / ho ten / email)
      if (!out.email) {
        var rest = untaken()
        if (rest.length) { out.email = info(rest[rest.length - 1]); taken.push(rest[rest.length - 1]) }
      }
      // O con lai o giua = person name: 1 o -> "Your name"/"Tu nombre", 2 o -> first/last
      var rest2 = untaken()
      if (rest2.length === 1) out.fullName = info(rest2[0])
      else if (rest2.length >= 2) { out.first = info(rest2[0]); out.last = info(rest2[1]) }
      return JSON.stringify(out)
    })()`).catch(() => null)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  // Form tao BM ngay tren loginpage/overview: it nhat phai co o ten BM
  // Luon dung id dong (id dang js_2/js_d CO THE DOI giua cac lan render)
  async findBmFormTargets(wc) {
    const r = await this.findBmInputs(wc, false)
    return (r && r.name) ? r : null
  }

  // Dien 1 o bang toa do (method da test that: click -> Ctrl+A -> Backspace -> insertText -> verify theo id)
  async fillByCoords(wc, t, text, label) {
    if (!t || !t.id) { this.log("CANH BAO: Khong tim thay o " + label + "!"); return false }
    const idSel = "input#" + t.id.replace(/([^\w-])/g, "\\$1")
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (this.isAborted) return false
      try {
        await this.mouseClick(wc, t.x, t.y)
        await sleep(250)
        wc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] })
        wc.sendInputEvent({ type: "keyUp",   keyCode: "A", modifiers: ["control"] })
        await sleep(60)
        wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" })
        wc.sendInputEvent({ type: "keyUp",   keyCode: "Backspace" })
        await sleep(60)
        await wc.insertText(String(text))
        await sleep(600)
      } catch (e) { this.log("LOI dien " + label + ": " + e.message) }

      const val = await wc.executeJavaScript(
        "(function(){var e=document.querySelector(" + JSON.stringify(idSel) + ");return e?e.value:null;})();"
      ).catch(() => null)

      if (val === String(text)) {
        this.log("[OK] " + label + " da dien: " + text)
        return true
      }

      // Du phong: JS focus + insertText
      await wc.executeJavaScript(
        "(function(){var e=document.querySelector(" + JSON.stringify(idSel) + ");if(e){e.focus();if(e.select)e.select();}})();"
      ).catch(() => {})
      await wc.insertText(String(text))
      await sleep(600)
      const val2 = await wc.executeJavaScript(
        "(function(){var e=document.querySelector(" + JSON.stringify(idSel) + ");return e?e.value:null;})();"
      ).catch(() => null)
      if (val2 === String(text)) {
        this.log("[OK] " + label + " da dien (fallback focus)")
        return true
      }

      // Cap nhat toa do moi (trang co the re-render lam lech toa do)
      const fresh = await wc.executeJavaScript(
        "(function(){var e=document.querySelector(" + JSON.stringify(idSel) + ");if(!e)return null;e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})();"
      ).catch(() => null)
      if (fresh) { t.x = fresh.x; t.y = fresh.y }
      this.log("[WARN] " + label + " lan " + attempt + " that bai")
      await sleep(800)
    }
    this.log("[ERR] " + label + " KHONG dien duoc!")
    return false
  }

  // Poll cho form tao BM render (form render tre tuy lan)
  async pollBmFormTargets(wc, timeoutMs) {
    const start = Date.now()
    let targets = null
    while (Date.now() - start < timeoutMs) {
      if (this.isAborted) return null
      targets = await this.findBmFormTargets(wc)
      if (targets && targets.name && targets.email) return targets
      await sleep(1000)
    }
    return (targets && targets.name) ? targets : null
  }

  // Tim element theo data-surface (chua chuoi con), chi nhan nut KHONG disabled
  async findDataSurfaceBtn(wc, substr) {
    return wc.executeJavaScript(
      "(function(){" +
      "var sub=" + JSON.stringify(substr) + ";" +
      "var els=Array.prototype.slice.call(document.querySelectorAll('[data-surface]'));" +
      "for(var i=0;i<els.length;i++){" +
      "  var s=els[i].getAttribute('data-surface')||'';" +
      "  if(s.indexOf(sub)===-1)continue;" +
      "  if(els[i].getAttribute('aria-disabled')==='true')continue;" +
      "  var r=els[i].getBoundingClientRect();" +
      "  if(r.width>0&&r.height>0){els[i].scrollIntoView({block:'center'});return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),surface:s};}" +
      "}" +
      "return null;})();"
    ).catch(() => null)
  }

  // Modal "Create a business portfolio" / dialog tao BM trong trang: it nhat phai co o ten business
  async findPortfolioModalTargets(wc) {
    const r = await this.findBmInputs(wc, true)
    return (r && r.name) ? r : null
  }

  // Mo dropdown chon portfolio goc tren trai (nut ten BM hien tai, data-surface chua business_scope)
  // data-surface-wrapper la display:contents (rect 0x0) nen phai leo len ancestor co kich thuoc that
  async openScopingDropdown(wc) {
    const r = await wc.executeJavaScript(
      "(function(){" +
      "var els=Array.prototype.slice.call(document.querySelectorAll('[data-surface*=\"business_scope\"]'));" +
      "for(var i=0;i<els.length;i++){" +
      "  var t=els[i];var r=t.getBoundingClientRect();var guard=0;" +
      "  while((r.width===0||r.height===0)&&t.parentElement&&guard<6){t=t.parentElement;r=t.getBoundingClientRect();guard++;}" +
      "  if(r.width>0&&r.height>0){t.scrollIntoView({block:'center'});return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),s:els[i].getAttribute('data-surface')||''};}" +
      "}" +
      "return null;})();"
    ).catch(() => null)
    if (!r) return false
    this.log("Mo dropdown portfolio: " + String(r.s).substring(0, 70))
    await this.mouseClick(wc, r.x, r.y)
    return true
  }

  // Account da co BM: tao them BM moi qua modal tren bizweb home
  // (flow that 17-10: click selector BM goc trai -> Create a business portfolio -> dien 4 o -> Create -> Next -> Next -> Confirm)
  async createPortfolioViaModal(wc, existingBmId) {
    // 1. Mo dropdown scoping selector roi click "Create a business portfolio"
    // (menu render tre/khong deu: chu ky = mo -> cho -> tim data-surface -> tim text -> bam lai opener)
    let clicked = false
    for (let cycle = 0; cycle < 4 && !clicked; cycle++) {
      if (this.isAborted) return { status: "ABORTED" }
      const opened = await this.openScopingDropdown(wc)
      if (!opened && cycle === 0) {
        const byText = await this.clickByText(wc, ["Create a business portfolio"], true)
        if (byText) {
          this.log("Click theo text: " + byText.text)
          await this.mouseClick(wc, byText.x, byText.y)
          clicked = true
          break
        }
      }
      for (let k = 0; k < 6 && !clicked; k++) {
        if (this.isAborted) return { status: "ABORTED" }
        const btn = await this.findDataSurfaceBtn(wc, "scope_selector_create_biz_portfolio_button")
        if (btn) {
          this.log("Click 'Create a business portfolio'")
          await this.mouseClick(wc, btn.x, btn.y)
          clicked = true
          break
        }
        if (k >= 2) {
          const byText = await this.clickByText(wc, ["Create a business portfolio"], true)
          if (byText) {
            this.log("Click theo text: " + byText.text)
            await this.mouseClick(wc, byText.x, byText.y)
            clicked = true
            break
          }
        }
        await sleep(1200)
      }
      if (!clicked && cycle < 3) await sleep(1000)
    }
    if (!clicked) return { status: "FAILED", reason: "Khong mo duoc dropdown / khong thay nut 'Create a business portfolio'" }
    await sleep(2500)

    // Doc text trang (dung de bat message loi FB: limit, deny, ...)
    const pageTextNow = async () => {
      const t = await wc.executeJavaScript("(document.body.innerText||'').replace(/\\s+/g,' ').substring(0,400);").catch(() => '')
      return (t || '').replace(/\s+/g, ' ').trim()
    }

    // 2. Cho form trong modal render (variant 3 o: ten business/Your name/business email, variant 4 o: ten/first/last/email)
    let targets = null
    for (let i = 0; i < 20 && !targets; i++) {
      if (this.isAborted) return { status: "ABORTED" }
      targets = await this.findPortfolioModalTargets(wc)
      if (!targets) await sleep(1000)
    }
    if (!targets) return { status: "FAILED", reason: "Modal tao BM khong hien o nhap ten business (co the dialog doi kieu moi)" }
    this.log(`Modal san sang: ten(${targets.name.id}${targets.name.label ? ' [' + targets.name.label + ']' : ''})` +
      (targets.fullName ? ` fullName(${targets.fullName.id} [${targets.fullName.label}])` : '') +
      (targets.first ? ` first(${targets.first.id})` : '') +
      (targets.last ? ` last(${targets.last.id})` : '') +
      ` email(${targets.email ? targets.email.id : 'KHONG TIM THAY'}${targets.email && targets.email.label ? ' [' + targets.email.label + ']' : ''})`)

    // 3. Dien form
    const firstName = randName(FIRST_NAMES)
    const lastName  = randName(LAST_NAMES)
    const okName  = await this.fillByCoords(wc, targets.name,  this.bmName, "Ten portfolio")
    await sleep(300)
    let okPerson = true
    if (targets.fullName) {
      // Dialog 3 o moi: "Your name" la 1 o duy nhat
      okPerson = await this.fillByCoords(wc, targets.fullName, firstName + ' ' + lastName, "Your name")
    } else if (targets.first && targets.last) {
      okPerson = await this.fillByCoords(wc, targets.first, firstName, "First name")
      await sleep(300)
      const okLast = await this.fillByCoords(wc, targets.last,  lastName, "Last name")
      okPerson = okPerson && okLast
    }
    await sleep(300)
    const okEmail = await this.fillByCoords(wc, targets.email, this.email, "Email")
    if (!okName || !okPerson || !okEmail) {
      return { status: "FAILED", reason: "Khong dien duoc modal tao BM (thieu 1 trong cac o)" }
    }

    // 4. Click Create
    let createBtn = null
    for (let i = 0; i < 10 && !createBtn; i++) {
      if (this.isAborted) return { status: "ABORTED" }
      createBtn = await this.findDataSurfaceBtn(wc, "business_portfolio_creation_modal_create_button")
      if (!createBtn) {
        createBtn = await this.clickByText(wc, ["Create", "Submit"], true)
      }
      if (!createBtn) await sleep(1000)
    }
    if (!createBtn) {
      const t = await pageTextNow()
      this.log("Trang khi thieu nut Create: " + t.substring(0, 160))
      return { status: "FAILED", reason: "Khong thay nut Create trong modal. Trang: " + t.substring(0, 140) }
    }
    this.log("Click Create...")
    await this.mouseClick(wc, createBtn.x, createBtn.y)
    await sleep(4000)

    // 5. Next -> Next -> Confirm (exact text; nut step co tre nen doi toi da 25s/buoc)
    const steps = [
      { texts: ["Next", "Tiếp theo", "Tiep theo"], label: "Next 1" },
      { texts: ["Next", "Tiếp theo", "Tiep theo"], label: "Next 2" },
      { texts: ["Confirm", "Xác nhận", "Xac nhan"], label: "Confirm" }
    ]
    for (const st of steps) {
      let c = null
      for (let i = 0; i < 25 && !c; i++) {
        if (this.isAborted) return { status: "ABORTED" }
        c = await this.clickByText(wc, st.texts, true)
        if (!c) await sleep(1000)
      }
      if (!c) {
        const t = await pageTextNow()
        this.log("Trang sau Create (thieu nut " + st.label + "): " + t.substring(0, 160))
        return { status: "FAILED", reason: "Khong thay nut " + st.label + " sau khi Create (co the bi limit / tu choi). Trang: " + t.substring(0, 140) }
      }
      this.log("Click " + st.label + ": " + c.text)
      await this.mouseClick(wc, c.x, c.y)
      await sleep(3500)
    }

    // 6. Ket qua: BM moi thi URL doi sang business_id khac BM cu
    let finalUrl = wc.getURL()
    for (let i = 0; i < 20; i++) {
      if (this.isAborted) break
      finalUrl = wc.getURL()
      const m = finalUrl.match(/business_id=(\d{10,20})/)
      if (m && m[1] !== existingBmId) break
      await sleep(1000)
    }
    const m = finalUrl.match(/business_id=(\d{10,20})/)
    const newBmId = (m && m[1] !== existingBmId) ? m[1] : null
    const pageText = await wc.executeJavaScript("(document.body.innerText||'').replace(/\\s+/g,' ').substring(0,400);").catch(() => '')
    this.log("URL cuoi: " + finalUrl)
    if (newBmId) this.log("BM MOI ID: " + newBmId)

    let status = "SUCCESS", reason = "Da tao BM moi qua modal (cho xac minh email neu co)"
    if (pageText && /something went wrong|try again later/i.test(pageText)) {
      status = "FAILED"
      reason = "Tao BM bi tu choi: " + pageText.substring(0, 120)
    }
    return { status, reason, bmId: newBmId, finalUrl }
  }

  async createBM() {
    if (this.isAborted) return { status: "ABORTED" }
    this.log("=== TAO BM: " + this.bmName + " | " + this.email + " ===")

    // Tao session rieng
    const pid = "bm" + Date.now()
    const bmSess = session.fromPartition("persist:" + pid)
    if (this.proxy) await bmSess.setProxy({ proxyRules: this.proxy })

    // Inject cookie
    this.log("Inject cookie...")
    const pairs = this.parseCookieString(this.cookie)
    const urls = ["https://www.facebook.com", "https://business.facebook.com"]
    for (const c of pairs) {
      for (const url of urls) {
        await bmSess.cookies.set({ url, name: c.name, value: c.value, domain: ".facebook.com", path: "/", secure: true, httpOnly: false, sameSite: "no_restriction", expirationDate: Math.floor(Date.now()/1000)+86400*365 }).catch(() => {})
      }
    }
    await bmSess.cookies.flushStore()
    this.log("Inject xong " + pairs.length + " cookies")

    this.win = new BrowserWindow({ width: 1280, height: 900, show: this.showBrowser, webPreferences: { session: bmSess, nodeIntegration: false, contextIsolation: false } })
    const wc = this.win.webContents

    const closeWin = async () => {
      await sleep(300)
      try { if (!this.win || this.win.isDestroyed()) return; this.win.close() } catch {}
      this.win = null
    }

    try {
      // ── BUOC 1: Vao facebook.com xac nhan cookie ──
      this.log("Vao facebook.com de xac nhan cookie...")
      await this.loadAndWait("https://www.facebook.com/", 25000)
      await sleep(3000)

      const fbUrl = wc.getURL()
      this.log("FB URL: " + fbUrl)
      if (fbUrl.includes("/login") || fbUrl.includes("/checkpoint/")) {
        await closeWin()
        return { status: fbUrl.includes("checkpoint") ? "CHECKPOINT" : "DEAD", reason: "Cookie het han" }
      }
      this.log("Cookie OK - da dang nhap facebook.com")

      // ── BUOC 2: Vao business.facebook.com ──
      this.log("Vao business.facebook.com...")
      await this.loadAndWait("https://business.facebook.com/", 25000)
      await sleep(4000)

      if (this.isAborted) { await closeWin(); return { status: "ABORTED" } }

      let bmUrl = wc.getURL()
      this.log("BM URL: " + bmUrl)

      // FB dua thang vao BM home (business_id=...: da co BM) hoac personal home
      // (asset_id=...: chua co BM, scope ca nhan) -> deu tao BM moi qua modal dropdown
      const exMatch = bmUrl.match(/business_id=(\d{10,20})/)
      if (exMatch || bmUrl.includes("asset_id=")) {
        if (exMatch) {
          this.log("Account da co BM san (ID: " + exMatch[1] + ") - tao them BM moi qua modal...")
        } else {
          this.log("Home ca nhan (chua co BM) - tao BM moi qua dropdown 'Create a business portfolio'...")
        }
        const r = await this.createPortfolioViaModal(wc, exMatch ? exMatch[1] : null)
        await closeWin()
        return { status: r.status, reason: r.reason, bmName: this.bmName, email: this.email, bmId: r.bmId || null, finalUrl: r.finalUrl }
      }

      // ── BUOC 3: Loginpage = form tao BM nhung san trong trang (da test that 14-10) ──
      // FB phuc vu bien the trang thieu form khong on dinh (cung cookie, cung URL: lan co lan khong)
      // => ladder: poll 20s -> Continue -> poll 15s -> reload URL -> poll 15s -> Continue -> poll 15s
      if (bmUrl.includes("loginpage") || bmUrl.includes("/login")) {
        let targets = await this.pollBmFormTargets(wc, 20000)

        for (let round = 1; round <= 2 && (!targets || !targets.name || !targets.email); round++) {
          if (round === 2) {
            this.log("Lan 2: reload lai loginpage de xin form...")
            await this.loadAndWait(bmUrl, 25000).catch(() => {})
            await sleep(4000)
            targets = await this.pollBmFormTargets(wc, 15000)
            if (targets && targets.name && targets.email) break
            bmUrl = wc.getURL()
          }
          this.log("Loginpage chua co form - thu click 'Continue with Facebook'...")
          const cfCoords = await this.clickByText(wc, ["Continue with Facebook", "Tiep tuc voi Facebook", "Log in with Facebook"])
          if (cfCoords) {
            this.log("Click: " + cfCoords.text)
            await this.mouseClick(wc, cfCoords.x, cfCoords.y)
            // Cho toi da 15s: form xh / url thoat loginpage / dialog "Continue as" xh thi click
            let clickedAs = false
            for (let i = 0; i < 15; i++) {
              if (this.isAborted) break
              await sleep(1000)
              const u = wc.getURL()
              if (!u.includes("loginpage") && !u.includes("/login")) break
              if (!clickedAs) {
                const asBtn = await this.clickByText(wc, ["Continue as", "Tiep tuc voi tu cach"])
                if (asBtn) { this.log("Click: " + asBtn.text); clickedAs = true; await sleep(3000) }
              }
              const t2 = await this.findBmFormTargets(wc)
              if (t2 && t2.name && t2.email) { targets = t2; break }
            }
          } else {
            this.log("CANH BAO: Khong tim thay nut 'Continue with Facebook'!")
          }
          this.log("URL sau Continue: " + wc.getURL())
        }

        if (!targets || !targets.name || !targets.email) {
          await closeWin()
          return { status: "FAILED", reason: "Loginpage khong co form tao BM sau moi cach thu (poll/Continue/reload)" }
        }
        this.log("Form tao BM san sang - dien truc tiep")
      }

      if (this.isAborted) { await closeWin(); return { status: "ABORTED" } }

      // ── BUOC 4: Neu da vao BM home (khong qua loginpage) -> tim nut Create ──
      bmUrl = wc.getURL()
      if (!bmUrl.includes("loginpage") && !bmUrl.includes("/login")) {
        this.log("Tim nut tao Business Manager tren BM home...")
        const createTexts = ["Create a business", "Create a Business", "Create business", "Tao Business", "Get started", "Create account", "Create a business portfolio"]
        let createCoords = await this.clickByText(wc, createTexts)
        if (!createCoords) {
          await this.loadAndWait("https://business.facebook.com/overview", 20000)
          await sleep(3000)
          createCoords = await this.clickByText(wc, createTexts)
        }
        if (createCoords) {
          this.log("Click: " + createCoords.text)
          await this.mouseClick(wc, createCoords.x, createCoords.y)
          await sleep(2500)
        }
      }

      // ── BUOC 5: Tim + dien form (ten BM + email) ──
      this.log("Tim form nhap ten BM + email...")
      let targets = await this.findBmFormTargets(wc)
      if (!targets || !targets.name || !targets.email) {
        // cho them lan nua - form co the render tre
        for (let i = 0; i < 10 && (!targets || !targets.name || !targets.email); i++) {
          await sleep(1000)
          if (this.isAborted) break
          targets = await this.findBmFormTargets(wc)
        }
      }

      if (!targets || !targets.name || !targets.email) {
        this.log("Khong tim thay form tao BM - co the tai khoan da co BM san!")
        await closeWin()
        return { status: "FAILED", reason: "Khong tim thay form tao BM (co the da co BM san hoac cookie khong du quyen)" }
      }
      this.log(`Thay form: o ten (id=${targets.name.id}${targets.name.label ? ' [' + targets.name.label + ']' : ''})` +
        (targets.fullName ? `, o Your name (id=${targets.fullName.id} [${targets.fullName.label}])` : '') +
        `, o email (id=${targets.email ? targets.email.id : 'KHONG TIM THAY'}${targets.email && targets.email.label ? ' [' + targets.email.label + ']' : ''})`)

      const okName  = await this.fillByCoords(wc, targets.name,  this.bmName, "Ten BM")
      await sleep(400)
      let okPerson = true
      const personName = randName(FIRST_NAMES) + ' ' + randName(LAST_NAMES)
      if (targets.fullName) {
        okPerson = await this.fillByCoords(wc, targets.fullName, personName, "Your name")
        await sleep(400)
      }
      const okEmail = await this.fillByCoords(wc, targets.email, this.email, "Email")

      if (this.isAborted) { await closeWin(); return { status: "ABORTED" } }

      // Verify giu gia tri sau 2s (form FB hay xoa gia tri)
      const watchIds = [targets.name.id]
      if (targets.fullName && targets.fullName.id) watchIds.push(targets.fullName.id)
      if (targets.email && targets.email.id) watchIds.push(targets.email.id)
      await sleep(2000)
      const persist = await wc.executeJavaScript(
        "(function(){var o={};['" + watchIds.join("','") + "'].forEach(function(id){var e=document.querySelector('input#'+CSS.escape(id));if(e)o[id]=e.value;});return JSON.stringify(o);})();"
      ).catch(() => null)
      if (persist) this.log("Kiem tra giu gia tri: " + persist)

      let persistObj = {}
      try { persistObj = JSON.parse(persist || "{}") } catch {}
      if (persistObj[targets.name.id] !== this.bmName) {
        this.log("Gia tri ten bi mat - dien lai...")
        await this.fillByCoords(wc, targets.name, this.bmName, "Ten BM (lan 2)")
      }
      if (targets.fullName && targets.fullName.id && persistObj[targets.fullName.id] !== personName) {
        this.log("Gia tri Your name sai/mat - dien lai...")
        await this.fillByCoords(wc, targets.fullName, personName, "Your name (lan 2)")
      }
      if (targets.email && targets.email.id && persistObj[targets.email.id] !== this.email) {
        this.log("Gia tri email bi mat - dien lai...")
        await this.fillByCoords(wc, targets.email, this.email, "Email (lan 2)")
      }

      if (!okName || !okPerson || !okEmail) {
        await closeWin()
        return { status: "FAILED", reason: "Khong dien duoc form tao BM" }
      }

      // ── BUOC 6: Click Submit ──
      this.log("Click Submit...")
      const submitCoords = await this.clickByText(wc, ["Submit", "Create Business", "Tiep theo", "Next"])
      if (submitCoords) {
        this.log("Click: " + submitCoords.text)
        await this.mouseClick(wc, submitCoords.x, submitCoords.y)
      } else {
        this.log("Khong thay nut Submit - thu nut cuoi cung visible...")
        const lastBtn = await wc.executeJavaScript(
          "(function(){var btns=Array.from(document.querySelectorAll('div[role=\"button\"],button,input[type=\"submit\"]')).filter(function(b){var r=b.getBoundingClientRect();return r.width>0&&r.height>0&&(b.textContent||b.value||'').trim();});if(!btns.length)return null;var b=btns[btns.length-1];var r=b.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:(b.textContent||b.value||'').trim()};})();"
        ).catch(() => null)
        if (lastBtn) {
          this.log("Click nut cuoi: " + lastBtn.text)
          await this.mouseClick(wc, lastBtn.x, lastBtn.y)
        }
      }

      await sleep(6000)
      if (this.isAborted) { await closeWin(); return { status: "ABORTED" } }

      // ── BUOC 7: Dialog xac nhan / Done (so khoo CHINH XAC de khong nham nut chua 'ok') ──
      const doneCoords = await this.clickByText(wc, ["Done", "OK", "Got it", "Finish", "Xac nhan", "Confirm"], true)
      if (doneCoords) {
        this.log("Click Done: " + doneCoords.text)
        await this.mouseClick(wc, doneCoords.x, doneCoords.y)
        await sleep(3000)
      }

      // Cho URL roi khoi loginpage toi da 15s
      let finalUrl = wc.getURL()
      for (let i = 0; i < 15 && (finalUrl.includes("loginpage") || finalUrl.includes("/login")); i++) {
        await sleep(1000)
        finalUrl = wc.getURL()
      }

      const pageText = await wc.executeJavaScript("(document.body.innerText||'').replace(/\\s+/g,' ').substring(0,600);").catch(() => '')
      this.log("Trang sau Submit: " + (pageText || '').substring(0, 200).replace(/\n/g, ' | '))
      this.log("URL cuoi: " + finalUrl)

      const bmIdMatch = finalUrl.match(/[?&/](\d{10,20})/)
      const bmId = bmIdMatch ? bmIdMatch[1] : null

      let status = "SUCCESS", reason = "Tao BM thanh cong"
      if (finalUrl.includes("loginpage") || finalUrl.includes("/login")) {
        const stillForm = await this.findBmFormTargets(wc)
        if (stillForm && stillForm.name) {
          status = "FAILED"; reason = "Submit khong duoc chap nhan (form van con tren trang)"
        } else if (pageText && /enter a valid|invalid|something went wrong|try again/i.test(pageText)) {
          status = "FAILED"; reason = "Submit bi tu choi: " + pageText.substring(0, 120)
        } else {
          reason = "Submit chap nhan (form da dong - cho xac minh email)"
        }
      }

      if (bmId) this.log("BM ID: " + bmId)
      this.log("KET QUA: " + status)

      await sleep(1500)
      await closeWin()
      return { status, reason, bmName: this.bmName, email: this.email, bmId, finalUrl }

    } catch(err) {
      this.log("LOI: " + err.message)
      await closeWin().catch(() => {})
      return { status: "ERROR", reason: err.message }
    }
  }
}

module.exports = { FBBMEngine }
