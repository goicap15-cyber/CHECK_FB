// Test v2 KHÔNG proxy (IP nhà) — xác nhận đường OTP end-to-end:
// trang mã xác nhận -> search to:<variant> -> đọc OTP -> điền -> tiếp tục
// Chạy: npx electron test_v2_noproxy.js
const { app } = require('electron')
const FBRegisterEngine = require('./fbreg.js')
const fs = require('fs')

const COOKIE_FILE = 'C:/Users/Admin/Downloads/Telegram Desktop/mail 2.txt'

app.whenReady().then(async () => {
  const eng = new FBRegisterEngine({})
  const gmailCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim()
  console.log('[test] Cookie Gmail: ' + gmailCookie.length + ' ký tự | format: ' + (gmailCookie.startsWith('[') ? 'JSON array' : 'string flatten'))

  const res = await eng.registerSingleAccount({
    mode: 'tempmail',
    emailProvider: 'gmail',
    proxy: null,
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
