// Test UI: mở app, bấm sidebar GIẢI CHECKPOINT qua CDP, kiểm tra view + chụp màn hình
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const WebSocket = require('ws')

const ELECTRON = 'node_modules/electron/dist/electron.exe'
const PORT = 9223
const SHOT = __dirname + '/test_ckpt_ui_shot.png'

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let b = ''
      res.on('data', c => b += c)
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

;(async () => {
  const app = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT], { cwd: __dirname, detached: false })
  let targets = null
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    try { targets = await getJson('/json/list'); if (targets.length) break } catch {}
  }
  if (!targets) { console.log('KHÔNG kết nối được CDP'); app.kill(); process.exit(1) }
  const page = targets.find(t => t.type === 'page' && (t.url || '').includes('index.html')) || targets.find(t => t.type === 'page')
  console.log('Page:', page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise(r => ws.on('open', r))
  let msgId = 0
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++msgId
    const onMsg = (data) => {
      const m = JSON.parse(data)
      if (m.id === id) { ws.off('message', onMsg); resolve(m.result) }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value

  await sleep(2500) // đợi app render xong
  // Bấm sidebar GIẢI CHECKPOINT
  const clicked = await evalJs(`(function(){ var b = document.getElementById('side-tab-ckpt'); if (!b) return 'KHÔNG THẤY NÚT'; b.click(); return 'CLICKED'; })()`)
  console.log('Bấm nút:', clicked)
  await sleep(1500)
  // Trạng thái các view
  const state = await evalJs(`(function(){
    var v = document.getElementById('view-ckpt');
    var info = { viewTonTai: !!v, display: v ? v.style.display : 'N/A', con: v ? v.children.length : 0,
                 innerLen: v ? v.innerHTML.length : 0 };
    var views = Array.from(document.querySelectorAll('.app-view')).map(function(x){ return x.id + ':' + (x.style.display || getComputedStyle(x).display); });
    info.allViews = views.join(', ');
    var stats = document.getElementById('stat-ckpt-total');
    info.coStats = !!stats;
    return JSON.stringify(info);
  })()`)
  console.log('View state:', state)
  // Lỗi console renderer
  const errs = await evalJs(`window.__uiErrors || 'không có'`)
  console.log('Lỗi UI ghi nhận:', errs)
  // Chụp màn hình toàn cửa sổ
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  console.log('Đã lưu screenshot:', SHOT)
  ws.close()
  app.kill()
  setTimeout(() => process.exit(0), 1500)
})().catch(e => { console.error('LỖI TEST:', e.message); process.exit(1) })
