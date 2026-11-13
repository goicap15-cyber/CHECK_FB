// Phân tích màu pixel của captcha raw: histogram màu, đếm nhóm màu (chữ vs nét nhiễu vs nền)
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const FILES = process.argv.slice(2).length ? process.argv.slice(2) : ['captcha_raw_1.png', 'captcha_raw_2.png', 'captcha_raw_3.png']
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true } })
    await win.loadURL('about:blank')
    for (const f of FILES) {
      const p = path.join(__dirname, f)
      if (!fs.existsSync(p)) { console.log(f, 'KHÔNG TỒN TẠI'); continue }
      const b64 = fs.readFileSync(p).toString('base64')
      const res = await win.webContents.executeJavaScript(`(function(){
        return new Promise(function(done){
          var img = new Image();
          img.onload = function(){
            var W = img.naturalWidth, H = img.naturalHeight;
            var c = document.createElement('canvas'); c.width = W; c.height = H;
            var ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            var px = ctx.getImageData(0, 0, W, H).data;
            // đếm màu chính xác (bỏ alpha=0)
            var map = {};
            var dark = 0, total = 0;
            var samples = [];
            for (var i = 0; i < px.length; i += 4) {
              if (px[i+3] < 10) continue;
              var key = px[i] + ',' + px[i+1] + ',' + px[i+2];
              map[key] = (map[key] || 0) + 1;
              total++;
              if ((px[i] + px[i+1] + px[i+2]) / 3 < 128) dark++;
            }
            var top = Object.entries(map).sort(function(a,b){ return b[1]-a[1]; }).slice(0, 12)
              .map(function(e){ return e[0] + ':' + e[1]; });
            // màu tối: phân bố RGB
            var darkCols = {};
            for (var j = 0; j < px.length; j += 4) {
              if (px[j+3] < 10) continue;
              var v = (px[j] + px[j+1] + px[j+2]) / 3;
              if (v < 128) {
                var q = Math.round(px[j]/32) + ',' + Math.round(px[j+1]/32) + ',' + Math.round(px[j+2]/32);
                darkCols[q] = (darkCols[q] || 0) + 1;
              }
            }
            var darkTop = Object.entries(darkCols).sort(function(a,b){ return b[1]-a[1]; }).slice(0, 10)
              .map(function(e){ return e[0] + ':' + e[1]; });
            done({ W: W, H: H, total: total, dark: dark, topColors: top, darkClusters: darkTop });
          };
          img.onerror = function(){ done({ err: 'IMG_LOI' }) };
          img.src = 'data:image/png;base64,${b64}';
        });
      })()`, 20000)
      if (res.err) { console.log(f, 'LỖI', res.err); continue }
      console.log('=== ' + f + ' (' + res.W + 'x' + res.H + ') px=' + res.total + ' dark=' + res.dark + ' (' + (100 * res.dark / res.total).toFixed(1) + '%) ===')
      console.log('  Màu chủ đạo:', res.topColors.join(' | '))
      console.log('  Cụm màu tối (quant 32):', res.darkClusters.join(' | '))
    }
    win.destroy()
    app.quit()
  } catch (e) { console.error('ERR:', e.message); app.exit(1) }
})
