// Test UI không cần CDP: nạp index.html + preload + renderer thật, bấm nút sidebar, đọc view
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

app.on('window-all-closed', (e) => e.preventDefault())

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true
    }
  })
  // Bắt lỗi renderer
  const errs = []
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) errs.push(msg) })
  win.webContents.on('render-process-gone', (e, d) => errs.push('render-process-gone: ' + d.reason))

  await win.loadFile('index.html')
  await new Promise(r => setTimeout(r, 2500))

  const j = async (expr) => win.webContents.executeJavaScript(expr).catch(e => 'EVAL_ERR: ' + e.message)

  // 1. Nút sidebar tồn tại?
  console.log('[1] Nút GIẢI CHECKPOINT:', await j(`!!document.getElementById('side-tab-ckpt')`))
  // 2. Bấm nút
  console.log('[2] Click:', await j(`(function(){ var b=document.getElementById('side-tab-ckpt'); if(!b) return 'MISSING'; b.click(); return 'CLICKED'; })()`))
  await new Promise(r => setTimeout(r, 800))
  // 3. View-ckpt hiển thị + có nội dung?
  const st = await j(`(function(){
    var v = document.getElementById('view-ckpt');
    return JSON.stringify({ display: v ? getComputedStyle(v).display : 'MISSING',
      con: v ? v.children.length : 0, innerLen: v ? v.innerHTML.length : 0,
      statCard: !!document.getElementById('stat-ckpt-total'),
      btnStart: !!document.getElementById('btn-ckpt-start'),
      proxyInput: !!document.getElementById('ckpt-proxy-input'),
      concurrency: !!document.getElementById('ckpt-concurrency') });
  })()`)
  console.log('[3] View state:', st)
  // 4. Lỗi renderer?
  console.log('[4] Lỗi renderer:', errs.length ? errs.slice(0, 5) : 'KHÔNG')
  // 5. Chụp màn hình view ckpt
  try {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(__dirname, 'test_ckpt_view.png'), img.toPNG())
    console.log('[5] Screenshot: test_ckpt_view.png')
  } catch (e) { console.log('[5] Chụp lỗi:', e.message) }
  app.quit()
}).catch(e => { console.error('LỖI:', e.message); app.quit() })
