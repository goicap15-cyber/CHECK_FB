// ==========================================
// FLOW LOGIN LẠI DÙNG CHUNG (menu 1 + Nuôi FB) — theo đúng trình tự đã TEST THÀNH CÔNG 27-10:
//   1. Màn "Log in as X (UID) - Not you?": UID khớp -> gõ pass luôn; KHÔNG khớp -> bấm "Not you?"
//   2. Màn "Log in to your Meta Account" (profile cũ còn nhớ): bấm "Use another profile",
//      không có thì đóng X -> về form chuẩn
//   3. Màn "Continue" chọn profile: bấm Continue
//   4. Form email+pass: GÕ VẬT LÝ (native setter bị React reset ngầm) -> Log in
//   5. Màn 2FA: poll tới 45s (FB render chậm) -> TOTP local -> Continue
//   6. Màn "Trust this device?" -> bấm Trust/Continue
// Trả về: LOGGED_IN | WRONG_PASSWORD | NEED_2FA_NO_SECRET | CHECKPOINT | STUCK
// ==========================================

// TOTP sinh tại chỗ (tự chứa — tránh vòng require fbnuoi ↔ fblogin)
const crypto = require('crypto')
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, value = 0, out = []
  for (const c of String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | A.indexOf(c)
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}
function totpFromSecret(secret) {
  const key = base32Decode(secret)
  const counter = Math.floor(Date.now() / 30000)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter % 2 ** 32, 4)
  const hs = crypto.createHmac('sha1', key).update(buf).digest()
  const offset = hs[hs.length - 1] & 0x0f
  const code = ((hs[offset] & 0x7f) << 24) | (hs[offset + 1] << 16) | (hs[offset + 2] << 8) | hs[offset + 3]
  return String(code % 1000000).padStart(6, '0')
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function autoLoginFB({ win, wc, log = () => {}, uid = '', email = '', password = '', twofa = '', isAborted = null }) {
  const stopped = () => (isAborted ? isAborted() : false) || !win || win.isDestroyed()
  const bodyText = () => wc.executeJavaScript(`((document.body && document.body.innerText) || '').toLowerCase()`).catch(() => '')
  const shownUid = () => wc.executeJavaScript(`(function(){
    var t = ((document.body && document.body.innerText) || '');
    var m = t.match(/log in as[^\\n]{0,60}?([0-9]{8,18})/i) || t.match(/([0-9]{8,18})[^\\n]{0,20}not you/i);
    return m ? m[1] : '';
  })()`).catch(() => '')
  const clickFinder = async (finderJs, label, waitMs = 4000) => {
    let pos = finderJs
    if (typeof finderJs === 'string') pos = await wc.executeJavaScript(finderJs).catch(() => null)
    if (!pos) return false
    wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(70)
    wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    log(`👉 ${label}`)
    await sleep(waitMs)
    return true
  }
  const physType = async (finderJs, val, label) => {
    const pos = await wc.executeJavaScript(finderJs).catch(() => null)
    if (!pos) { log(`⚠ ${label}: không thấy ô`); return false }
    await clickFinder(pos, label + ' (click ô)', 400)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await sleep(40)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await sleep(60)
    try { await wc.insertText(String(val)) } catch {}
    await sleep(600)
    const v = await wc.executeJavaScript('(function(){ var e = document.activeElement; return e ? (e.value || "") : ""; })()').catch(() => '')
    const len = String(v || '').length
    log(`⌨ ${label}: gõ ${len} ký tự`)
    return len > 0
  }
  const EMAIL_POS = `(function(){ var e = document.querySelector('input[name="email"], input#email'); if (!e) return null; var r = e.getBoundingClientRect(); if (r.width < 30) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`
  const PASS_POS = `(function(){ var e = document.querySelector('input[type="password"]'); if (!e) return null; var r = e.getBoundingClientRect(); if (r.width < 30) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`
  const OTP_POS = `(function(){
    var bad = ['submit','button','checkbox','radio','file','hidden','image','password'];
    var ins = Array.from(document.querySelectorAll('input')).filter(function(i){
      if (bad.indexOf(i.type) !== -1) return false;
      var r = i.getBoundingClientRect();
      return r.width > 25 && r.height > 10;
    });
    var el = ins[0];
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`
  const LOGIN_BTN = `(function(){
    var cands = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'));
    var best = null;
    for (var i = 0; i < cands.length; i++) {
      var t = (((cands[i].value || '') + ' ' + (cands[i].textContent || ''))).trim().toLowerCase();
      if (t !== 'log in' && t !== 'đăng nhập') continue;
      var r = cands[i].getBoundingClientRect();
      if (r.width < 30 || r.height < 10) continue;
      var s = r.width * r.height;
      if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
    }
    return best;
  })()`
  // Submit form login + XÁC NHẬN ô pass biến mất (test 27-10: click Log in thỉnh thoảng
  // bị mất do React re-render) — Enter trước, click sau, retry tối đa 3 lần
  const submitLoginForm = async (label) => {
    for (let r = 1; r <= 3; r++) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      await sleep(100)
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      await sleep(4000)
      let gone = await wc.executeJavaScript(`!document.querySelector('input[type="password"]')`).catch(() => false)
      if (gone) { log(`✅ ${label}: form đã submit (lần ${r})`); return true }
      await clickFinder(LOGIN_BTN, label + ' (lần ' + r + ')', 4000)
      gone = await wc.executeJavaScript(`!document.querySelector('input[type="password"]')`).catch(() => false)
      if (gone) { log(`✅ ${label}: form đã submit (click lần ${r})`); return true }
    }
    log(`⚠ ${label}: 3 lần submit chưa ăn`)
    return false
  }
  const twoFaProbe = () => wc.executeJavaScript(`(function(){
    var bad = ['submit','button','checkbox','radio','file','hidden','image','password'];
    var ins = Array.from(document.querySelectorAll('input')).filter(function(i){
      if (bad.indexOf(i.type) !== -1) return false;
      var r = i.getBoundingClientRect();
      return r.width > 25 && r.height > 10;
    });
    if (!ins.length) return false;
    var pri = ins.some(function(i){
      var l = ((i.getAttribute('aria-label')||'') + ' ' + (i.placeholder||'') + ' ' + (i.name||'') + ' ' + (i.id||'') + ' ' + (i.autocomplete||'')).toLowerCase();
      return /code|mã|ma xac|otp|two.?factor|approvals/.test(l);
    });
    var t = ((document.body && document.body.innerText) || '').toLowerCase();
    var page2fa = /two.?factor|xác minh hai yếu tố|xac minh hai yeu to|login code|mã đăng nhập|ma dang nhap|enter the code from your|enter the 6-digit code/.test(t);
    return pri || page2fa;
  })()`).catch(() => false)

  const submitOtpFlow = async () => {
    if (!twofa) { log('⚠ Cần 2FA nhưng dòng không có key'); return 'NEED_2FA_NO_SECRET' }
    let otp = ''
    try { otp = totpFromSecret(twofa) } catch (e) { log('⚠ Sinh TOTP lỗi: ' + e.message) }
    if (!otp) return 'NEED_2FA_NO_SECRET'
    log('🔐 TOTP local: ' + otp)
    await physType(OTP_POS, otp, 'OTP 2FA')
    await sleep(600)
    await clickFinder(`(function(){
      var cands = Array.from(document.querySelectorAll('#checkpointSubmitButton, button[type="submit"], input[type="submit"], button, div[role="button"]'));
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        var r = cands[i].getBoundingClientRect();
        if (r.width < 30 || r.height < 10) continue;
        var t = (((cands[i].value || '') + ' ' + (cands[i].textContent || ''))).trim().toLowerCase();
        if (['continue','tiếp tục','submit','ok','log in','đăng nhập'].indexOf(t) === -1) continue;
        var s = r.width * r.height;
        if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
      }
      return best;
    })()`, 'submit OTP')
    await sleep(8000)
    // Màn "Trust this device?" — không bấm là bị nhầm checkpoint
    await clickFinder(`(function(){
      var cands = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'));
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        var r = cands[i].getBoundingClientRect();
        if (r.width < 30 || r.height < 10) continue;
        var t = (((cands[i].value || '') + ' ' + (cands[i].textContent || ''))).trim().toLowerCase();
        if (['trust this device','tin tưởng thiết bị này','continue','tiếp tục','ok'].indexOf(t) === -1) continue;
        var s = r.width * r.height;
        if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
      }
      return best;
    })()`, '"Trust this device"/Continue', 5000)
    return null
  }

  let metaPassTried = false
  for (let round = 1; round <= 10; round++) {
    if (stopped()) return { status: 'STUCK', note: 'dừng/cửa sổ đóng' }
    const t = await bodyText()
    const url = String(wc.getURL() || '').toLowerCase()
    if (!t) { await sleep(3000); continue }

    // Vào được trong rồi? (URL rời khỏi login/checkpoint + không còn form)
    const onLoginScreens = url.includes('/login') || url.includes('login.php') || url.includes('/r.php')
      || url.includes('two_step') || url.includes('two_factor') || url.includes('checkpoint') || url.includes('/challenge')
      || t.includes('log in to facebook') || t.includes('log in to your meta account') || t.includes('đăng nhập vào facebook')
    if (!onLoginScreens && !t.includes('enter the 6-digit code')) {
      const feed = await wc.executeJavaScript(`!!(document.querySelector('div[role="feed"]') || document.querySelector('input[aria-label*="Search"], input[aria-label*="Tìm kiếm"]') || document.querySelector('div[aria-label*="Tài khoản của bạn"], div[aria-label*="Your profile"]'))`).catch(() => false)
      if (feed) return { status: 'LOGGED_IN' }
    }

    // A. Màn "Log in as X (UID) - Not you?" — UID không khớp nick hiện tại -> Not you?
    const sUid = await shownUid()
    if (sUid && String(sUid) !== String(uid || '')) {
      log(`⚠ Màn login là của nick khác (${sUid}) — bấm "Not you?"`)
      await clickFinder(`(function(){
        var cands = Array.from(document.querySelectorAll('button, div[role="button"], a, span'));
        var best = null;
        for (var i = 0; i < cands.length; i++) {
          var r = cands[i].getBoundingClientRect();
          if (r.width < 20 || r.height < 8) continue;
          var tx = (((cands[i].value || '') + ' ' + (cands[i].textContent || ''))).trim().toLowerCase();
          if (['not you?','not you','không phải bạn?','không phải bạn'].indexOf(tx) === -1) continue;
          var s = r.width * r.height;
          if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
        }
        return best;
      })()`, '"Not you?"')
      continue
    }

    // B. "Log in to your Meta Account" — partition nạp cookie của nick HIỆN TẠI nên
    // profile nhớ ở đây chính là nick này (yêu cầu user 27-10): GÕ THẲNG PASS + Log in
    // + 2FA. FB chối pass mới fallback sang Use another/X -> form device-based.
    if (t.includes('log in to your meta account') || t.includes('đăng nhập vào tài khoản meta')) {
      if (!metaPassTried && password) {
        metaPassTried = true
        // 27-10 fix: ô pass màn Meta trong DOM có name="email" + type text (FB làm vậy) —
        // nhánh email-only đã từng gõ nhầm EMAIL vào đây. Gõ PASSWORD vào ô input
        // ĐẦU TIÊN visible bất kể name/type, và CHỈ bấm Log in khi đã gõ được.
        log('🔑 Màn Meta fast-login: gõ mật khẩu của nick hiện tại...')
        const typedM = await physType(`(function(){
          var bad = ['submit','button','checkbox','radio','file','hidden','image'];
          var ins = Array.from(document.querySelectorAll('input')).filter(function(i){
            if (bad.indexOf(i.type) !== -1) return false;
            var r = i.getBoundingClientRect();
            return r.width > 25 && r.height > 10;
          });
          var el = ins[0];
          if (!el) return null;
          var r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`, password, 'mật khẩu (màn Meta)')
        if (typedM) {
          await sleep(600)
          await submitLoginForm('Log in (màn Meta)')
          // Đăng nhập xong có thể tới 2FA ngay — poll như form chuẩn
          let need2faM = false
          let not2faM = 0
          for (let w = 0; w < 9; w++) {
            need2faM = await twoFaProbe()
            if (need2faM || stopped()) break
            const u2 = String(wc.getURL() || '').toLowerCase()
            const on2fa = u2.includes('two_step') || u2.includes('two_factor') || u2.includes('checkpoint') || u2.includes('/challenge')
            if (!on2fa) { not2faM++; if (not2faM >= 2) break }
            await sleep(5000)
          }
          if (need2faM) {
            const r2fa = await submitOtpFlow()
            if (r2fa) return { status: r2fa }
          }
        }
        continue
      }
      // Đã thử pass trên màn Meta mà vẫn kẹt -> thoát qua Use another / form device-based
      const used = await clickFinder(`(function(){
        var cands = Array.from(document.querySelectorAll('button, div[role="button"], a, span'));
        var best = null;
        for (var i = 0; i < cands.length; i++) {
          var r = cands[i].getBoundingClientRect();
          if (r.width < 30 || r.height < 10) continue;
          var tx = (((cands[i].value || '') + ' ' + (cands[i].textContent || ''))).trim().toLowerCase();
          if (tx.indexOf('use another profile') === -1 && tx.indexOf('tài khoản khác') === -1 && tx.indexOf('use a different account') === -1 && tx.indexOf('sử dụng hồ sơ khác') === -1) continue;
          var s = r.width * r.height;
          if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
        }
        return best;
      })()`, '"Use another profile"', 4000)
      if (!used) {
        log('⚠ Không có Use another — đóng X + vào form login cổ điển (device-based/regular)')
        await clickFinder(`(function(){
          var cands = Array.from(document.querySelectorAll('[aria-label="Close"], [aria-label="Đóng"], [aria-label="Đóng cửa sổ"]'));
          var best = null;
          for (var i = 0; i < cands.length; i++) {
            var r = cands[i].getBoundingClientRect();
            if (r.width < 10 || r.height < 10) continue;
            var s = r.width * r.height;
            if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
          }
          return best;
        })()`, 'đóng X', 2500)
        // 27-10: loadURL /login/ thường bị FB trả NGƯỢC lại màn Meta — URL
        // device-based/regular/login/ là form email+pass sạch, không bị trả lại
        try { await Promise.race([wc.loadURL('https://www.facebook.com/login/device-based/regular/login/'), sleep(25000)]) } catch {}
        await sleep(4000)
      }
      continue
    }

    // C. Sai mật khẩu? (báo cụ thể để khỏi thử 10 vòng vô ích)
    if (/the password (you've|that you've) entered is incorrect|the password that you/.test(t) && !/log in to your meta account/.test(t)) {
      // màn này vẫn có thể là của nick đúng — chỉ chốt sai khi uid màn khớp HOẶC đã có ô email
      const hasEmail = await wc.executeJavaScript(`!!document.querySelector('input[name="email"], input#email')`).catch(() => false)
      if (hasEmail || (sUid && String(sUid) === String(uid || ''))) {
        return { status: 'WRONG_PASSWORD', note: 'FB báo mật khẩu không đúng' }
      }
    }

    // D0. Màn CHỈ có ô email (login mới của FB: email -> Next -> mật khẩu riêng từng bước)
    const emailOnly = await wc.executeJavaScript(`(function(){
      var e = document.querySelector('input[name="email"], input#email, input[type="email"]');
      var p = document.querySelector('input[type="password"]');
      function vis(el) { if (!el) return false; var r = el.getBoundingClientRect(); return r.width > 25 && r.height > 10; }
      return vis(e) && !vis(p);
    })()`).catch(() => false)
    if (emailOnly && email) {
      await physType(EMAIL_POS, email, 'email (màn 1)')
      await sleep(600)
      await clickFinder(`(function(){
        var cands = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'));
        var best = null;
        for (var i = 0; i < cands.length; i++) {
          var r = cands[i].getBoundingClientRect();
          if (r.width < 30 || r.height < 10) continue;
          var t = (((cands[i].value || '') + ' ' + (cands[i].textContent || ''))).trim().toLowerCase();
          if (['continue','tiếp tục','next','tiếp theo','log in','đăng nhập'].indexOf(t) === -1) continue;
          var s = r.width * r.height;
          if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
        }
        return best;
      })()`, 'Continue (sau email)', 7000)
      continue
    }

    // D. Form chuẩn email + pass (hoặc chỉ pass khi UID màn khớp nick hiện tại)
    const hasPass = await wc.executeJavaScript(`!!(function(){ var e = document.querySelector('input[type="password"]'); if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 25 && r.height > 10; })()`).catch(() => false)
    if (hasPass) {
      const hasEmail = await wc.executeJavaScript(`!!(function(){ var e = document.querySelector('input[name="email"], input#email'); if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 25 && r.height > 10; })()`).catch(() => false)
      if (hasEmail && email) await physType(EMAIL_POS, email, 'email')
      if (!password) return { status: 'STUCK', note: 'dòng không có mật khẩu' }
      await physType(PASS_POS, password, 'mật khẩu')
      await sleep(700)
      await submitLoginForm('Log in (form chuẩn)')
      // Poll màn 2FA (FB render chậm 5-20s); không phải màn 2FA thì thoát sớm
      let need2fa = false
      let not2fa = 0
      for (let w = 0; w < 9; w++) {
        need2fa = await twoFaProbe()
        if (need2fa || stopped()) break
        const u2 = String(wc.getURL() || '').toLowerCase()
        const on2fa = u2.includes('two_step') || u2.includes('two_factor') || u2.includes('checkpoint') || u2.includes('/challenge')
        if (!on2fa) { not2fa++; if (not2fa >= 2) break }
        await sleep(5000)
      }
      if (need2fa) {
        const r2fa = await submitOtpFlow()
        if (r2fa) return { status: r2fa }
      }
      continue
    }

    // E. Màn Continue chọn profile ("Viet Ly")
    const cont = await clickFinder(`(function(){
      var btns = Array.from(document.querySelectorAll('button, div[role="button"], a'));
      var best = null;
      for (var i = 0; i < btns.length; i++) {
        var t2 = (btns[i].textContent || '').trim();
        if (t2 === 'Continue' || t2 === 'Tiếp tục') {
          var r = btns[i].getBoundingClientRect();
          if (r.width < 30 || r.height < 12) continue;
          var s = r.width * r.height;
          if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
        }
      }
      return best;
    })()`, 'Continue', 4000)
    if (cont) continue

    // F. Checkpoint/2FA mà không có ô nhập (Arkose...) -> trả về cho caller phân loại
    if (url.includes('two_step') || url.includes('two_factor') || url.includes('checkpoint') || url.includes('/challenge')) {
      await sleep(5000)
      // thử lại probe lần cuối — có khi ô nhập vừa render
      const late2fa = await twoFaProbe()
      if (late2fa) {
        const r2fa = await submitOtpFlow()
        if (r2fa) return { status: r2fa }
        continue
      }
      return { status: 'CHECKPOINT', note: 'FB chặn màn xác minh không có ô nhập mã (Arkose?)' }
    }

    await sleep(3000)
  }
  return { status: 'STUCK', note: '10 vòng chưa login được' }
}

module.exports = { autoLoginFB }
