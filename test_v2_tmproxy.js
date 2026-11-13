// Test v2 với TMProxy (xoay IP thật) + cookie Gmail JSON user cấp — chạy đúng luồng production
// Chạy: npx electron test_v2_tmproxy.js
const { app } = require('electron')
const FBRegisterEngine = require('./fbreg.js')
const { fetchProxyFromApi, checkProxy } = require('./proxy-utils.js')
const fs = require('fs')

const TMPROXY_API = 'https://tmproxy.com/api/proxy/get-new-proxy?api_key=723b15d4ae10aacbe75cb4b119559af1'
const COOKIE_FILE = 'C:/Users/Admin/Downloads/Telegram Desktop/mail 3.txt'

app.whenReady().then(async () => {
  const eng = new FBRegisterEngine({})

  console.log('[test] Gọi TMProxy lấy proxy...')
  const p = await fetchProxyFromApi(TMPROXY_API)
  if (!p) { console.log('[test] KHÔNG lấy được proxy từ TMProxy (key hết/đổi IP quá sớm)'); app.quit(); return }
  console.log('[test] Proxy: ' + p.display + ' | auth: ' + (p.auth ? p.auth.user : 'KHÔNG'))

  // Proxy user/pass: Chromium cần handler 'login' (production làm trong main.js)
  app.on('login', (event, wc, details, authInfo, callback) => {
    if (authInfo && authInfo.isProxy && p.auth) { event.preventDefault(); callback(p.auth.user, p.auth.pass) }
  })

  const chk = await checkProxy(p)
  if (!chk) { console.log('[test] Proxy TMProxy chết/chặn Facebook — chạy lại test để xoay IP khác'); app.quit(); return }
  console.log('[test] Proxy OK: IP ra ' + chk.ip + ' | ' + (chk.geo ? chk.geo.country + '/' + chk.geo.isp : '?') + ' | ping ' + chk.pingMs + 'ms')

  const gmailCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim()
  console.log('[test] Cookie Gmail: ' + gmailCookie.length + ' ký tự | format: ' + (gmailCookie.startsWith('[') ? 'JSON array' : 'string flatten'))

  const res = await eng.registerSingleAccount({
    mode: 'tempmail',
    emailProvider: 'gmail',
    proxy: p.rules,
    showBrowser: true,
    slot: 0,
    regVia: 'web',
    gmailVariant: 'plus',
    gmailCookie,
    onLog: (m) => console.log(m.replace(/^\[[^\]]+\]\s*/, ''))
  })
  console.log('[test] KẾT QUẢ: ' + JSON.stringify({ success: res.success, status: res.status, email: res.email, uid: res.uid, password: res.password, error: (res.error || '').substring(0, 250) }))
  setTimeout(() => app.quit(), 8000)
}).catch(e => { console.error('[test] LỖI:', e.message); app.quit() })
