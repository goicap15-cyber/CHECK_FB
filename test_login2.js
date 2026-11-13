// Test flow LOGIN lại: form login -> gõ vật lý -> Log in -> 2FA TOTP local
const { app, BrowserWindow, session, screen } = require('electron')
const fs = require('fs')
const { totpFromSecret } = require('./fbnuoi.js')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const L = (...a) => console.log('[T]', ...a)

let LINE = ''
try { LINE = fs.readFileSync('C:/Users/Admin/Desktop/FB_LIVE_REG.txt', 'utf8').split('\n').map(s => s.trim()).filter(s => s.startsWith('[LIVE]'))[1] } catch (e) { L('DOC FILE LOI:', e.message) }
const parts = String(LINE).split('|')
const EMAIL = parts[1]
const PASS = parts[2]
const TWOFA = parts[3]

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  try {
    L('test nick:', parts[0] || '?', '| pass:', PASS ? 'co' : 'KHONG', '| 2FA:', TWOFA)
    const ses = session.fromPartition('menu1-test2')
    const wa = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      x: wa.x + 40, y: wa.y + 40, width: 430, height: 830, show: true,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
    })
    const wc = win.webContents
    ses.setUserAgent(UA)

    const dump = async (label) => {
      const d = await wc.executeJavaScript(`(function(){
        var ins = Array.from(document.querySelectorAll('input')).filter(function(i){ var r = i.getBoundingClientRect(); return r.width > 5 && r.height > 5; })
          .slice(0, 6).map(function(i){ return (i.type||'?') + ':' + (i.name||'-') + ':' + (i.id||'-') + ':' + String((i.value||'').length) + 'ky'; });
        var btns = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]')).filter(function(b){ var r = b.getBoundingClientRect(); return r.width > 20 && r.height > 10; })
          .slice(0, 8).map(function(b){ return (((b.value||'') + '|' + (b.textContent||'')).trim().replace(/\\s+/g,' ').substring(0, 25)); });
        return { url: location.href.substring(0, 110), inputs: ins, buttons: btns, body: ((document.body&&document.body.innerText)||'').replace(/\\s+/g,' ').toLowerCase().substring(0, 180) };
      })()`).catch(e => ({ err: e.message }))
      L('---', label, '---')
      L('URL:', d.url)
      L('inputs:', JSON.stringify(d.inputs))
      L('buttons:', JSON.stringify(d.buttons))
      L('body:', JSON.stringify(d.body))
      return d
    }

    const clickPos = async (pos, label) => {
      if (!pos) { L('X', label, 'khong thay'); return false }
      wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      await sleep(70)
      wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      L('OK', label, 'click vat ly', '(' + pos.x + ',' + pos.y + ')')
      return true
    }
    const physType = async (selJs, val, label) => {
      const pos = await wc.executeJavaScript(selJs).catch(() => null)
      if (!pos) { L('X', label, 'khong thay o'); return false }
      await clickPos(pos, label + ' (click o)')
      await sleep(400)
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
      await sleep(40)
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
      await sleep(60)
      try { await wc.insertText(val) } catch {}
      await sleep(600)
      const v = await wc.executeJavaScript('(function(){ var e = document.activeElement; return e ? (e.value || "") : ""; })()').catch(() => '')
      L('OK', label, 'da go, o dang focus co', String(v || '').length, 'ky tu')
      return String(v || '').length > 0
    }
    const LOGIN_BTN = `(function(){
      var cands = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'));
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        var t = (((cands[i].value || '') + ' ' + (cands[i].textContent || ''))).trim().toLowerCase();
        if (t !== 'log in' && t !== 'đăng nhập') continue;
        var r = cands[i].getBoundingClientRect();
        if (r.width < 30 || r.height < 10) continue;
        var s = r.width * r.height;
        if (!best || s < best.s) best = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), s: s };
      }
      return best;
    })()`

    await wc.loadURL('https://www.facebook.com/login/', { userAgent: UA }).catch(() => {})
    await sleep(4500)
    await dump('(1) trang login')

    await physType(`(function(){ var e = document.querySelector('input[name="email"], input#email'); if (!e) return null; var r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`, EMAIL, 'email')
    await physType(`(function(){ var e = document.querySelector('input[type="password"]'); if (!e) return null; var r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`, PASS, 'mat khau')
    await sleep(700)
    await clickPos(await wc.executeJavaScript(LOGIN_BTN).catch(() => null), 'Log in')
    await sleep(9000)
    // Poll ô nhập mã 2FA (màn mới FB load rất chậm)
    for (let w = 1; w <= 9; w++) {
      await sleep(5000)
      const probe = await wc.executeJavaScript("(function(){ var bad=['submit','button','checkbox','radio','file','hidden','image','password']; var ins=Array.from(document.querySelectorAll('input')).filter(function(i){ if(bad.indexOf(i.type)!==-1) return false; var r=i.getBoundingClientRect(); return r.width>25 && r.height>10; }); return ins.length; })()").catch(() => -1)
      L('poll', (w * 5) + 's: inputs=' + probe, '| url=' + (wc.getURL() || '').substring(0, 80))
      if (probe > 0) break
    }
    await dump('(2) sau Log in + poll')

    const otp = (() => { try { return totpFromSecret(TWOFA) } catch (e) { L('TOTP loi:', e.message); return null } })()
    L('TOTP local:', otp)
    if (otp) {
      const typed = await physType(`(function(){
        var bad = ['submit','button','checkbox','radio','file','hidden','image','password'];
        var ins = Array.from(document.querySelectorAll('input')).filter(function(i){
          if (bad.indexOf(i.type) !== -1) return false;
          var r = i.getBoundingClientRect();
          return r.width > 30 && r.height > 10;
        });
        var el = ins[0];
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()`, otp, 'OTP 2FA')
      if (typed) {
        await sleep(600)
        await clickPos(await wc.executeJavaScript(`(function(){
          var cands = Array.from(document.querySelectorAll('#checkpointSubmitButton, button[type="submit"], input[type="submit"], button, div[role="button"]'));
          var best = null;
          for (var i = 0; i < cands.length; i++) {
            var r = cands[i].getBoundingClientRect();
            if (r.width < 30 || r.height < 10) continue;
            var t = (((cands[i].value || '') + ' ' + (cands[i].textContent || ''))).trim().toLowerCase();
            if (['continue','tiếp tục','submit','ok','log in','đăng nhập'].indexOf(t) === -1) continue;
            var s = r.width * r.height;
            if (!best || s < best.s) best = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), s: s };
          }
          return best;
        })()`).catch(() => null), 'submit OTP')
        await sleep(9000)
        await dump('(3) KET QUA CUOI sau 2FA')
      }
    }
    win.destroy()
    app.quit()
  } catch (e) { console.error('[T] ERR:', e.message); app.exit(1) }
})
