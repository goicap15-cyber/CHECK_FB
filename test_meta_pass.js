// Test màn "Log in to your Meta Account" với cookie THẬT của nick 61595862843997
// Dump name/type ô input + gõ pass theo .29 + đọc lại giá trị ô sau khi gõ
const { app, BrowserWindow, session, screen } = require('electron')
const fs = require('fs')
const { totpFromSecret } = require('./fblogin.js')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const L = (...a) => console.log('[T]', ...a)

let LINE = ''
try { LINE = fs.readFileSync('C:/Users/Admin/Desktop/FB_LIVE_REG.txt', 'utf8').split('\n').map(s => s.trim()).find(s => s.includes('61595862843997')) } catch (e) { L('DOC FILE LOI:', e.message) }
const parts = String(LINE).split('|')
const UID = parts[0].replace('[LIVE]', '').trim()
const EMAIL = parts[1]
const PASS = parts[2]
const TWOFA = parts[3]

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  try {
    L('nick:', UID, '| email:', EMAIL, '| pass:', PASS, '| 2FA:', TWOFA)
    const ses = session.fromPartition('meta-test')
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
          .slice(0, 6).map(function(i){ return (i.type||'?') + ':name=' + (i.name||'-') + ':id=' + (i.id||'-') + ':val=' + String((i.value||'').substring(0,30)); });
        return { url: location.href.substring(0, 100), inputs: ins, body: ((document.body&&document.body.innerText)||'').replace(/\\s+/g,' ').toLowerCase().substring(0, 150) };
      })()`).catch(e => ({ err: e.message }))
      L('---', label, '---')
      L('URL:', d.url)
      L('inputs:', JSON.stringify(d.inputs))
      L('body:', JSON.stringify(d.body))
      return d
    }
    const clickPos = async (pos, label) => {
      if (!pos) { L('X', label, 'khong thay'); return false }
      wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      await sleep(70)
      wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      L('OK', label, 'click', '(' + pos.x + ',' + pos.y + ')')
      return true
    }
    const physType = async (pos, val, label) => {
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
      L('OK', label, 'sau khi go, o co', String(v || '').length, 'ky tu | dung pass?', String(v) === String(val) ? 'YES' : 'SAI: ' + String(v).substring(0, 30))
      return String(v) === String(val)
    }

    // Nạp cookie THẬT nguyên vẹn của nick (ép đúng kịch bản cookie chết -> màn Meta)
    const ckPart = parts.slice(4).join('|')
    for (const pair of ckPart.split(';').map(s => s.trim()).filter(Boolean)) {
      const i = pair.indexOf('=')
      if (i < 1) continue
      await ses.cookies.set({ url: 'https://www.facebook.com', name: pair.slice(0, i), value: pair.slice(i + 1), domain: '.facebook.com', path: '/', secure: true, sameSite: 'no_restriction' }).catch(() => {})
    }
    L('Đã nạp cookie thật của nick')
    await wc.loadURL('https://www.facebook.com/', { userAgent: UA }).catch(() => {})
    await sleep(6000)
    const d1 = await dump('(1) sau load FB')
    const isMeta = d1.body && d1.body.includes('meta account')
    L('màn Meta?', isMeta ? 'YES' : 'NO')

    if (!isMeta && d1.body && d1.body.includes('continue')) {
      // One-tap chooser ("Binh Vu — Continue — Use another profile") -> bấm Continue
      L('màn one-tap — bấm Continue để tới màn Meta pass...')
      await clickPos(await wc.executeJavaScript(`(function(){
        var cands = Array.from(document.querySelectorAll('button, div[role="button"], a'));
        var best = null;
        for (var i = 0; i < cands.length; i++) {
          var t = (cands[i].textContent || '').trim();
          if (t !== 'Continue' && t !== 'Tiếp tục') continue;
          var r = cands[i].getBoundingClientRect();
          if (r.width < 30 || r.height < 12) continue;
          var s = r.width * r.height;
          if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
        }
        return best;
      })()`).catch(() => null), 'Continue (one-tap)')
      await sleep(6000)
    }
    const d1b = await dump('(1b) sau Continue')
    const isMeta2 = (d1b.body && d1b.body.includes('meta account')) || (d1.body && d1.body.includes('meta account'))
    L('màn Meta sau Continue?', isMeta2 ? 'YES' : 'NO')

    if (isMeta2 || (d1b.inputs && JSON.stringify(d1b.inputs).includes('password'))) {
      // Đúng flow .29: gõ PASS vào ô input đầu tiên visible
      const firstInputPos = `(function(){
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
      })()`
      const pos = await wc.executeJavaScript(firstInputPos).catch(() => null)
      L('vị trí ô đầu tiên:', JSON.stringify(pos))
      const ok = await physType(pos, PASS, 'pass (màn Meta)')
      await dump('(2) sau khi gõ pass màn Meta')
      if (ok) {
        await sleep(800)
        // Bấm Enter trước (ô đang focus) rồi click Log in, retry 3 lần nếu trang đứng yên
        for (let r = 1; r <= 3; r++) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          await sleep(100)
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
          await sleep(4000)
          let gone = await wc.executeJavaScript("!document.querySelector('input[type=\"password\"]')").catch(() => false)
          if (!gone) {
            await clickPos(await wc.executeJavaScript(`(function(){
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
            })()`).catch(() => null), 'Log in (lần ' + r + ')')
            await sleep(4000)
            gone = await wc.executeJavaScript("!document.querySelector('input[type=\"password\"]')").catch(() => false)
          }
          L('lần', r, ': ô pass còn?', !gone ? 'CÒN (chưa submit)' : 'HẾT (đã submit)')
          if (gone) break
        }
        await dump('(2b) sau submit')
        // poll 2FA
        for (let w = 0; w < 9; w++) {
          await sleep(5000)
          const probe = await wc.executeJavaScript("(function(){ var bad=['submit','button','checkbox','radio','file','hidden','image','password']; var ins=Array.from(document.querySelectorAll('input')).filter(function(i){ if(bad.indexOf(i.type)!==-1) return false; var r=i.getBoundingClientRect(); return r.width>25 && r.height>10; }); return ins.length; })()").catch(() => -1)
          const u2 = String(wc.getURL() || '').toLowerCase()
          L('poll', (w * 5 + 5) + 's: inputs=' + probe, '| url=' + u2.substring(0, 80))
          const on2fa = u2.includes('two_step') || u2.includes('two_factor') || u2.includes('checkpoint') || u2.includes('/challenge')
          if (probe > 0 && on2fa) {
            const otp = (() => { try { return totpFromSecret(TWOFA) } catch (e) { return null } })()
            L('TOTP:', otp)
            if (otp) {
              await physType(await wc.executeJavaScript("(function(){ var bad=['submit','button','checkbox','radio','file','hidden','image']; var ins=Array.from(document.querySelectorAll('input')).filter(function(i){ if(bad.indexOf(i.type)!==-1) return false; var r=i.getBoundingClientRect(); return r.width>25 && r.height>10; }); var el=ins[0]; if(!el) return null; var r=el.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()").catch(() => null), otp, 'OTP 2FA')
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
                  if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
                }
                return best;
              })()`).catch(() => null), 'submit OTP')
              await sleep(9000)
              await clickPos(await wc.executeJavaScript(`(function(){
                var cands = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"]'));
                var best = null;
                for (var i = 0; i < cands.length; i++) {
                  var r = cands[i].getBoundingClientRect();
                  if (r.width < 30 || r.height < 10) continue;
                  var t = (((cands[i].value || '') + ' ' + (cands[i].textContent || ''))).trim().toLowerCase();
                  if (['trust this device','continue','tiếp tục','ok'].indexOf(t) === -1) continue;
                  var s = r.width * r.height;
                  if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
                }
                return best;
              })()`).catch(() => null), 'Trust this device')
              await sleep(6000)
              await dump('(4) KẾT QUẢ CUỐI')
              break
            }
          }
          if (!on2fa && probe === 0) { await dump('(3) KHÔNG phải màn 2FA — có thể đã login'); break }
        }
      }
    } else {
      L('Không ra màn Meta (cookie còn sống hoặc trang khác) — dump ở trên để xem')
    }
    win.destroy()
    app.quit()
  } catch (e) { console.error('[T] ERR:', e.message); app.exit(1) }
})
