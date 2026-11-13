// Harness test SMS mode: thuê số thật -> điền form r.php -> abort trước Submit -> refund
const { app } = require('electron')
const fs = require('fs')
const FBRegisterEngine = require('./fbreg.js')

const LOG = 'test_sms_stdout.log'
const orig = console.log
console.log = (...a) => { orig(...a); try { fs.appendFileSync(LOG, a.join(' ') + '\n') } catch {} }

// Chặn auto-quit khi engine.abort() đóng cửa sổ, để promise kịp resolve + refund số
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const engine = new FBRegisterEngine()
  let done = false
  const resPromise = engine.registerSingleAccount({
    mode: 'sms',
    showBrowser: true,
    proxy: null,
    onLog: (m) => console.log(m)
  }).then(r => { done = true; return r })

  // Abort ngay khi thấy log chọn ngày sinh (trước Submit) -> releaseSms hủy số hoàn tiền
  const iv = setInterval(() => {
    if (done) { clearInterval(iv); return }
    try {
      const txt = fs.readFileSync(LOG, 'utf8')
      if (txt.includes('Chọn ngày sinh') || txt.includes('Chọn giới tính')) {
        clearInterval(iv)
        console.log('>>> HARNESS: abort trước khi Submit để hủy số hoàn tiền...')
        engine.abort()
      }
    } catch {}
  }, 400)

  // An toàn: 150s vẫn chưa xong thì abort cứng
  setTimeout(() => { if (!done) { console.log('>>> HARNESS: timeout 150s, abort cứng'); engine.abort() } }, 150000)

  const res = await resPromise
  clearInterval(iv)
  console.log('>>> RESULT:', JSON.stringify(res, null, 2))
  fs.writeFileSync('test_sms_report.json', JSON.stringify(res, null, 2))
  app.exit(0)
})
