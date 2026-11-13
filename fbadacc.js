// Engine tao Ad Account trong BM (tab Account BM > menu con "Tao Account trong BM")
// Flow (user mo ta 14-10):
//   1. Vao business.facebook.com/latest/settings/ad_accounts?business_id=<BMID>
//   2. Click nut Add (data-surface ...add-asset-by-asset-type)
//   3. Click option "Create a new ad account"
//   4. Dien ten account (o text gan nut Next)
//   5. Chon Time zone (combobox co label "Time zone")
//   6. Chon Currency (combobox co label "Currency")
//   7. Click Next (data-surface ...fbs-settings-create-adaccount-info-next-button)
const { BrowserWindow, session } = require("electron")

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

class FBAdAccEngine {
  constructor({ cookie, businessId, accName, timezone, currency, proxy, showBrowser, onLog }) {
    this.cookie      = cookie
    this.businessId  = String(businessId || '').trim()
    this.accName     = accName || 'Ad Account'
    this.timezone    = timezone || '(GMT+07:00) Asia/Jakarta'
    this.currency    = currency || 'USD'
    this.proxy       = proxy || null
    this.showBrowser = showBrowser !== false
    this.onLog       = onLog || (() => {})
    this.win         = null
    this.isAborted   = false
  }

  log(msg) { this.onLog(msg); console.log("[AdAcc]", msg) }

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

