const { app, BrowserWindow } = require('electron')
const path = require('path')
app.on('window-all-closed', e => e.preventDefault())
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js') } })
  await win.loadFile('index.html')
  await new Promise(r => setTimeout(r, 1500))
  const info = await win.webContents.executeJavaScript(`(function(){
    document.getElementById('side-tab-ckpt').click();
    var b = document.getElementById('btn-ckpt-photodir');
    var r = b.getBoundingClientRect();
    var topEl = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
    return JSON.stringify({ x: Math.round(r.x), w: Math.round(r.width), trongKhung: r.right <= window.innerWidth && r.x >= 0,
      clickDuoc: topEl === b || b.contains(topEl), viewportW: window.innerWidth });
  })()`).catch(e => 'EVAL_ERR: ' + e.message)
  console.log('NARROW_GEOMETRY: ' + info)
  app.quit()
}).catch(e => { console.error('LOI: ' + e.message); app.quit() })
