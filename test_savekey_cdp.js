// Test nút Lưu key Mail.td trên UI app thật qua CDP (remote debugging)
// Dùng: node test_savekey_cdp.js
const http = require('http')
const WebSocket = require('ws')
const fs = require('fs')

const KEY = 'td_a7ee6df0133f3644898dd9b75b7d1853d71047d485e893d0988effc305512dc8'
const KEY_FILE = 'build/FB-Cookie-Checker-win32-x64/resources/app/mailtd_key.txt'
const DEBUG_PORT = 9333

function fileState() {
  try {
    const st = fs.statSync(KEY_FILE)
    return { mtime: st.mtime.toISOString(), content: fs.readFileSync(KEY_FILE, 'utf8').substring(0, 20) + '...' }
  } catch (e) { return { missing: true } }
}

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${DEBUG_PORT}/json/list`, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function evaluate(ws, id, expression) {
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      const m = JSON.parse(raw)
      if (m.id === id) {
        ws.off('message', onMsg)
        if (m.error) reject(new Error(m.error.message))
        else resolve(m.result && m.result.result ? m.result.result.value : null)
      }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    setTimeout(() => { ws.off('message', onMsg); reject(new Error('CDP timeout')) }, 20000)
  })
}

async function main() {
  console.log('=== TRƯỚC KHI BẤM LƯU ===')
  console.log('file key:', JSON.stringify(fileState()))

  const targets = await getTargets()
  const page = targets.find(t => t.type === 'page' && (t.url || '').includes('index.html'))
  if (!page) { console.log('KHÔNG thấy trang app:', targets.map(t => t.url)); process.exit(1) }
  console.log('Trang:', page.title, '|', page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  let idc = 0

  // Dán key vào ô input
  const v1 = await evaluate(ws, ++idc, `(function(){
    var inp = document.getElementById('setting-mailtdkey');
    if (!inp) return 'NO_INPUT';
    inp.value = ${JSON.stringify(KEY)};
    inp.dispatchEvent(new Event('input', {bubbles: true}));
    return 'SET:' + inp.value.substring(0, 14) + '...';
  })()`)
  console.log('Dán key:', v1)

  // Bấm nút Lưu
  const v2 = await evaluate(ws, ++idc, `(function(){
    var btn = document.getElementById('btn-save-mailtdkey');
    if (!btn) return 'NO_BTN';
    btn.click();
    return 'CLICKED, label=' + btn.textContent.trim() + ', disabled=' + btn.disabled;
  })()`)
  console.log('Bấm Lưu:', v2)

  // Theo dõi trạng thái nút + toast tại 2s, 8s, 20s, 40s
  for (const waitMs of [2000, 8000, 20000, 40000]) {
    await sleep(waitMs === 2000 ? 2000 : waitMs - [0, 2000, 8000, 20000][[2000, 8000, 20000, 40000].indexOf(waitMs)])
    const st = await evaluate(ws, ++idc, `(function(){
      var btn = document.getElementById('btn-save-mailtdkey');
      var toast = document.getElementById('toast');
      return JSON.stringify({
        label: btn ? btn.textContent.trim() : '?',
        disabled: btn ? btn.disabled : '?',
        toast: toast ? toast.textContent : '?',
        toastShown: toast ? toast.classList.contains('show') : false
      });
    })()`)
    console.log(`[${(waitMs / 1000).toFixed(0)}s] nút+toast:`, st)
    const parsed = JSON.parse(st)
    if (parsed.label && parsed.label !== 'Test...' && !String(parsed.label).includes('Test')) {
      console.log('>>> Nút THOÁT trạng thái Test (không kẹt). Toast cuối:', parsed.toast)
      break
    }
  }

  console.log('=== SAU KHI BẤM LƯU ===')
  console.log('file key:', JSON.stringify(fileState()))
  ws.close()
  process.exit(0)
}

main().catch(e => { console.error('TEST ERR:', e.message); process.exit(1) })
