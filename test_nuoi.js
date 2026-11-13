// Test nuôi nick: verify www.facebook.com (không còn m.facebook), like/kết bạn/nhóm hoạt động
// Chạy: node_modules\electron\dist\electron.exe test_nuoi.js
const { app } = require('electron')
const { FBNuoiEngine } = require('./fbnuoi.js')
const fs = require('fs')

// cleanup destroy cửa sổ cuối -> Electron mặc định thoát app, mất dòng kết quả
app.on('window-all-closed', (e) => e.preventDefault())

const ACC_LINE = fs.readFileSync(__dirname + '/test_nuoi_acc.txt', 'utf8').trim()

app.whenReady().then(async () => {
  const parts = ACC_LINE.replace(/^\[[^\]]*\]\s*/, '').split('|')
  const cookieIdx = parts.findIndex(p => p.includes('xs=') || p.includes('c_user='))
  const acc = {
    uid: (parts[0] || '').match(/^\d{6,}$/) ? parts[0] : '',
    pass: parts[2] || '',
    twofa: parts[3] || '',
    cookie: parts.slice(cookieIdx === -1 ? 3 : cookieIdx).join('|')
  }
  console.log('[test] Nuôi UID ' + acc.uid + ' (2FA: ' + (acc.twofa ? 'có' : 'không') + ')')
  const eng = new FBNuoiEngine({
    showBrowser: true,
    slot: 0,
    minutes: 4,           // đủ giờ cho cả 3 phase (feed/friends/groups ~96/72/72s)
    onLog: (m) => console.log(m)
  })
  const res = await eng.run(acc)
  console.log('[test] KẾT QUẢ: ' + JSON.stringify({ status: res.status, error: (res.error || '').substring(0, 150), stats: res.stats }))
  setTimeout(() => app.quit(), 5000)
}).catch(e => { console.error('[test] LỖI:', e.message); app.quit() })