  async loadAndWait(url, timeout) {
    timeout = timeout || 30000
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(false), timeout)
      this.win.webContents.once("did-finish-load", () => { clearTimeout(t); resolve(true) })
      this.win.loadURL(url)
    })
  }

  // Click nut theo text. exact=true: so khop chinh xac
  async clickByText(wc, texts, exact) {
    if (!Array.isArray(texts)) texts = [texts]
    const textArr = JSON.stringify(texts)
    return wc.executeJavaScript(
      "(function(){" +
      "var texts=" + textArr + ";var exact=" + (exact ? "true" : "false") + ";" +
      "function norm(s){s=String(s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/\\u0111/g,'d');return s.replace(/\\s+/g,' ');}" +
      "var btns=Array.from(document.querySelectorAll('div[role=\"button\"],button,[role=\"button\"],a[href],input[type=\"submit\"],[role=\"gridcell\"],[role=\"option\"]'));" +
      "for(var i=0;i<btns.length;i++){" +
      "  var t=norm(btns[i].textContent||btns[i].value||'');" +
      "  for(var j=0;j<texts.length;j++){" +
      "    var hit=exact?(t===norm(texts[j])):(t.indexOf(norm(texts[j]))!==-1);" +
      "    if(hit){" +
      "      var r=btns[i].getBoundingClientRect();" +
      "      if(r.width>0&&r.height>0){btns[i].scrollIntoView({block:'center'});return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:(btns[i].textContent||'').trim().substring(0,60)};}" +
      "    }" +
      "  }" +
      "}" +
      "return null;" +
      "})();"
    ).catch(() => null)
  }

  // Dump text cac nut/link dang hien de debug
  async dumpClickable(wc) {
    return wc.executeJavaScript(
      "(function(){" +
      "var out=[];" +
      "var els=document.querySelectorAll('a[href],button,[role=\"button\"],[role=\"link\"]');" +
      "for(var i=0;i<els.length;i++){" +
      "  var t=(els[i].textContent||'').trim().replace(/\\s+/g,' ');" +
      "  if(!t)continue;" +
      "  var r=els[i].getBoundingClientRect();" +
      "  if(r.width>0&&r.height>0&&out.indexOf(t)<0)out.push(t.substring(0,50));" +
      "  if(out.length>=15)break;" +
      "}" +
      "return out.join(' | ');})();"
    ).catch(() => "")
  }

  // Dien 1 o bang toa do (method da test that o fbbm): click -> Ctrl+A -> Backspace -> insertText -> verify
  async fillByCoords(wc, t, text, label) {
    if (!t) { this.log("CANH BAO: Khong tim thay o " + label + "!"); return false }
    const idSel = t.id ? "input#" + String(t.id).replace(/([^\w-])/g, "\\$1") : null
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

      let val = null
      if (idSel) {
        val = await wc.executeJavaScript(
          "(function(){var e=document.querySelector(" + JSON.stringify(idSel) + ");return e?e.value:null;})();"
        ).catch(() => null)
      }
      if (val === String(text)) {
        this.log("[OK] " + label + " da dien: " + text)
        return true
      }

      // Du phong: JS focus + insertText
      if (idSel) {
        await wc.executeJavaScript(
          "(function(){var e=document.querySelector(" + JSON.stringify(idSel) + ");if(e){e.focus();if(e.select)e.select();}})();"
        ).catch(() => {})
        await wc.insertText(String(text))
        await sleep(600)
        val = await wc.executeJavaScript(
          "(function(){var e=document.querySelector(" + JSON.stringify(idSel) + ");return e?e.value:null;})();"
        ).catch(() => null)
        if (val === String(text)) {
          this.log("[OK] " + label + " da dien (fallback focus)")
          return true
        }
      }

      // Cap nhat toa do moi
      if (idSel) {
        const fresh = await wc.executeJavaScript(
          "(function(){var e=document.querySelector(" + JSON.stringify(idSel) + ");if(!e)return null;e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})();"
        ).catch(() => null)
        if (fresh) { t.x = fresh.x; t.y = fresh.y }
      }
      this.log("[WARN] " + label + " lan " + attempt + " that bai")
      await sleep(800)
    }
    this.log("[ERR] " + label + " KHONG dien duoc!")
    return false
  }

  // Tim combobox theo text cua label (aria-labelledby -> label id -> textContent)
  // label: 'time zone' | 'currency' (lowercase)
  async findComboboxByLabel(wc, label) {
    const raw = await wc.executeJavaScript(
      "(function(){" +
      "var cbs=Array.prototype.slice.call(document.querySelectorAll('[role=\"combobox\"]'));" +
      "for(var i=0;i<cbs.length;i++){" +
      "  var refs=(cbs[i].getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean);" +
      "  for(var j=0;j<refs.length;j++){" +
      "    var l=document.getElementById(refs[j]);" +
      "    if(l && (l.textContent||'').trim().toLowerCase()===" + JSON.stringify(label) + "){" +
      "      var r=cbs[i].getBoundingClientRect();" +
      "      if(r.width>0&&r.height>0){cbs[i].scrollIntoView({block:'center'});r=cbs[i].getBoundingClientRect();" +
      "        return JSON.stringify({id:cbs[i].id||'',x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});}" +
      "    }" +
      "  }" +
      "}" +
      "return null;" +
      "})();"
    ).catch(() => null)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  // Mo combobox roi chon option co text chua want.
  // (1) dispatch JS events truc tiep len element option (khong dung toa do -> khong bi lech khi list animate/ao),
  // (2) fallback click toa do tai vi tri option,
  // Luon VERIFY text combobox sau khi chon - chi OK khi combobox chua want
  async pickOption(wc, combo, want, label) {
    // Dong dropdown con mo tu buoc truoc (KHONG dung Escape - no dong ca dialog)
    const closeDD = async () => {
      const open = await wc.executeJavaScript(
        "(function(){var lbs=document.querySelectorAll('[role=\"listbox\"]');" +
        "for(var i=0;i<lbs.length;i++){var r=lbs[i].getBoundingClientRect();if(r.width>0&&r.height>0)return true;}return false;})();"
      ).catch(() => false)
      if (open) { await comboClick(); await sleep(800) }
      return open
    }
    await closeDD()
    // Tra lai toa do moi cua combobox (form co the doi vi tri sau cac buoc truoc)
    const comboClick = async () => {
      if (combo.id) {
        const fr = await wc.executeJavaScript(
          "(function(){var e=document.getElementById(" + JSON.stringify(combo.id) + ");if(!e)return null;var r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))return null;return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})();"
        ).catch(() => null)
        if (fr) { try { const f = JSON.parse(fr); combo.x = f.x; combo.y = f.y } catch {} }
      }
      await this.mouseClick(wc, combo.x, combo.y)
    }
    await comboClick()
    await sleep(1200)
    // Listbox chua xổ -> click lan nua (lan 1 co the chi dong dropdown cu)
    let lbOpen = await wc.executeJavaScript(
      "(function(){var lbs=document.querySelectorAll('[role=\"listbox\"]');" +
      "for(var i=0;i<lbs.length;i++){var r=lbs[i].getBoundingClientRect();if(r.width>0&&r.height>0)return true;}return false;})();"
    ).catch(() => false)
    if (!lbOpen) { await comboClick(); await sleep(1200) }
    const wantLower = String(want).toLowerCase()

    // So khop bo qua _ va khoang trang + zero-width (FB hien "Asia/Ho Chi_Minh" thay "Asia/Ho_Chi_Minh")
    const NORM = "function norm(s){return String(s||'').toLowerCase().replace(/[\\u200b\\u200c\\u200d\\ufeff]/g,'').replace(/[_\\s]+/g,' ').trim();}"
    const wantNorm = "norm(" + JSON.stringify(String(want)) + ")"

    const comboText = async () => combo.id ? await wc.executeJavaScript(
      "(function(){var e=document.getElementById(" + JSON.stringify(combo.id) + ");return e?(e.textContent||'').trim().substring(0,80):null;})();"
    ).catch(() => null) : null

    const verified = async () => {
      const vt = await comboText()
      if (vt) {
        const ok = await wc.executeJavaScript(
          "(function(){" + NORM + "return norm(" + JSON.stringify(vt) + ").indexOf(norm(" + JSON.stringify(String(want)) + "))!==-1;})();"
        ).catch(() => false)
        if (ok) { this.log("[OK] " + label + " da chon: " + vt); return true }
      }
      return false
    }

    // Dispatch events len option (khong qua toa do)
    const dispatchOption = () => wc.executeJavaScript(
      "(function(){" + NORM + "var want=norm(" + JSON.stringify(String(want)) + ");" +
      "var ops=Array.prototype.slice.call(document.querySelectorAll('[role=\"option\"]'));" +
      "for(var i=0;i<ops.length;i++){" +
      "  var t=norm(ops[i].textContent);" +
      "  if(t.indexOf(want)!==-1){" +
      "    var el=ops[i];el.scrollIntoView({block:'center'});" +
      "    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(ty){" +
      "      try{el.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,composed:true,view:window,button:0}))}catch(e){}" +
      "    });" +
      "    return JSON.stringify({text:(el.textContent||'').trim().substring(0,60)});" +
      "  }" +
      "}" +
      "return null;" +
      "})();"
    ).catch(() => null)

    // Cuon listbox xuong 1 buoc (option ao chua vao DOM) - tra ve {scrolled,...}
    const scrollList = () => wc.executeJavaScript(
      "(function(){var lbs=Array.prototype.slice.call(document.querySelectorAll('[role=\"listbox\"]'));" +
      "for(var i=0;i<lbs.length;i++){" +
      "  var b=lbs[i];var old=b.scrollTop;b.scrollTop=old+600;" +
      "  if(b.scrollTop!==old)return JSON.stringify({scrolled:true,top:b.scrollTop,sh:b.scrollHeight});" +
      "}return JSON.stringify({scrolled:false});})();"
    ).catch(() => null)

    // Click vat ly tai vi tri option (tim lai element moi sau scroll de tranh lech)
    const physicalOption = async () => {
      const raw = await wc.executeJavaScript(
        "(function(){" + NORM + "var want=norm(" + JSON.stringify(String(want)) + ");" +
        "var ops=Array.prototype.slice.call(document.querySelectorAll('[role=\"option\"]'));" +
        "for(var i=0;i<ops.length;i++){" +
        "  var t=norm(ops[i].textContent);" +
        "  if(t.indexOf(want)!==-1){var r=ops[i].getBoundingClientRect();if(r.width>0&&r.height>0){return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});}}" +
        "}" +
        "return null;" +
        "})();"
      ).catch(() => null)
      if (!raw) return false
      let h = null; try { h = JSON.parse(raw) } catch {}
      if (!h) return false
      await this.mouseClick(wc, h.x, h.y)
      return true
    }

    // O search trong dropdown (FB cho go de loc) - dien bang JS native setter (React bat input event)
    const useSearch = async () => {
      const raw = await wc.executeJavaScript(
        "(function(){" +
        "function norm(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/\\u0111/g,'d');}" +
        "var lbs=document.querySelectorAll('[role=\"listbox\"]');" +
        "for(var i=0;i<lbs.length;i++){" +
        "  var p=lbs[i];" +
        "  for(var k=0;k<8&&p;k++,p=p.parentElement){" +
        "    var ins=p.querySelectorAll('input,[role=\"searchbox\"]');" +
        "    for(var j=0;j<ins.length;j++){" +
        "      var el=ins[j];var r2=el.getBoundingClientRect();" +
        "      if(r2.width>0&&r2.height>0&&(el.tagName==='INPUT'||el.getAttribute('role')==='searchbox')){" +
        "        el.focus();" +
        "        var want=" + JSON.stringify(String(want)) + ";" +
        "        try{" +
        "          var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;" +
        "          d.call(el,want);" +
        "          el.dispatchEvent(new Event('input',{bubbles:true}));" +
        "          el.dispatchEvent(new Event('change',{bubbles:true}));" +
        "        }catch(e){el.value=want;el.dispatchEvent(new Event('input',{bubbles:true}));}" +
        "        var ok=(el.value||'').indexOf(want)!==-1;" +
        "        return JSON.stringify({filled:ok});" +
        "      }" +
        "    }" +
        "  }" +
        "}" +
        "return JSON.stringify({filled:false,none:true});})();"
      ).catch(() => null)
      let h = null; try { h = raw ? JSON.parse(raw) : null } catch {}
      if (h && h.none) this.log("Khong thay o search trong " + label)
      if (h && h.filled) this.log("Da go '" + want + "' vao o search cua " + label)
      return !!(h && h.filled)
    }

    // Chon option DAU TIEN trong list (sau khi search loc thi dung se nam dau)
    const pickFirstOption = async () => {
      const raw = await wc.executeJavaScript(
        "(function(){var ops=document.querySelectorAll('[role=\"option\"]');" +
        "for(var i=0;i<ops.length;i++){" +
        "  var r=ops[i].getBoundingClientRect();" +
        "  if(r.width>0&&r.height>0){" +
        "    var el=ops[i];el.scrollIntoView({block:'center'});" +
        "    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(ty){" +
        "      try{el.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,composed:true,view:window,button:0}))}catch(e){}" +
        "    });" +
        "    return JSON.stringify({text:(el.textContent||'').trim().substring(0,60)});" +
        "  }" +
        "}return null;})();"
      ).catch(() => null)
      let h = null; try { h = raw ? JSON.parse(raw) : null } catch {}
      if (h) this.log("Chon option dau: " + h.text)
      return !!h
    }

    // Go bang phim (typeahead cua ARIA listbox): nhan ky tu -> Enter chon
    const typeahead = async () => {
      try {
        const s = String(want)
        for (let i = 0; i < Math.min(s.length, 14); i++) {
          await wc.sendInputEvent({ type: 'char', keyCode: s[i] })
          await sleep(90)
        }
        await sleep(1200)
        await wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        await wc.sendInputEvent({ type: 'char', keyCode: 'Enter' })
        await wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        await sleep(1500)
        return true
      } catch { return false }
    }

    // Dong dropdown dang mo (click combobox, khong dung Escape - no dong ca dialog)
    const closeDropdown = async () => {
      const open = await wc.executeJavaScript(
        "(function(){var lbs=document.querySelectorAll('[role=\"listbox\"]');" +
        "for(var i=0;i<lbs.length;i++){var r=lbs[i].getBoundingClientRect();if(r.width>0&&r.height>0)return true;}return false;})();"
      ).catch(() => false)
      if (open) { await comboClick(); await sleep(800) }
    }

    // 1 luot: dispatch option (cuon dan den khi thay), verify, fallback click vat ly
    const searchAndPick = async () => {
      for (let s = 0; s < 40; s++) {
        if (this.isAborted) return false
        const d = await dispatchOption()
        if (d) {
          await sleep(900)
          if (await verified()) return true
          await physicalOption()
          await sleep(900)
          if (await verified()) return true
        }
        const sc = await scrollList()
        await sleep(250)
        let p = null; try { p = sc ? JSON.parse(sc) : null } catch {}
        if (p && !p.scrolled) return false // cuon het list van khong thay
      }
      return false
    }

    // Uu tien 1: go o search (list loc con 1-2 dong, dung se nam dau) -> chon option dau
    if (await useSearch()) {
      await sleep(1200)
      await pickFirstOption()
      await sleep(900)
      if (await verified()) return true
      await dispatchOption()
      await sleep(900)
      if (await verified()) return true
      await physicalOption()
      await sleep(900)
      if (await verified()) return true
      this.log("Search khong chon duoc " + label + " -> thu cach khac")
      await closeDropdown()
      await comboClick()
      await sleep(800)
      await comboClick()
      await sleep(1200)
    } else {
      // Khong co o search -> thu typeahead bang phim
      await typeahead()
      if (await verified()) return true
      await closeDropdown()
      await comboClick()
      await sleep(800)
      await comboClick()
      await sleep(1200)
    }

    // Chuan doan: listbox co cuon duoc khong, bao nhieu option dang co trong DOM
    const diag = await wc.executeJavaScript(
      "(function(){var lbs=document.querySelectorAll('[role=\"listbox\"]');var out=[];" +
      "for(var i=0;i<lbs.length;i++){out.push('lb'+i+':top='+lbs[i].scrollTop+',sh='+lbs[i].scrollHeight+',ch='+lbs[i].clientHeight+',opts='+lbs[i].querySelectorAll('[role=\"option\"]').length);}" +
      "return out.join(' | ')||'KO CO LISTBOX';})();"
    ).catch(() => null)
    this.log("Listbox: " + diag)

    // Uu tien 3: cuon dan tim option
    if (await searchAndPick()) return true

    // Lan 2: dong/mo lai combobox (FB render lai list) roi cuon tim tiep
    await comboClick()
    await sleep(800)
    await comboClick()
    await sleep(1200)
    if (await searchAndPick()) return true

    await closeDropdown()
    this.log("[ERR] Khong chon duoc " + label + " (verify combobox khong chua: " + want + ")")
    return false
  }

  async createAdAccount() {
    if (this.isAborted) return { status: "ABORTED" }
    this.log("=== TAO AD ACCOUNT TRONG BM " + this.businessId + ": " + this.accName + " ===")

    const pid = "adacc" + Date.now()
    const accSess = session.fromPartition("persist:" + pid)
    if (this.proxy) await accSess.setProxy({ proxyRules: this.proxy })

    this.log("Inject cookie...")
    const pairs = this.parseCookieString(this.cookie)
    const urls = ["https://www.facebook.com", "https://business.facebook.com"]
    for (const c of pairs) {
      for (const url of urls) {
        await accSess.cookies.set({ url, name: c.name, value: c.value, domain: ".facebook.com", path: "/", secure: true, httpOnly: false, sameSite: "no_restriction", expirationDate: Math.floor(Date.now()/1000)+86400*365 }).catch(() => {})
      }
    }
    await accSess.cookies.flushStore()
    this.log("Inject xong " + pairs.length + " cookies")

    this.win = new BrowserWindow({ width: 1280, height: 900, show: this.showBrowser, webPreferences: { session: accSess, nodeIntegration: false, contextIsolation: false } })
    const wc = this.win.webContents
    wc.setWindowOpenHandler(({ url }) => {
      this.log("Cua so popup mo: " + String(url || '').substring(0, 110))
      return { action: 'allow' }
    })

    const closeWin = async () => {
      await sleep(300)
      try { if (!this.win || this.win.isDestroyed()) return; this.win.close() } catch {}
      this.win = null
    }

    try {
      // ── BUOC 1: Xac nhan cookie ──
      this.log("Vao facebook.com de xac nhan cookie...")
      await this.loadAndWait("https://www.facebook.com/", 25000)
      await sleep(3000)
      const fbUrl = wc.getURL()
      if (fbUrl.includes("/login") || fbUrl.includes("/checkpoint/")) {
        await closeWin()
        return { status: fbUrl.includes("checkpoint") ? "CHECKPOINT" : "DEAD", reason: "Cookie het han" }
      }
      this.log("Cookie OK")

      // ── BUOC 2: Vao settings ad_accounts cua BM ──
      this.log("Vao settings ad_accounts cua BM " + this.businessId + "...")
      await this.loadAndWait("https://business.facebook.com/latest/settings/ad_accounts?business_id=" + this.businessId, 30000)
      await sleep(5000)
      if (this.isAborted) { await closeWin(); return { status: "ABORTED" } }

      const setUrl = wc.getURL()
      this.log("Settings URL: " + setUrl.substring(0, 120))
      if (setUrl.includes("loginpage") || setUrl.includes("/login")) {
        // Session business het han -> dang nhap business bang "Continue with Facebook"
        this.log("Bi dua ve loginpage - dump trang: " + await this.dumpClickable(wc))
        // Click JS truc tiep (sendInputEvent khong thay doi URL tren trang nay)
        const jsClick = await wc.executeJavaScript(
          "(function(){" +
          "function norm(s){s=String(s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/\\u0111/g,'d');return s;}" +
          "var els=document.querySelectorAll('a[href],button,[role=\"button\"]');" +
          "for(var i=0;i<els.length;i++){" +
          "  var t=norm(els[i].textContent||'');" +
          "  if(t.indexOf('continue with facebook')!==-1){" +
          "    var r=els[i].getBoundingClientRect();" +
          "    if(r.width>0&&r.height>0){" +
          "      var href=els[i].tagName==='A'?els[i].href:null;" +
          "      els[i].click();" +
          "      return JSON.stringify({clicked:true,href:href});" +
          "    }" +
          "  }" +
          "}" +
          "return JSON.stringify({clicked:false});})();"
        ).catch(() => null)
        let h = null; try { h = jsClick ? JSON.parse(jsClick) : null } catch {}
        if (h && h.clicked) {
          this.log("JS click 'Continue with Facebook'" + (h.href ? " (href: " + h.href.substring(0, 80) + ")" : ""))
          await sleep(5000)
          // Van o loginpage va co href -> load truc tiep
          if ((wc.getURL().includes("loginpage") || wc.getURL().includes("/login")) && h.href) {
            this.log("Van o loginpage -> load truc tiep href...")
            await this.loadAndWait(h.href, 25000).catch(() => {})
            await sleep(5000)
          }
          for (let i = 0; i < 20; i++) {
            if (this.isAborted) break
            await sleep(1000)
            const u = wc.getURL()
            if (!u.includes("loginpage") && !u.includes("/login")) break
            if (u.includes("facebook.com/login") && !this._warnedLogin) {
              this._warnedLogin = true
              this.log("FB yeu cau dang nhap lai bang email/password - cookie nay khong tu dong vao duoc business")
            }
            const asBtn = await this.clickByText(wc, ["Continue as", "Tiep tuc voi tu cach"])
            if (asBtn) { this.log("Click: " + asBtn.text); await this.mouseClick(wc, asBtn.x, asBtn.y); await sleep(3000) }
            if (i === 6 || i === 14) this.log("Van o loginpage (i=" + i + "): " + u.substring(0, 100) + " | Trang: " + await this.dumpClickable(wc))
          }
        } else {
          this.log("CANH BAO: Khong thay nut 'Continue with Facebook' tren loginpage")
        }
        // Van bi keo ve loginpage -> reload thang URL settings 1 lan
        if (wc.getURL().includes("loginpage") || wc.getURL().includes("/login")) {
          this.log("Reload lai settings...")
          await this.loadAndWait("https://business.facebook.com/latest/settings/ad_accounts?business_id=" + this.businessId, 30000).catch(() => {})
          await sleep(5000)
        }
        if (wc.getURL().includes("loginpage") || wc.getURL().includes("/login")) {
          await closeWin()
          return { status: "FAILED", reason: "Khong vao duoc BM " + this.businessId + " (kiem tra business_id / cookie chua co quyen BM nay)" }
        }
        this.log("Da vao duoc settings ad_accounts")
      }

      // ── BUOC 3: Click nut Add ──
      this.log("Tim nut Add...")
      let addCoords = await wc.executeJavaScript(
        "(function(){" +
        "var b=document.querySelector('[data-surface*=\"add-asset-by-asset-type\"]');" +
        "if(!b)return null;var r=b.getBoundingClientRect();" +
        "if(!(r.width>0&&r.height>0))return null;" +
        "b.scrollIntoView({block:'center'});r=b.getBoundingClientRect();" +
        "return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});" +
        "})();"
      ).catch(() => null)
      if (addCoords) {
        let h = null; try { h = JSON.parse(addCoords) } catch {}
        if (h) { this.log("Click nut Add"); await this.mouseClick(wc, h.x, h.y) }
      } else {
        const alt = await this.clickByText(wc, ["Add"])
        if (alt) { this.log("Click nut Add (theo text)"); await this.mouseClick(wc, alt.x, alt.y) }
        else {
          await closeWin()
          return { status: "FAILED", reason: "Khong tim thay nut Add tren trang ad_accounts" }
        }
      }

      // Cho menu chua "Create a new ad account"
      let optReady = false
      for (let i = 0; i < 10; i++) {
        if (this.isAborted) break
        const has = await wc.executeJavaScript(
          "(function(){var els=Array.prototype.slice.call(document.querySelectorAll('[role=\"gridcell\"],div[role=\"button\"],li,a'));" +
          "for(var i=0;i<els.length;i++){var t=(els[i].textContent||'').trim();var r=els[i].getBoundingClientRect();" +
          "if(r.width>0&&r.height>0&&t.indexOf('Create a new ad account')!==-1)return true;}return false;})();"
        ).catch(() => false)
        if (has) { optReady = true; break }
        await sleep(1000)
      }
      if (!optReady) {
        this.log("Khong thay menu - dump trang: " + await this.dumpClickable(wc))
        // Thu click lai nut Add 1 lan nua (vat ly)
        const alt2 = await this.clickByText(wc, ["Add"])
        if (alt2) {
          this.log("Click lai nut Add (theo text)")
          await this.mouseClick(wc, alt2.x, alt2.y)
          for (let i = 0; i < 8; i++) {
            if (this.isAborted) break
            const has2 = await wc.executeJavaScript(
              "(function(){var els=Array.prototype.slice.call(document.querySelectorAll('[role=\"gridcell\"],div[role=\"button\"],li,a'));" +
              "for(var i=0;i<els.length;i++){var t=(els[i].textContent||'').trim();var r=els[i].getBoundingClientRect();" +
              "if(r.width>0&&r.height>0&&t.indexOf('Create a new ad account')!==-1)return true;}return false;})();"
            ).catch(() => false)
            if (has2) { optReady = true; break }
            await sleep(1000)
          }
        }
      }
      if (!optReady) {
        // Lan 3: dispatch JS truc tiep len nut Add (React bat su kien untrusted)
        this.log("Dispatch JS len nut Add...")
        await wc.executeJavaScript(
          "(function(){" +
          "function norm(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/\\u0111/g,'d');}" +
          "var els=document.querySelectorAll('[data-surface*=\"add-asset-by-asset-type\"],div[role=\"button\"],button');" +
          "for(var i=0;i<els.length;i++){" +
          "  var t=norm(els[i].textContent);" +
          "  if(t==='add'||t.indexOf('add')===0){" +
          "    var r=els[i].getBoundingClientRect();" +
          "    if(r.width>0&&r.height>0){" +
          "      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(ty){" +
          "        try{els[i].dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,composed:true,view:window,button:0}))}catch(e){}" +
          "      });" +
          "      break;" +
          "    }" +
          "  }" +
          "}" +
          "})();"
        ).catch(() => {})
        for (let i = 0; i < 8; i++) {
          if (this.isAborted) break
          const has3 = await wc.executeJavaScript(
            "(function(){var els=Array.prototype.slice.call(document.querySelectorAll('[role=\"gridcell\"],div[role=\"button\"],li,a'));" +
            "for(var i=0;i<els.length;i++){var t=(els[i].textContent||'').trim();var r=els[i].getBoundingClientRect();" +
            "if(r.width>0&&r.height>0&&t.indexOf('Create a new ad account')!==-1)return true;}return false;})();"
          ).catch(() => false)
          if (has3) { optReady = true; break }
          await sleep(1000)
        }
      }
      if (!optReady) {
        await closeWin()
        return { status: "FAILED", reason: "Click Add roi nhung khong thay menu 'Create a new ad account'" }
      }

      // ── BUOC 4: Click "Create a new ad account" ──
      this.log("Click 'Create a new ad account'...")
      const opt = await this.clickByText(wc, ["Create a new ad account"])
      if (!opt) {
        await closeWin()
        return { status: "FAILED", reason: "Khong click duoc 'Create a new ad account'" }
      }
      await this.mouseClick(wc, opt.x, opt.y)

      // Cho form xh (nhan dien qua nut Next); khong xh -> dispatch JS + click lai
      let nextVisible = false
      for (let i = 0; i < 12; i++) {
        if (this.isAborted) break
        const has = await wc.executeJavaScript(
          "(function(){var b=document.querySelector('[data-surface*=\"fbs-settings-create-adaccount-info-next-button\"]');" +
          "if(!b)return false;var r=b.getBoundingClientRect();return r.width>0&&r.height>0;})();"
        ).catch(() => false)
        if (has) { nextVisible = true; break }
        await sleep(1000)
      }
      if (!nextVisible) {
        this.log("Form chua mo - dispatch JS len option roi click lai...")
        await wc.executeJavaScript(
          "(function(){" +
          "function norm(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/\\u0111/g,'d');}" +
          "var els=document.querySelectorAll('[role=\"gridcell\"],div[role=\"button\"],li,a');" +
          "for(var i=0;i<els.length;i++){" +
          "  if(norm(els[i].textContent).indexOf('create a new ad account')!==-1){" +
          "    var r=els[i].getBoundingClientRect();" +
          "    if(r.width>0&&r.height>0){" +
          "      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(ty){" +
          "        try{els[i].dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,composed:true,view:window,button:0}))}catch(e){}" +
          "      });" +
          "      break;" +
          "    }" +
          "  }" +
          "}" +
          "})();"
        ).catch(() => {})
        const opt2 = await this.clickByText(wc, ["Create a new ad account"])
        if (opt2) await this.mouseClick(wc, opt2.x, opt2.y)
        for (let i = 0; i < 10; i++) {
          if (this.isAborted) break
          const has = await wc.executeJavaScript(
            "(function(){var b=document.querySelector('[data-surface*=\"fbs-settings-create-adaccount-info-next-button\"]');" +
            "if(!b)return false;var r=b.getBoundingClientRect();return r.width>0&&r.height>0;})();"
          ).catch(() => false)
          if (has) { nextVisible = true; break }
          await sleep(1000)
        }
      }
      if (!nextVisible) {
        await closeWin()
        return { status: "FAILED", reason: "Form tao ad account khong xuat hien sau khi chon option" }
      }
      this.log("Form tao ad account da mo")

      // ── BUOC 5: Dien ten account (o text cung card voi nut Next, hoac trong dialog) ──
      this.log("Tim o nhap ten account...")
      const nameRaw = await wc.executeJavaScript(
        "(function(){" +
        "function findIn(root){" +
        "  var ins=Array.prototype.slice.call(root.querySelectorAll('input[type=\"text\"]')).filter(function(e){" +
        "    var r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))return false;" +
        "    return !e.closest('[role=\"combobox\"]');" +
        "  });" +
        "  if(!ins.length)return null;" +
        "  var e=ins[0];e.scrollIntoView({block:'center'});var rc=e.getBoundingClientRect();" +
        "  return {id:e.id||'',x:Math.round(rc.left+rc.width/2),y:Math.round(rc.top+rc.height/2)};" +
        "}" +
        "var next=document.querySelector('[data-surface*=\"fbs-settings-create-adaccount-info-next-button\"]');" +
        "if(next){var r0=next;for(var k=0;k<10&&r0;k++){r0=r0.parentElement;if(!r0)break;var f=findIn(r0);if(f)return JSON.stringify(f);}}" +
        "var dlg=document.querySelector('[role=\"dialog\"]');" +
        "if(dlg){var f2=findIn(dlg);if(f2)return JSON.stringify(f2);}" +
        "var f3=findIn(document);if(f3)return JSON.stringify(f3);" +
        "return null;" +
        "})();"
      ).catch(() => null)
      let nameTarget = null
      try { nameTarget = nameRaw ? JSON.parse(nameRaw) : null } catch {}
      if (!nameTarget) {
        await closeWin()
        return { status: "FAILED", reason: "Khong tim thay o nhap ten ad account" }
      }
      const okName = await this.fillByCoords(wc, nameTarget, this.accName, "Ten account")
      if (!okName) {
        await closeWin()
        return { status: "FAILED", reason: "Khong dien duoc ten ad account" }
      }

      // ── BUOC 6: Chon Time zone ──
      this.log("Chon Time zone: " + this.timezone)
      const tzCombo = await this.findComboboxByLabel(wc, "time zone")
      if (!tzCombo) {
        await closeWin()
        return { status: "FAILED", reason: "Khong tim thay combobox Time zone" }
      }
      const okTz = await this.pickOption(wc, tzCombo, this.timezone, "Time zone")

      // ── BUOC 7: Chon Currency ──
      this.log("Chon Currency: " + this.currency)
      const curCombo = await this.findComboboxByLabel(wc, "currency")
      if (!curCombo) {
        await closeWin()
        return { status: "FAILED", reason: "Khong tim thay combobox Currency" }
      }
      const okCur = await this.pickOption(wc, curCombo, this.currency, "Currency")

      if (this.isAborted) { await closeWin(); return { status: "ABORTED" } }
      if (!okTz || !okCur) {
        await closeWin()
        return { status: "FAILED", reason: "Khong chon duoc " + (!okTz ? "Time zone" : "Currency") }
      }

      // ── BUOC 8: Click Next (3 tang: data-surface -> nut 'Next' trong dialog -> toan trang) ──
      this.log("Click Next...")
      let nextClicked = false
      const nextCoords = await wc.executeJavaScript(
        "(function(){var b=document.querySelector('[data-surface*=\"fbs-settings-create-adaccount-info-next-button\"]');" +
        "if(!b)return null;var r=b.getBoundingClientRect();" +
        "if(!(r.width>0&&r.height>0))return null;" +
        "b.scrollIntoView({block:'center'});r=b.getBoundingClientRect();" +
        "return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})();"
      ).catch(() => null)
      if (nextCoords) {
        let h = null; try { h = JSON.parse(nextCoords) } catch {}
        if (h) { await this.mouseClick(wc, h.x, h.y); nextClicked = true }
      }
      if (!nextClicked) {
        const dlgNext = await wc.executeJavaScript(
          "(function(){var root=document.querySelector('[role=\"dialog\"]')||document;" +
          "var els=root.querySelectorAll('div[role=\"button\"],button');" +
          "for(var i=0;i<els.length;i++){var t=(els[i].textContent||'').trim();" +
          "if(t.toLowerCase()==='next'){var r=els[i].getBoundingClientRect();" +
          "if(r.width>0&&r.height>0){els[i].scrollIntoView({block:'center'});r=els[i].getBoundingClientRect();" +
          "return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});}}}" +
          "return null;})();"
        ).catch(() => null)
        if (dlgNext) {
          let h = null; try { h = JSON.parse(dlgNext) } catch {}
          if (h) { this.log("Click Next (trong dialog)"); await this.mouseClick(wc, h.x, h.y); nextClicked = true }
        }
      }
      if (!nextClicked) {
        const alt = await this.clickByText(wc, ["Next"])
        if (alt) { this.log("Click Next (theo text)"); await this.mouseClick(wc, alt.x, alt.y); nextClicked = true }
      }
      if (!nextClicked) {
        await closeWin()
        return { status: "FAILED", reason: "Khong click duoc nut Next" }
      }

      await sleep(6000)
      const finalUrl = wc.getURL()
      const pageText = await wc.executeJavaScript("(document.body.innerText||'').replace(/\\s+/g,' ').substring(0,400);").catch(() => '')
      this.log("URL sau Next: " + finalUrl.substring(0, 120))
      this.log("Trang sau Next: " + (pageText || '').substring(0, 200).replace(/\n/g, ' | '))

      this.log("KET QUA: SUCCESS (da dien xong buoc 1 - cho flow tiep theo)")
      await sleep(1000)
      await closeWin()
      return { status: "SUCCESS", reason: "Da dien ten + mui gio + tien te va bam Next", accName: this.accName, businessId: this.businessId }

    } catch (err) {
      this.log("LOI: " + err.message)
      await closeWin().catch(() => {})
      return { status: "ERROR", reason: err.message }
    }
  }
}

module.exports = { FBAdAccEngine }
