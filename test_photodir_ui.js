// Test bấm nút "Chọn thư mục ảnh" — kiểm tra handler wired + bắt lỗi console
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.on('window-all-closed', (e) => e.preventDefault())

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true }
  })
  const errs = []
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) errs.push(msg.substring(0, 160)) })
  await win.loadFile('index.html')
  await new Promise(r => setTimeout(r, 2000))

  const j = async (expr) => win.webContents.executeJavaScript(expr).catch(e => 'EVAL_ERR: ' + e.message)
  // sang tab ckpt
  await j(`document.getElementById('side-tab-ckpt').click()`)
  await new Promise(r => setTimeout(r, 500))
  console.log('[1] Nút tồn tại:', await j(`!!document.getElementById('btn-ckpt-photodir')`))
  console.log('[2] onclick gán:', await j(`typeof document.getElementById('btn-ckpt-photodir').onclick`))
  console.log('[3] window.api.pickCkptPhotoFolder:', await j(`typeof window.api.pickCkptPhotoFolder`))
  // Bấm thật
  await j(`document.getElementById('btn-ckpt-photodir').click()`)
  await new Promise(r => setTimeout(r, 2500))
  console.log('[4] Lỗi console sau bấm:', errs.length ? JSON.stringify(errs.slice(0, 3)) : 'KHÔNG')
  // Bọc try để thấy lỗi promise
  const r2 = await j(`(async () => { try { await window.api.pickCkptPhotoFolder(); return 'OK không lỗi' } catch (e) { return 'INVOKE LỖI: ' + e.message } })()`)
  console.log('[5] Gọi trực tiếp:', r2)
  app.quit()
}).catch(e => { console.error('LỖI:', e.message); app.quit() })
