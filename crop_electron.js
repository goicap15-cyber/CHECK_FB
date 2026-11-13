const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const [,, src, dst, fromRatio] = process.argv
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true } })
    await win.loadURL('about:blank')
    const b64 = fs.readFileSync(src).toString('base64')
    const out = await win.webContents.executeJavaScript(`(function(){
      return new Promise(function(done){
        var img = new Image();
        img.onload = function(){
          var y0 = Math.round(img.height * ${Number(fromRatio || 0.5)});
          var c = document.createElement('canvas');
          c.width = img.width; c.height = img.height - y0;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, -y0);
          done(c.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = function(){ done(null) };
        img.src = 'data:image/png;base64,${b64}';
      });
    })()`, 20000)
    if (out) { fs.writeFileSync(dst, Buffer.from(out, 'base64')); console.log('CROPPED OK') }
    else console.log('CROP FAIL')
    app.quit()
  } catch (e) { console.error('ERR', e.message); app.exit(1) }
})
