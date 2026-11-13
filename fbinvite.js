// Engine tao link moi vao BM (Invite people): sau khi tao BM xong
// Flow (user mo ta 16-10):
//   1. Tao email tam qua tempmailapi.io.vn
//   2. Vao business.facebook.com/latest/settings/business_users?business_id=<BMID>
//   3. Click "Invite people" (data-surface settings-add-people-button-label)
//   4. Dien email vao combobox "Enter email addresses" -> Next (user_modal_v2step_select_people_button_edec)
//   5. Next (modal_v2step_business_access_button_next_efbb)
//   6. Next (BizKitSettingsInvitePeopleModalStepAssignAssets_nextButton)
//   7. Click "Invite with 0 assets" (invite-people-modal-submit-btn)
//   8. Click OK (user_modal_v2step_done_button_ok_eaec)
//   9. Poll inbox -> lay link business.facebook.com/invitation/?token=...
const { app, BrowserWindow, session, clipboard } = require("electron")
const TempMailMMO = require("./tempmail.js")

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

class FBInviteEngine {
  constructor({ cookie, businessId, showBrowser, proxy, onLog }) {
    this.cookie      = cookie
    this.businessId  = String(businessId || '').trim()
    this.showBrowser = showBrowser !== false
    this.proxy       = proxy || null
    this.onLog       = onLog || (() => {})
    this.win         = null
    this.isAborted   = false
    this.mail        = new TempMailMMO()
  }

  log(msg) { this.onLog(msg); console.log("[Invite]", msg) }

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

  // Bật toggle "Manage" (Full access - Everything) nếu đang OFF. Dò theo aria-label/text
  // "Manage" (dump thật 19-10: Basic mặc định aria-checked=true ON, Manage=false OFF)
  static MANAGE_PROBE() {
    return (
      "(function(){" +
      "function vis(el){return !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);}" +
      "var sws=Array.prototype.slice.call(document.querySelectorAll('[role=\"switch\"]')).filter(vis);" +
      "var names=['manage','quản lý','quan ly'];" +
      "var tgt=null;" +
      "for(var i=0;i<sws.length;i++){" +
      "  var lbl=(sws[i].getAttribute('aria-label')||'').toLowerCase();" +
      "  var txt=(sws[i].textContent||'').toLowerCase();" +
      "  for(var j=0;j<names.length;j++){" +
      "    if(lbl.indexOf(names[j])!==-1||txt===names[j]){tgt=sws[i];break;}" +
      "  }" +
      "  if(tgt)break;" +
      "}" +
      "if(!tgt)return JSON.stringify({state:'none',total:sws.length});" +
      "var r=tgt.getBoundingClientRect();" +
      "return JSON.stringify({state:(tgt.getAttribute('aria-checked')==='false')?'off':'on'," +
      "  x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});" +
      "})()"
    )
  }

  async toggleManageAccess(wc) {
    const raw = await wc.executeJavaScript(FBInviteEngine.MANAGE_PROBE()).catch(() => null)
    let t = null; try { t = JSON.parse(raw) } catch {}
    if (!t || t.state === 'none') {
      const dump = await wc.executeJavaScript(`(function(){
        var out=[]
        ;['switch','checkbox','menuitemcheckbox'].forEach(function(r){
          Array.prototype.forEach.call(document.querySelectorAll('[role="'+r+'"]'), function(e){
            var rc = e.getBoundingClientRect(); if (rc.width <= 0) return
            out.push(r + ':' + (e.getAttribute('aria-checked') || e.getAttribute('aria-pressed') || '?') + ':' + ((e.getAttribute('aria-label') || e.textContent || '').trim().substring(0, 30)))
          })
        })
        return JSON.stringify(out)
      })()`).catch(() => null)
      this.log("[DUMP toggle] " + String(dump).substring(0, 700))
      return 'none'
    }
    if (t.state === 'on') return 'already'
    await this.mouseClick(wc, t.x, t.y)
    await sleep(700)
    const raw2 = await wc.executeJavaScript(FBInviteEngine.MANAGE_PROBE()).catch(() => null)
    let t2 = null; try { t2 = JSON.parse(raw2) } catch {}
    return (t2 && t2.state === 'on') ? 'clicked' : 'none'
  }

