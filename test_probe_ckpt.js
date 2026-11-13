// Probe trạng thái checkpoint của 1 tài khoản (Netscape cookie file) — xem đang ở màn nào
const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')
const path = require('path')

const COOKIE_FILE = process.argv[2] || 'C:/Users/Admin/Downloads/Telegram Desktop/Ckpt_Cookies_20261025_152952/61595602782271.txt'
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

function parseNetscape(txt) {
  const out = []
  for (const line of String(txt).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const p = line.split('\t')
    if (p.length >= 7) out.push({ domain: p[0].replace(/^\./, ''), name: p[5], value: p[6].trim(), path: p[2] })
  }
  return out
}

app.whenReady().then(async () => {
  try {
    const cookies = parseNetscape(fs.readFileSync(COOKIE_FILE, 'utf8'))
    console.log('Cookies:', cookies.length, 'mục —', cookies.map(c => c.name).join(','))
    const ses = session.fromPartition('probe-ckpt')
    ses.setUserAgent(UA)
    for (const c of cookies) {
      try {
        await ses.cookies.set({
          url: 'https://facebook.com/', name: c.name, value: c.value,
          domain: '.' + c.domain.replace(/^\./, ''), path: c.path || '/', secure: true, httpOnly: false,
          expirationDate: Math.floor(Date.now() / 1000) + 86400
        })
      } catch (e) { console.log('cookie err', c.name, e.message) }
    }
    const win = new BrowserWindow({
      width: 420, height: 860, show: false,
      webPreferences: { partition: 'probe-ckpt', offscreen: true, contextIsolation: true, nodeIntegration: false }
    })
    const wc = win.webContents
    await wc.loadURL('https://m.facebook.com/', { userAgent: UA }).catch(() => {})
    await sleep(7000)
    console.log('URL:', await wc.executeJavaScript('location.href').catch(() => '?'))
    const st = await wc.executeJavaScript(`(function(){
      var path = location.pathname || '';
      var t = ((document.body && document.body.innerText) || '');
      var two = document.getElementById('approvals_code') || document.querySelector('input[name="approvals_code"]');
      if (two && two.offsetWidth > 0) return 'NEED_2FA';
      if (document.querySelector('img[alt*="Captcha challenge" i], img[src*="/captcha/"]')) return 'CAPTCHA';
      var up = Array.from(document.querySelectorAll('[aria-label]')).some(function(e){
        var a = (e.getAttribute('aria-label') || '').toLowerCase();
        return a.indexOf('tải hình ảnh lên') !== -1 || a.indexOf('upload a photo') !== -1 || a.indexOf('take a photo') !== -1;
      });
      if (up) return 'PHOTO_UPLOAD(aria-label)';
      var tl = t.toLowerCase();
      if (tl.indexOf('tải hình ảnh lên') !== -1 || tl.indexOf('upload a photo') !== -1) return 'PHOTO_UPLOAD(text)';
      if (document.querySelector('div[role="feed"]')) return 'FEED';
      return 'KHAC | path=' + path + ' | body 200ky: ' + t.substring(0, 200).replace(/\\n/g, ' / ');
    })()`).catch(e => 'JS_ERR ' + e.message)
    console.log('STATE:', st)
    // liệt kê nút bấm + input file có mặt
    const diag = await wc.executeJavaScript(`(function(){
      var btns = Array.from(document.querySelectorAll('[role="button"], button, input[type="submit"], a[role="link"]')).filter(function(e){
        var r = e.getBoundingClientRect(); return r.width > 10 && r.height > 8;
      }).slice(0, 15).map(function(e){
        var r = e.getBoundingClientRect();
        var txt = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').substring(0, 40);
        return e.tagName + '("' + txt + '")';
      });
      var fi = document.querySelectorAll('input[type="file"]').length;
      return 'FILE_INPUTS=' + fi + ' | NUT: ' + btns.join(' , ');
    })()`).catch(e => 'JS_ERR ' + e.message)
    console.log('DIAG:', diag)
    win.destroy()
    app.quit()
  } catch (e) { console.error('ERR:', e.message); app.exit(1) }
})
