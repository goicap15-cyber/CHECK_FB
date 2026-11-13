// E2E: dung dung tham so user chay loi - BM 1423423093329121, "BM FB", Hanoi, VND
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { FBAdAccEngine } = require('./fbadacc.js')

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'bm_acc_cookie.json'), 'utf8'))
const OUT = path.join(__dirname, 'bm_acc_report.json')

const logs = []
const write = obj => { try { fs.writeFileSync(OUT, JSON.stringify(obj, null, 2)) } catch {} }

app.whenReady().then(async () => {
  write({ partial: true, logs })
  const engine = new FBAdAccEngine({
    cookie: DATA.cookieStr,
    businessId: '1423423093329121',
    accName: 'BM FB',
    timezone: 'Asia/Ho_Chi_Minh',
    currency: 'VND',
    showBrowser: true,
    onLog: m => { logs.push(m); write({ partial: true, logs }); process.stdout.write('[AdAcc] ' + m + '\n') }
  })
  const result = await engine.createAdAccount()
  write({ result, logs })
  app.exit(0)
}).catch(e => { write({ fatal: e.message, logs }); app.exit(0) })

app.on('window-all-closed', () => { write({ abortedByWindowClose: true, logs }); app.exit(0) })
