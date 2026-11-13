// Harness test E2E luồng REG TIKTOK với cookie thật từ AUTO_BM accounts.json
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { TikTokEngine } = require('./tiktok')

const LOG = []
function log(m) {
  LOG.push(String(m))
  console.log(String(m))
  try { fs.appendFileSync(path.join(__dirname, 'tiktok_test_stdout.log'), String(m) + '\n', 'utf8') } catch {}
}

// Không cho electron tự thoát khi cửa sổ đóng giữa chừng - engine tự quyết khi nào xong
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  let cookieStr = ''
  const wantUid = process.argv[2] || '61591170976216'
  try {
    const cookieFile = path.join(__dirname, 'tiktok_test_cookie.txt')
    if (fs.existsSync(cookieFile)) {
      const raw = fs.readFileSync(cookieFile, 'utf8').trim()
      const parts = raw.split('|')
      if (parts.length >= 3) {
        cookieStr = parts.slice(2).join('|').trim()
        const uidLabel = String(parts[0]).trim().split(/\s+/).pop()
        log('OK: dùng cookie từ file tiktok_test_cookie.txt (uid ' + uidLabel + ', ' + cookieStr.length + ' ký tự)')
      } else {
        cookieStr = raw
        log('OK: dùng cookie từ file tiktok_test_cookie.txt (' + raw.length + ' ký tự)')
      }
    } else {
      const accs = JSON.parse(fs.readFileSync('C:/Users/Admin/Downloads/Duan/AUTO_BM/accounts.json', 'utf8'))
      const list = Array.isArray(accs) ? accs : (accs.accounts || [])
      const entry = list.find(a => a.uid === wantUid)
      if (!entry || !entry.cookie) {
        log('!! Không tìm thấy account ' + wantUid + ' trong accounts.json')
        app.exit(1)
        return
      }
      cookieStr = entry.cookie
      log('OK: nạp được cookie Netscape cho ' + wantUid + ' (' + cookieStr.length + ' ký tự)')
    }
  } catch (e) {
    log('!! Lỗi đọc accounts.json: ' + e.message)
    app.exit(1)
    return
  }

  const eng = new TikTokEngine({
    cookie: cookieStr,
    showBrowser: true,
    slot: 0,
    onLog: (m) => log('[TT] ' + m)
  })

  log('=== BẮT ĐẦU RUN TikTokEngine ===')
  const res = await eng.run()
  log('=== RESULT: ' + JSON.stringify({
    success: res.success,
    uid: res.uid,
    fbName: res.fbName,
    reason: res.reason || '',
    ttCookieLen: (res.ttCookie || '').length,
    ttCookiePreview: (res.ttCookie || '').slice(0, 60)
  }) + ' ===')

  try {
    fs.writeFileSync(path.join(__dirname, 'tiktok_test_report.json'),
      JSON.stringify({ result: { ...res, ttCookie: (res.ttCookie || '').slice(0, 60) + '...' }, log: LOG }, null, 2), 'utf8')
  } catch {}
  app.exit(res.success ? 0 : 2)
})
