// Debug: dump nhãn các nút trên trang /friends của nick LIVE — tìm đúng matcher cho nút kết bạn
const { app, session, BrowserWindow } = require('electron')
const fs = require('fs')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

app.on('window-all-closed', (e) => e.preventDefault())
const ACC_LINE = fs.readFileSync(__dirname + '/test_nuoi_acc.txt', 'utf8').trim()

app.whenReady().then(async () => {
  const parts = ACC_LINE.replace(/^\[[^\]]*\]\s*/, '').split('|')
  const cookieIdx = parts.findIndex(p => p.includes('xs=') || p.includes('c_user='))
  const cookie = parts.slice(cookieIdx === -1 ? 3 : cookieIdx).join('|')
  const ses = session.fromPartition('nuoidebug_' + Date.now())
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
  for (const pair of cookie.split(';').map(s => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=')
    if (i === -1) continue
    try { await ses.cookies.set({ url: 'https://facebook.com/', name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: '.facebook.com', path: '/', secure: true }) } catch {}
  }
  const win = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { session: ses, backgroundThrottling: false } })
  const wc = win.webContents
  console.log('[dbg] Mở /friends...')
  try { await Promise.race([wc.loadURL('https://www.facebook.com/friends'), sleep(45000)]) } catch {}
  await sleep(8000)
  // Cuộn xuống 3 lần để suggestion hiện ra
  for (let i = 0; i < 3; i++) { await wc.executeJavaScript('window.scrollBy(0, 700)').catch(() => {}); await sleep(1500) }
  const dump = await wc.executeJavaScript(`(function(){
    var out = { url: location.href, title: document.title, buttons: [] };
    document.querySelectorAll('[role="button"], button, a[role="button"]').forEach(function(b){
      if (b.offsetWidth <= 0) return;
      var r = b.getBoundingClientRect();
      if (r.top < -100 || r.top > window.innerHeight + 200) return;
      var l = ((b.getAttribute('aria-label') || '') + ' | ' + (b.innerText || '')).replace(/\\s+/g, ' ').trim();
      if (l && l !== ' | ') out.buttons.push(l.substring(0, 60));
    });
    out.buttons = out.buttons.slice(0, 70);
    out.bodyHead = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').substring(0, 300);
    return JSON.stringify(out);
  })()`).catch(e => 'DUMP_LOI: ' + e.message)
  console.log('[dbg] ' + dump)
  try { win.destroy() } catch {}
  setTimeout(() => app.quit(), 3000)
}).catch(e => { console.error('[dbg] LỖI:', e.message); app.quit() })