  async loadAndWait(url, timeout) {
    timeout = timeout || 30000
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(false), timeout)
      this.win.webContents.once("did-finish-load", () => { clearTimeout(t); resolve(true) })
      this.win.loadURL(url)
    })
  }

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

  // Doc trang thai o email + nut Next cua modal invite:
  // ad = aria-disabled cua Next, val = gia tri o email, focus = the dang focus
  async inviteEmailState(wc) {
    const raw = await wc.executeJavaScript(
      "(function(){var els=document.querySelectorAll('[data-surface]');var nb=null;" +
      "for(var i=0;i<els.length;i++){if((els[i].getAttribute('data-surface')||'').indexOf('user_modal_v2step_select_people_button_edec')!==-1){" +
      "var r=els[i].getBoundingClientRect();if(r.width>0&&r.height>0){nb=els[i];break;}}}" +
      "var ins=document.querySelector('[role=\"combobox\"][placeholder*=\"email\" i]');" +
      "var ae=document.activeElement;" +
      "return JSON.stringify({ad:nb?(nb.getAttribute('aria-disabled')||'false'):'KO_THAY'," +
      "val:ins?(ins.value||''):'KO_O'," +
      "focus:ae?(ae.tagName+'|'+(ae.getAttribute('placeholder')||'').substring(0,25)):'null'});})();"
    ).catch(() => null)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  // Tim toa do nut theo data-surface (substring), tra ve {x,y} hoac null
  async findSurface(wc, surface) {
    const raw = await wc.executeJavaScript(
      "(function(){var b=document.querySelector('[data-surface*=" + JSON.stringify(surface) + "]');" +
      "if(!b)return null;var r=b.getBoundingClientRect();" +
      "if(!(r.width>0&&r.height>0))return null;" +
      "b.scrollIntoView({block:'center'});r=b.getBoundingClientRect();" +
      "return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})();"
    ).catch(() => null)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  // Cho nut theo data-surface xh trong timeoutMs
  async waitSurface(wc, surface, timeoutMs) {
    const t0 = Date.now()
    while (Date.now() - t0 < (timeoutMs || 15000)) {
      if (this.isAborted) return null
      const h = await this.findSurface(wc, surface)
      if (h) return h
      await sleep(1000)
    }
    return null
  }

  // Click nut data-surface 3 tang: coords -> clickByText -> dispatch JS
  async clickSurface(wc, surface, texts) {
    let h = await this.findSurface(wc, surface)
    if (h) { await this.mouseClick(wc, h.x, h.y); return true }
    const alt = await this.clickByText(wc, texts || ["Next"])
    if (alt) { await this.mouseClick(wc, alt.x, alt.y); return true }
    // Dispatch JS truc tiep
    await wc.executeJavaScript(
      "(function(){" +
      "var b=document.querySelector('[data-surface*=" + JSON.stringify(surface) + "]');" +
      "if(b){" +
      "  var r=b.getBoundingClientRect();" +
      "  if(r.width>0&&r.height>0){" +
      "    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(ty){" +
      "      try{b.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,composed:true,view:window,button:0}))}catch(e){}" +
      "    });" +
      "  }" +
      "}" +
      "})();"
    ).catch(() => {})
    h = await this.findSurface(wc, surface)
    if (h) { await this.mouseClick(wc, h.x, h.y); return true }
    return false
  }

  // Dispatch JS truc tiep len nut data-surface (khong dung toa do -> khong the click lan backdrop)
  async jsClickSurface(wc, surface) {
    return wc.executeJavaScript(
      "(function(){" +
      "var els=document.querySelectorAll('[data-surface]');var b=null;" +
      "for(var i=0;i<els.length;i++){" +
      "  if((els[i].getAttribute('data-surface')||'').indexOf(" + JSON.stringify(surface) + ")!==-1){" +
      "    var r=els[i].getBoundingClientRect();if(r.width>0&&r.height>0){b=els[i];break;}" +
      "  }" +
      "}" +
      "if(!b)return false;" +
      "['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(ty){" +
      "  try{b.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,composed:true,view:window,button:0}))}catch(e){}" +
      "});" +
      "return true;})();"
    ).catch(() => false)
  }

  // Modal con mo khong (co phan tu data-surface*modal/invite-people visible)
  async modalOpen(wc) {
    return wc.executeJavaScript(
      "(function(){var els=document.querySelectorAll('[data-surface]');" +
      "for(var i=0;i<els.length;i++){" +
      "  var v=els[i].getAttribute('data-surface')||'';" +
      "  if(v.indexOf('modal')!==-1||v.indexOf('invite-people')!==-1){" +
      "    var r=els[i].getBoundingClientRect();if(r.width>0&&r.height>0)return true;" +
      "  }" +
      "}return false;})();"
    ).catch(() => false)
  }

  async dumpSurfaces(wc) {
    return wc.executeJavaScript(
      "(function(){var els=document.querySelectorAll('[data-surface]');var out=[];" +
      "for(var i=0;i<els.length;i++){" +
      "  var r=els[i].getBoundingClientRect();if(!(r.width>0&&r.height>0))continue;" +
      "  var v=els[i].getAttribute('data-surface');if(out.indexOf(v)<0)out.push(v);" +
      "  if(out.length>=30)break;" +
      "}return out.join(' | ');})();"
    ).catch(() => "")
  }

  // Popup "Switch between your user profiles" (acc moi vao settings lan dau) che nut
  // -> phai bam Done/X cho no tat truoc, khong thi mouseClick trung popup khong trung nut
  // Match theo text popup (EN+VN khong dau) de khong nham nut Done cua modal khac.
  // Nut Done co the chi co aria-label khong co text -> match ca hai; khong thay nut thi
  // bam fallback goc phai tren cua popup (vi tri nut X); bam xong verify popup mat that.
  async dismissProfilePopup(wc, tries) {
    for (let i = 0; i < (tries || 5); i++) {
      if (this.isAborted) return false
      const js = await wc.executeJavaScript(
        "(function(){" +
        "function norm(s){s=String(s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/\\u0111/g,'d');return s.replace(/\\s+/g,' ');}" +
        "var targets=['switch between your user profiles','chuyen doi giua cac ho so nguoi dung'];" +
        "var all=document.querySelectorAll('div,span,h2,h3,p');" +
        "var anchor=null,area=1e18;" +
        "for(var i=0;i<all.length;i++){" +
        "  var t=norm(all[i].textContent||'');" +
        "  var hit=false;for(var j=0;j<targets.length;j++){if(t.indexOf(targets[j])!==-1){hit=true;break;}}" +
        "  if(!hit)continue;" +
        "  var r=all[i].getBoundingClientRect();if(!(r.width>0&&r.height>0))continue;" +
        "  var a=r.width*r.height;if(a<area){anchor=all[i];area=a;}" +
        "}" +
        "if(!anchor)return 'NO_POPUP';" +
        "var box=anchor;" +
        "for(var k=0;k<14&&box.parentElement;k++){" +
        "  var tb=box.querySelectorAll('div[role=\"button\"],button');var okb=false;" +
        "  for(var q=0;q<tb.length;q++){" +
        "    var t1=norm(tb[q].textContent||'');var a1=norm(tb[q].getAttribute('aria-label')||'');" +
        "    if(t1==='done'||a1==='done'||a1==='close'||a1==='dong'){okb=true;break;}" +
        "  }" +
        "  if(okb)break;box=box.parentElement;" +
        "}" +
        "var bb=box.getBoundingClientRect();" +
        "var btns=box.querySelectorAll('div[role=\"button\"],button');" +
        "var done=null,x=null;" +
        "for(var m=0;m<btns.length;m++){" +
        "  var b=btns[m];var br=b.getBoundingClientRect();if(!(br.width>0&&br.height>0))continue;" +
        "  var bt=norm(b.textContent||'');var al=norm(b.getAttribute('aria-label')||'');" +
        "  if(bt==='done'||al==='done'){if(!done)done=b;}" +
        "  else if(al==='close'||al==='dong'){if(!x)x=b;}" +
        "}" +
        "if(!done&&!x)return JSON.stringify({fallback:true,x:Math.round(bb.right-30),y:Math.round(bb.top+30)});" +
        "var p=done||x;" +
        "var pr=p.getBoundingClientRect();" +
        "return JSON.stringify({x:Math.round(pr.left+pr.width/2),y:Math.round(pr.top+pr.height/2),kind:done?'Done':'X'});})();"
      ).catch(() => null)
      if (js && js !== 'NO_POPUP' && js !== 'NO_BTN') {
        try {
          const h = JSON.parse(js)
          this.log("Popup 'Switch between your user profiles' che man hinh - bam " + (h.kind || 'X (goc phai tren)') + " de tat")
          await this.mouseClick(wc, h.x, h.y)
          await sleep(1500)
          const still = await wc.executeJavaScript(
            "(function(){var all=document.querySelectorAll('div,span,h2,h3,p');" +
            "for(var i=0;i<all.length;i++){var t=String(all[i].textContent||'').toLowerCase();" +
            "if(t.indexOf('switch between your user profiles')!==-1){var r=all[i].getBoundingClientRect();if(r.width>0&&r.height>0)return true;}}return false;})()"
          ).catch(() => true)
          if (!still) return true
          this.log("Popup van chua tat - thu lai...")
        } catch {}
      }
      await sleep(1000)
    }
    return false
  }

  // Day cua so len foreground THAT (Windows chan focus-steal nen phai dung app.focus steal)
  // Keyboard/insertText chi duoc FB xu ly khi window that su foreground
  async ensureFocus() {
    try {
      if (this.win && !this.win.isDestroyed()) {
        this.win.show()
        if (this.win.isMinimized()) this.win.restore()
        this.win.moveTop()
        app.focus({ steal: true })
        this.win.focus()
      }
    } catch {}
    await sleep(900)
  }

  // Tu tim BM ID cua cookie: vao business.facebook.com, doc business_id tu URL;
  // gap trang xac thuc thi bam 'Continue with Facebook'; URL chang co thi quet
  // trong HTML. asset_id chi la ad-account - khong phai BM ID.
  async resolveBmId(wc) {
    const go = (url) => {
      const p = this.win.loadURL(url)
      p.catch(() => {})
      return Promise.race([p, sleep(20000)])
    }
    await go("https://business.facebook.com/")
    await sleep(3000)
    let triedLogin = false
    for (let i = 0; i < 14; i++) {
      if (this.isAborted) return null
      const u = wc.getURL()
      const m = u.match(/business_id=(\d{10,20})/)
      if (m) return m[1]
      if ((u.includes("loginpage") || u.includes("/login")) && !triedLogin) {
        triedLogin = true
        this.log("Business yeu cau xac thuc - thu 'Continue with Facebook'...")
        const jsClick = await wc.executeJavaScript(
          "(function(){function norm(s){return String(s||'').toLowerCase();}" +
          "var els=document.querySelectorAll('a[href],button,[role=\"button\"]');" +
          "for(var i=0;i<els.length;i++){var t=norm(els[i].textContent||'');" +
          "if(t.indexOf('continue with facebook')!==-1||t.indexOf('tiep tuc voi facebook')!==-1){" +
          "var r=els[i].getBoundingClientRect();if(r.width>0&&r.height>0){" +
          "var href=els[i].tagName==='A'?els[i].href:null;els[i].click();" +
          "return JSON.stringify({clicked:true,href:href});}}}" +
          "return JSON.stringify({clicked:false});})();"
        ).catch(() => null)
        let h = null; try { h = jsClick ? JSON.parse(jsClick) : null } catch {}
        if (h && h.clicked) {
          await sleep(5000)
          const u2 = wc.getURL()
          if ((u2.includes("loginpage") || u2.includes("/login")) && h.href) await go(h.href)
          await sleep(3000)
          continue
        }
      }
      const idsRaw = await wc.executeJavaScript(
        "(function(){var html=document.documentElement.innerHTML;" +
        "var re=/business_id[^0-9]{0,8}(\\d{10,20})/g;var out=[],m2;" +
        "while((m2=re.exec(html))&&out.length<5){if(out.indexOf(m2[1])<0)out.push(m2[1]);}" +
        "return JSON.stringify(out);})();"
      ).catch(() => null)
      if (idsRaw) {
        try { const arr = JSON.parse(idsRaw); if (arr && arr.length) return arr[0] } catch {}
      }
      await sleep(1000)
    }
    const fin = wc.getURL()
    const am = fin.match(/asset_id=(\d{10,20})/)
    if (fin.includes("loginpage") || fin.includes("/login")) {
      this.log("Cookie khong vao duoc business (het session business)")
    } else if (am) {
      this.log("Acc chua co Business Manager (business home theo asset " + am[1] + " - do la ad-account, khong phai BM)")
    }
    return null
  }

  // Buoc click co kiem chung: JS dispatch truoc (an toan), roi toa do, roi text.
  // Sau moi lan click cho surfaceNext xh; neu modal dong -> tra ve {state:'closed'}
  async clickStep(wc, surfaceNow, surfaceNext, texts, verifyMs) {
    verifyMs = verifyMs || 6000
    for (let round = 0; round < 2; round++) {
      if (await this.waitSurface(wc, surfaceNext, 1200)) return { state: 'advanced' }
      // popup profile-switcher co the bat bat ky luc nao - tat truoc khi click
      await this.dismissProfilePopup(wc, 1)

      const js = await this.jsClickSurface(wc, surfaceNow)
      if (js) {
        if (await this.waitSurface(wc, surfaceNext, verifyMs)) return { state: 'advanced' }
        if (!(await this.modalOpen(wc))) return { state: 'closed' }
        await sleep(800)
      }

      const h = await this.findSurface(wc, surfaceNow)
      if (h) {
        await this.mouseClick(wc, h.x, h.y)
        if (await this.waitSurface(wc, surfaceNext, verifyMs)) return { state: 'advanced' }
        if (!(await this.modalOpen(wc))) return { state: 'closed' }
        await sleep(800)

        const h2 = await this.findSurface(wc, surfaceNow)
        if (h2) {
          const alt = await this.clickByText(wc, texts || ["Next"])
          if (alt) {
            await this.mouseClick(wc, alt.x, alt.y)
            if (await this.waitSurface(wc, surfaceNext, verifyMs)) return { state: 'advanced' }
            if (!(await this.modalOpen(wc))) return { state: 'closed' }
          }
        }
      }
      await sleep(1200)
    }
    this.log("[WARN] Chua sang buoc ke (" + surfaceNext + ") - surfaces visible: " + await this.dumpSurfaces(wc))
    return { state: 'stuck' }
  }

  // Tim o nhap email TRONG modal: input role=combobox placeholder chua 'email'.
  // Phai dung selector combobox - neu lay moi input placeholder chua 'email' se
  // nham voi o search cua trang nam SAU modal (bi overlay che, click vao chi
  // trung DIV, khong focus duoc input). Cong them: o phai la phan tu tren cung
  // tai toa do cua no (elementFromPoint) tuc khong bi che.
  async findEmailInput(wc, tries) {
    for (let i = 0; i < (tries || 15); i++) {
      if (this.isAborted) return null
      const raw = await wc.executeJavaScript(
        "(function(){var ins=document.querySelectorAll('input[role=\"combobox\"][placeholder*=\"email\" i]');" +
        "for(var i=0;i<ins.length;i++){" +
        "  var r=ins[i].getBoundingClientRect();" +
        "  if(!(r.width>0&&r.height>0))continue;" +
        "  ins[i].scrollIntoView({block:'center'});r=ins[i].getBoundingClientRect();" +
        "  var cx=Math.round(r.left+r.width/2),cy=Math.round(r.top+r.height/2);" +
        "  var top=document.elementFromPoint(cx,cy);" +
        "  if(top===ins[i]||ins[i].contains(top)){" +
        "    return JSON.stringify({id:ins[i].id||'',x:cx,y:cy});" +
        "  }" +
        "}return null;})();"
      ).catch(() => null)
      if (raw) {
        try { const o = JSON.parse(raw); if (o) return o } catch {}
      }
      await sleep(1000)
    }
    return null
  }

  async createInviteLink() {
    if (this.isAborted) return { status: "ABORTED" }
    this.log("=== TAO LINK MOI VAO BM " + this.businessId + " ===")

    // ── BUOC 0: Tao email tam ──
    this.log("Tao email tam qua tempmailapi.io.vn...")
    let emailInfo = null
    try {
      emailInfo = await this.mail.createEmail()
    } catch (e) {
      return { status: "FAILED", reason: "Loi tao email tam: " + e.message }
    }
    const email = emailInfo.email
    const sidToken = emailInfo.sidToken
    this.log("Email tam: " + email)

    // Baseline cac thu co truoc de bo qua
    const baselineIds = new Set()
    try {
      const baseList = await this.mail.getEmailList(sidToken)
      baseList.forEach(m => baselineIds.add(String(m.mail_id || '')))
      this.log("Baseline inbox: " + baselineIds.size + " thu cu")
    } catch {}

    const pid = "bminvite" + Date.now()
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
        return { status: fbUrl.includes("checkpoint") ? "CHECKPOINT" : "DEAD", reason: "Cookie het han", email }
      }
      this.log("Cookie OK")

      // ── BUOC 1.5: Chua co Business ID -> tu tim BM cua cookie ──
      if (!this.businessId) {
        this.log("Chua co Business ID - tu tim BM cua cookie nay...")
        const found = await this.resolveBmId(wc)
        if (!found) {
          await closeWin()
          return { status: "FAILED", reason: "Acc chua co Business Manager (hoac cookie het session business) - hay 'Bat dau tao BM' truoc hoac nhap Business ID tay o tab 'Tao Account trong BM'", email }
        }
        this.businessId = found
        this.log("[OK] Tu tim thay BM: " + found)
      }

      // ── BUOC 2: Vao settings business_users cua BM ──
      const settingsUrl = "https://business.facebook.com/latest/settings/business_users?business_id=" + this.businessId + "&passkey_ref=false"
      this.log("Vao settings business_users cua BM " + this.businessId + "...")
      await this.loadAndWait(settingsUrl, 30000)
      await sleep(5000)
      if (this.isAborted) { await closeWin(); return { status: "ABORTED" } }

      const setUrl = wc.getURL()
      this.log("Settings URL: " + setUrl.substring(0, 120))
      if (setUrl.includes("loginpage") || setUrl.includes("/login")) {
        this.log("Bi dua ve loginpage - dump trang: " + await this.dumpClickable(wc))
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
        if (wc.getURL().includes("loginpage") || wc.getURL().includes("/login")) {
          this.log("Reload lai settings...")
          await this.loadAndWait(settingsUrl, 30000).catch(() => {})
          await sleep(5000)
        }
        if (wc.getURL().includes("loginpage") || wc.getURL().includes("/login")) {
          await closeWin()
          return { status: "FAILED", reason: "Khong vao duoc BM " + this.businessId + " (kiem tra business_id / cookie chua co quyen BM nay)", email }
        }
        this.log("Da vao duoc settings business_users")
      }

      // ── BUOC 3: Click "Invite people" ──
      // Acc moi bi popup "Switch between your user profiles" che nut - tat popup roi
      // moi click; click xong verify modal mo that, chua mo thi tat popup lai + click lai
      let inviteOpened = false
      for (let round = 1; round <= 3 && !inviteOpened; round++) {
        await this.dismissProfilePopup(wc, round === 1 ? 6 : 3)
        // Day foreground TRUOC khi mo modal (cong thuc v7: keyboard chi an khi
        // modal duoc mo trong luc window foreground)
        await this.ensureFocus()
        this.log("Tim nut 'Invite people' (lan " + round + ")...")
        const inviteReady = await this.waitSurface(wc, "settings-add-people-button-label", 10000)
        if (inviteReady) {
          inviteOpened = await this.clickSurface(wc, "settings-add-people-button-label", ["Invite people"])
        } else {
          const alt = await this.clickByText(wc, ["Invite people"])
          if (alt) { await this.mouseClick(wc, alt.x, alt.y); inviteOpened = true }
        }
        if (!inviteOpened) continue
        await sleep(2500)
        if (!(await this.modalOpen(wc))) {
          inviteOpened = false
          this.log("Click roi nhung modal chua mo - kha nang popup van che nut, thu lai...")
        }
      }
      if (!inviteOpened) {
        this.log("Khong thay nut - dump: " + await this.dumpClickable(wc))
        await closeWin()
        return { status: "FAILED", reason: "Khong mo duoc modal 'Invite people' (popup che nut hoac BM chua du dieu kien)", email }
      }
      this.log("Da mo modal 'Invite people'")
      // Cho modal animation chay xong truoc khi lay toa do o email
      await sleep(1500)

      // ── BUOC 4: Dien email vao combobox roi Next ──
      // Cong thuc v7 (lan duy nhat Next bat): click THAT vao o (focus that,
      // JS focus khong lam FB React dang ky) roi insertText; neu chua duoc thi
      // Ctrl+V clipboard, cuoi cung go tung ky tu - tat ca khi window foreground
      const doInviteStep1 = async () => {
        let emailInput = await this.findEmailInput(wc, 12)
        if (!emailInput && await this.dismissProfilePopup(wc, 3)) {
          this.log("Thu lai tim o email sau khi tat popup...")
          emailInput = await this.findEmailInput(wc, 8)
        }
        if (!emailInput) {
          this.log("Khong thay o email - dump: " + await this.dumpClickable(wc))
          return { state: 'noinput' }
        }
        this.log("Tim thay o nhap email (id=" + (emailInput.id || '?') + ")")
        await this.ensureFocus()

        // Click THAT vao o email - phai thay INPUT duoc focus moi dien duoc
        await this.mouseClick(wc, emailInput.x, emailInput.y)
        let st = await this.inviteEmailState(wc)
        this.log("Sau click o email: focus=" + (st && st.focus) + " val=" + JSON.stringify(st && st.val))
        if (!st || String(st.focus || '').indexOf('INPUT') === -1) {
          const fresh = await this.findEmailInput(wc, 3)
          if (fresh) {
            this.log("Click lan 2 vao o email (toado moi " + fresh.x + "," + fresh.y + ")...")
            await this.mouseClick(wc, fresh.x, fresh.y)
            st = await this.inviteEmailState(wc)
            this.log("Sau click lan 2: focus=" + (st && st.focus))
          }
        }
        if (!st || String(st.focus || '').indexOf('INPUT') === -1) {
          this.log("[WARN] Click khong focus duoc o email (focus=" + (st && st.focus) + ") - van thu dien")
        }

        // CACH A: insertText
        await wc.insertText(email)
        await sleep(1500)
        st = await this.inviteEmailState(wc)
        this.log("Sau insertText: val=" + JSON.stringify(st && st.val) + " Next=" + (st && st.ad))

        // CACH B: Ctrl+V clipboard (phim that khi foreground)
        if (!st || st.ad === 'true') {
          this.log("Next chua bat -> thu Ctrl+V clipboard...")
          clipboard.writeText(email)
          await this.mouseClick(wc, emailInput.x, emailInput.y)
          await sleep(300)
          wc.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] })
          wc.sendInputEvent({ type: "keyUp",   keyCode: "V", modifiers: ["control"] })
          await sleep(1500)
          st = await this.inviteEmailState(wc)
          this.log("Sau Ctrl+V: val=" + JSON.stringify(st && st.val) + " Next=" + (st && st.ad))
        }

        // CACH C: go tung ky tu (phim char that khi foreground)
        if (!st || st.ad === 'true') {
          this.log("Next chua bat -> go tung ky tu...")
          await this.mouseClick(wc, emailInput.x, emailInput.y)
          await sleep(300)
          wc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] })
          wc.sendInputEvent({ type: "keyUp",   keyCode: "A", modifiers: ["control"] })
          wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" })
          wc.sendInputEvent({ type: "keyUp",   keyCode: "Backspace" })
          await sleep(200)
          for (const ch of email) {
            wc.sendInputEvent({ type: "char", keyCode: ch })
            await sleep(25)
          }
          await sleep(1500)
          st = await this.inviteEmailState(wc)
          this.log("Sau go phim: val=" + JSON.stringify(st && st.val) + " Next=" + (st && st.ad))
        }

        if (!st || st.ad !== 'false') {
          this.log("[WARN] Nut Next van khong bat (ad=" + (st && st.ad) + " val=" + JSON.stringify(st && st.val) + ")")
          return { state: 'nextdisabled' }
        }
        return this.clickStep(wc, "user_modal_v2step_select_people_button_edec", "modal_v2step_business_access_button_next_efbb", ["Next"])
      }

      let step1 = await doInviteStep1()
      if (step1.state === 'closed') {
        this.log("Modal bi dong sau buoc 1 - mo lai va lam lai...")
        const reopen = await this.waitSurface(wc, "settings-add-people-button-label", 10000)
        if (reopen) {
          await this.clickSurface(wc, "settings-add-people-button-label", ["Invite people"])
          step1 = await doInviteStep1()
        }
      }
      if (step1.state !== 'advanced') {
        this.log("Modal ket: " + await this.dumpClickable(wc))
        await closeWin()
        return { status: "FAILED", reason: "Khong sang duoc buoc 2 sau khi dien email (modal: " + step1.state + ")", email }
      }

      // ── BUOC 5: Bat toggle Full access (Manage) + Next (business access) ──
      this.log("Kiem tra toggle Manage (Full access)...")
      const tg = await this.toggleManageAccess(wc)
      if (tg === 'clicked') this.log("[OK] Da bat toggle Manage (Full access) = ON")
      else if (tg === 'already') this.log("Toggle Manage da ON tu truoc")
      else this.log("[WARN] Khong tim thay toggle Manage - tiep tuc nhu cu")
      this.log("Next buoc business access...")
      const s5 = await this.clickStep(wc, "modal_v2step_business_access_button_next_efbb", "BizKitSettingsInvitePeopleModalStepAssignAssets_nextButton", ["Next"])
      if (s5.state !== 'advanced') {
        await closeWin()
        return { status: "FAILED", reason: "Khong sang duoc buoc 3 (assign assets) (modal: " + s5.state + ")", email }
      }

      // ── BUOC 6: Next (assign assets) ──
      this.log("Next buoc assign assets...")
      const s6 = await this.clickStep(wc, "BizKitSettingsInvitePeopleModalStepAssignAssets_nextButton", "invite-people-modal-submit-btn", ["Next"])
      if (s6.state !== 'advanced') {
        await closeWin()
        return { status: "FAILED", reason: "Khong thay nut 'Invite with 0 assets' (modal: " + s6.state + ")", email }
      }

      // ── BUOC 7: "Invite with 0 assets" ──
      this.log("Bam Invite...")
      const s7 = await this.clickStep(wc, "invite-people-modal-submit-btn", "user_modal_v2step_done_button_ok_eaec", ["Invite with"], 10000)
      if (s7.state !== 'advanced') {
        await closeWin()
        return { status: "FAILED", reason: "Khong bam duoc nut Invite (modal: " + s7.state + ")", email }
      }
      this.log("Da bam Invite")

      // ── BUOC 8: OK ──
      const okBtn = await this.waitSurface(wc, "user_modal_v2step_done_button_ok_eaec", 15000)
      if (okBtn) {
        await this.jsClickSurface(wc, "user_modal_v2step_done_button_ok_eaec")
        await sleep(1500)
        if (await this.modalOpen(wc)) {
          const h8 = await this.findSurface(wc, "user_modal_v2step_done_button_ok_eaec")
          if (h8) await this.mouseClick(wc, h8.x, h8.y)
        }
        this.log("Da bam OK")
      } else {
        this.log("Khong thay nut OK (co the da tu dong) - dump: " + await this.dumpClickable(wc))
      }

      // ── BUOC 9: Poll inbox lay link invitation ──
      this.log("Cho thu moi tu Facebook trong inbox...")
      const linkRe = /https:\/\/business\.facebook\.com\/invitation\/\?token=[A-Za-z0-9_\-]{20,}/
      for (let attempt = 1; attempt <= 40; attempt++) {
        if (this.isAborted) break
        try {
          const emails = await this.mail.getEmailList(sidToken)
          const newMails = emails.filter(m => !baselineIds.has(String(m.mail_id || '')))
          for (const m of newMails) {
            const subject = m.mail_subject || ''
            const from = m.mail_from || ''
            this.log("Thu moi: \"" + subject.substring(0, 60) + "\" tu " + from.substring(0, 40))
            const detail = await this.mail.fetchEmail(sidToken, m.mail_id)
            const body = detail.mail_body || ''
            const match = body.match(linkRe)
            if (match) {
              const link = match[0]
              this.log("[OK] Da lay link moi: " + link.substring(0, 80) + "...")
              await closeWin()
              return { status: "SUCCESS", email, inviteLink: link, businessId: this.businessId, mailSubject: subject }
            }
          }
        } catch (e) {
          this.log("Loi kiem tra inbox: " + e.message)
        }
        if (attempt % 5 === 0) this.log("Chua co thu moi (lan " + attempt + "/40)...")
        await sleep(8000)
      }

      await closeWin()
      return { status: "FAILED", reason: "Khong nhan duoc thu moi tu Facebook sau 40 lan kiem tra (~5 phut)", email }
    } catch (e) {
      await closeWin()
      return { status: "FAILED", reason: "Loi engine: " + e.message, email }
    }
  }
}

module.exports = { FBInviteEngine }
