const { app, BrowserWindow } = require('electron')
const path = require('path')
app.on('window-all-closed', e => e.preventDefault())
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 900, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js') } })
  await win.loadFile('index.html')
  await new Promise(r => setTimeout(r, 1500))
  const info = await win.webContents.executeJavaScript(`(function(){
    document.getElementById('side-tab-ckpt').click();
    var b = document.getElementById('btn-ckpt-photodir');
    var r = b.getBoundingClientRect();
    var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    var topEl = document.elementFromPoint(cx, cy);
    return JSON.stringify({
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      trongKhung: r.x >= 0 && r.y >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      phanTuTrenCung: topEl ? (topEl.id || topEl.tagName + '.' + String(topEl.className).substring(0, 40)) : 'null',
      laChinhNoHoacCon: topEl === b || b.contains(topEl),
      viewport: { w: window.innerWidth, h: window.innerHeight }
    });
  })()`).catch(e => 'EVAL_ERR: ' + e.message)
  console.log('BUTTON_GEOMETRY: ' + info)
  app.quit()
}).catch(e => { console.error('LOI: ' + e.message); app.quit() })
