// Bắt captcha GỐC (ảnh màu, chưa xử lý) từ trang checkpoint m.facebook.com thật
// để phân tích màu chữ vs màu nét nhiễu. Không giải, chỉ quan sát + tải ảnh về.
const { app, BrowserWindow, session, net } = require('electron')
const fs = require('fs')
const path = require('path')

// Tải ảnh phía Node với cookie phiên (cross-origin www.facebook.com/captcha từ m.facebook)
function dlImage(urlStr, sesRef) {
  return new Promise((resolve) => {
    try {
      const req = net.request({ url: urlStr, useSessionCookies: true, session: sesRef, headers: { 'Referer': 'https://m.facebook.com/', 'Accept': 'image/png,image/jpeg,image/*;q=0.8' } })
      const chunks = []
      req.on('response', res => {
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          resolve(buf.length > 200 ? buf : null)
        })
      })
      req.on('error', () => resolve(null))
      req.end()
    } catch { resolve(null) }
  })
}

const UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

function parseCookiePart(line) {
  const parts = String(line).split('|')
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes('=') && /datr=|c_user=|xs=/.test(parts[i])) return parts[i].trim()
  }
  return ''
}

app.whenReady().then(async () => {
  const outDir = __dirname
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(__dirname, 'build/FB-Cookie-Checker-win32-x64/resources/app/imported_cookies.json'), 'utf8'))
    const arr = Array.isArray(entries) ? entries : (entries.entries || [])
    const line = (arr[0] && (arr[0].raw || arr[0].cookie || '')) || ''
    const cookieStr = parseCookiePart(line)
    console.log('Cookie:', cookieStr.substring(0, 50) + '...')
    if (!cookieStr) throw new Error('Không tìm thấy cookie trong imported_cookies.json')

    const ses = session.fromPartition('ckpt-raw-fetch')
    ses.setUserAgent(UA)
    for (const pair of cookieStr.split(';').map(s => s.trim()).filter(Boolean)) {
      const idx = pair.indexOf('=')
      if (idx < 1) continue
      try {
        await ses.cookies.set({
          url: 'https://facebook.com/', name: pair.substring(0, idx).trim(), value: pair.slice(idx + 1).trim(),
          domain: '.facebook.com', path: '/', secure: true, httpOnly: false,
          expirationDate: Math.floor(Date.now() / 1000) + 86400
        })
      } catch (e) { console.log('cookie err', pair.substring(0, idx), e.message) }
    }

    const win = new BrowserWindow({
      width: 420, height: 860, show: false,
      webPreferences: { partition: 'ckpt-raw-fetch', offscreen: true, contextIsolation: true, nodeIntegration: false }
    })
    const wc = win.webContents
    console.log('Đang mở m.facebook.com...')
    await wc.loadURL('https://m.facebook.com/', { userAgent: UA }).catch(() => {})
    await sleep(6000)
    let url = await wc.executeJavaScript('location.href').catch(() => '?')
    console.log('URL:', url)

    // Nếu chưa thấy captcha -> bấm Continue (màn locked) rồi chờ
    const hasCap = async () => wc.executeJavaScript(`!!document.querySelector('img[alt*="Captcha challenge" i], img[src*="/captcha/"]')`).catch(() => false)
    if (!(await hasCap())) {
      console.log('Chưa có captcha — bấm Continue...')
      const pos = await wc.executeJavaScript(`(function(){
        var cands = Array.from(document.querySelectorAll('div[role="button"], div[role="none"]'))
          .filter(function(e){ var t = (e.textContent||'').trim().toLowerCase(); return t === 'continue' || t === 'tiếp tục'; });
        var leaf = cands.filter(function(e){ return !e.querySelector('div[role="button"], div[role="none"]'); })[0] || cands[0];
        if (!leaf) return null;
        leaf.scrollIntoView({ block: 'center' });
        var r = leaf.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()`).catch(() => null)
      if (pos) {
        wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
        await sleep(90)
        wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      } else console.log('Không tìm thấy nút Continue')
      await sleep(6000)
      console.log('URL sau Continue:', await wc.executeJavaScript('location.href').catch(() => '?'))
    }

    // Bắt N mẫu captcha (reload trang lấy challenge mới mỗi lần)
    const N = parseInt(process.env.N_CAP || '3', 10)
    for (let i = 1; i <= N; i++) {
      if (!(await hasCap())) {
        const body = await wc.executeJavaScript(`((document.body && document.body.innerText) || '').substring(0, 200)`).catch(() => '')
        console.log(`Lần ${i}: KHÔNG thấy captcha. Body:`, JSON.stringify(body))
        break
      }
      const info = await wc.executeJavaScript(`(function(){
        var img = document.querySelector('img[alt*="Captcha challenge" i]') || document.querySelector('img[src*="/captcha/"]');
        return img ? { src: img.src, w: img.naturalWidth, h: img.naturalHeight } : null;
      })()`).catch(() => null)
      if (!info || !info.src) { console.log(`Lần ${i}: không đọc được src`); break }
      console.log(`Lần ${i}: captcha ${info.w}x${info.h} src=${info.src.substring(0, 80)}`)
      // tải phía Node với cookie phiên (fetch trong trang bị CORS chặn)
      const buf = await dlImage(info.src, ses)
      if (buf) {
        const ext = (buf[0] === 0xFF && buf[1] === 0xD8) ? 'jpg' : 'png'
        fs.writeFileSync(path.join(outDir, `captcha_raw_${i}.${ext}`), buf)
        console.log(`  -> Đã lưu captcha_raw_${i}.${ext} (${buf.length} bytes)`)
      } else console.log('  -> Node tải ảnh thất bại')
      if (i < N) {
        // reload trang để lấy challenge mới
        await wc.loadURL('https://m.facebook.com/', { userAgent: UA }).catch(() => {})
        await sleep(7000)
      }
    }
    win.destroy()
    app.quit()
  } catch (e) {
    console.error('ERR:', e.message)
    app.exit(1)
  }
})
