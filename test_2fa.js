// Test flow 2FA trên nick LIVE — cửa sổ HIỆN để theo dõi trực tiếp
// Chạy: node_modules\electron\dist\electron.exe test_2fa.js --enable-logging
const { app, BrowserWindow, session, screen } = require('electron')
const FBRegisterEngine = require('./fbreg.js')

const ACCOUNT = {
  uid: '61595746885375',
  pass: 'tRtP2QnL4FN$',
  cookie: 'presence=C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1792548347758%2C%22v%22%3A1%7D; xs=1%3A6EX3Be6RYNuvxg%3A2%3A1792548266%3A-1%3A-1%3A%3AAcxjkWbAX_lbVUNz0ndUjxzqdJ2kmzhIaHe4a8XCkg; dpr=1.25; datr=Wx3YapoZRt3Jema3xXdVqcau; wd=502x682; c_user=61595746885375; fr=1VxiY6Zewwrs1VmBi.AWfnKP2mzVpDcv3tvgrgEDOJowXeqjNI9dMDfXONQdWEjqEgMWs.Bq2B28..AAA.0.0.Bq2B3v.AWc4O6Gw9LY7hEZ5DFVkDe6dxRQ; sb=oh3YagSG4TGCzv8Pwxe3sSCv'
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

app.whenReady().then(async () => {
  const log = (m) => { try { console.log(`[${new Date().toLocaleTimeString('vi-VN')}] ${m}`) } catch {} }
  const ses = session.fromPartition('test2fa_' + Date.now())
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

  const { workArea } = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    x: workArea.x + Math.round(workArea.width / 2 - 250), y: workArea.y + 30,
    width: 500, height: 940,
    show: true,
    title: `TEST 2FA — UID ${ACCOUNT.uid}`,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false }
  })
  const wc = win.webContents
  win.on('closed', () => { try { app.quit() } catch {} })

  // 1. Nạp cookie
  const pairs = ACCOUNT.cookie.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf('=')
    return { domain: '.facebook.com', path: '/', secure: true, name: idx > -1 ? pair.substring(0, idx).trim() : pair.trim(), value: idx > -1 ? pair.substring(idx + 1).trim() : '' }
  }).filter(c => c.name && c.value)
  for (const c of pairs) {
    try {
      await ses.cookies.set({
        url: 'https://www.facebook.com/', name: c.name, value: c.value,
        domain: '.facebook.com', path: '/', secure: true, httpOnly: false,
        expirationDate: Math.floor(Date.now() / 1000) + 86400 * 90
      })
    } catch (e) { log(`⚠ cookie ${c.name}: ${e.message}`) }
  }
  log(`🍪 Đã nạp cookie — mở facebook.com...`)

  try { await wc.loadURL('https://www.facebook.com/') } catch {}
  await sleep(8000)

  const state = await wc.executeJavaScript(`(function(){
    var path = location.pathname || '';
    var t = ((document.body && document.body.innerText) || '').toLowerCase();
    var state = 'UNKNOWN';
    if (path.indexOf('/checkpoint') === 0 || path.indexOf('/confirmidentity') === 0) state = 'CHECKPOINT';
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
              return tx.indexOf('Use another profile') !== -1 || tx.indexOf('tài khoản khác') !== -1;
            });
          if (useAnother && useAnother.offsetWidth > 0) state = 'CHOOSER';
          else {
            var feed = document.querySelector('div[role="feed"]') || document.querySelector('a[aria-label="Home"], a[aria-label="Trang chủ"]');
            if (feed) state = 'FEED';
            else if (t.indexOf('log in to facebook') !== -1 || t.indexOf('đăng nhập facebook') !== -1) state = 'LOGIN_FORM';
          }
        }
      }
    }
    return { state: state, url: location.href.substring(0, 120) };
  })()`).catch(() => null)
  log(`🔍 Trạng thái: ${JSON.stringify(state)}`)

  if (state && state.state === 'CHOOSER') {
    log('👉 Màn chọn profile — bấm fast-login "Continue <tên>"...')
    await wc.executeJavaScript(`(function(){
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
    })()`).catch(() => null)
    await sleep(8000)
    state.state = 'FEED' // tin là vào được — flow 2FA tự xử lý phần còn lại
    log('🔍 Sau fast-login, tiếp tục flow 2FA...')
  }

  if (!state || (state.state !== 'FEED' && state.state !== 'NEED_2FA')) {
    log(`❌ Cookie không dùng được (state=${state && state.state}) — dừng test, giữ cửa sổ 20s để xem`)
    await sleep(20000)
    app.quit()
    return
  }
  log('✅ Cookie LIVE — bắt đầu flow 2FA (Get started -> mật khẩu -> key -> Copy key -> Enter code -> 2fa.page lấy OTP -> điền -> Next)...')

  // 2. Chạy đúng flow 2FA
  const eng = new FBRegisterEngine({})
  const res = await eng.postRegTwoFactorFlow({ win, wc, log, password: ACCOUNT.pass })
  log(`🏁 KẾT QUẢ 2FA: ok=${res.ok} key=${res.key || '(không có)'}`)

  // 3. Giữ cửa sổ cho xem kết quả trên trang
  await sleep(25000)
  try { if (!win.isDestroyed()) win.destroy() } catch {}
  app.quit()
}).catch(e => { console.error('LỖI TEST:', e); app.quit() })
