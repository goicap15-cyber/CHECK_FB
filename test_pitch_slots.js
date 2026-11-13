// Chia captcha theo pitch (6 ô đều) -> OCR từng ô PSM10 (single char) + xuất montage để đối chiếu
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
    const { createWorker } = require('tesseract.js')
    const w = await createWorker('eng', 1, { langPath: './tessdata', gzip: false })
    await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '10' })

    const allSlots = []
    for (const f of FILES) {
      const p = path.join(__dirname, f)
      if (!fs.existsSync(p)) continue
      const b64 = fs.readFileSync(p).toString('base64')
      // b1: binarize @3x + tìm band chữ + best pitch/offset + cắt 6 ô
      const slots = await win.webContents.executeJavaScript(`(function(){
        return new Promise(function(done){
          var img = new Image();
          img.onload = function(){
            try {
              var scale = 3, sw = img.naturalWidth, sh = img.naturalHeight;
              var W = sw * scale, H = sh * scale;
              var c = document.createElement('canvas'); c.width = W; c.height = H;
              var ctx = c.getContext('2d');
              ctx.imageSmoothingEnabled = true;
              ctx.drawImage(img, 0, 0, W, H);
              var px = ctx.getImageData(0, 0, W, H).data;
              var bin = new Uint8Array(W * H);
              for (var q = 0, i2 = 0; q < bin.length; q++, i2 += 4) bin[q] = (((px[i2] + px[i2+1] + px[i2+2]) / 3) < 160) ? 1 : 0;
              // row profile -> band chữ (dải dòng liên tục dày nhất)
              var rowProf = [];
              for (var y = 0; y < H; y++) { var s = 0; for (var x = 0; x < W; x++) s += bin[y * W + x]; rowProf.push(s); }
              var bestY0 = 0, bestY1 = 0;
              for (var y1 = 0; y1 < H; y1++) {
                for (var y2 = y1 + 40; y2 < Math.min(H, y1 + 160); y2++) {
                  var m = 0; for (var y = y1; y <= y2; y++) m += rowProf[y];
                  if (m / (y2 - y1 + 1) > (bestY1 - bestY0 + 1 ? 0 : 1e9) || (bestY1 <= bestY0 && m > 0)) {}
                }
              }
              // đơn giản hoá: band = các dòng có ink >= 25% max
              var mx = Math.max.apply(null, rowProf);
              var ys = []; for (var y3 = 0; y3 < H; y3++) if (rowProf[y3] >= mx * 0.25) ys.push(y3);
              var bandY0 = ys[0], bandY1 = ys[ys.length - 1];
              if (bandY1 - bandY0 < 60) { done({ err: 'BAND_NHO' }); return; }
              // col profile trong band
              var colProf = [];
              for (var x4 = 0; x4 < W; x4++) { var s4 = 0; for (var y4 = bandY0; y4 <= bandY1; y4++) s4 += bin[y4 * W + x4]; colProf.push(s4); }
              // best pitch/offset: 6 ô, pitch 84..120@3x, maximize tổng ink
              var best = null;
              for (var pitch = 84; pitch <= 122; pitch += 2) {
                for (var off = 6; off <= 40; off += 2) {
                  var tot = 0;
                  for (var d = 0; d < 6; d++) {
                    var x0 = off + d * pitch;
                    if (x0 + pitch - 6 > W) { tot = -1; break; }
                    for (var x5 = x0; x5 < x0 + pitch - 6; x5++) tot += colProf[x5];
                  }
                  if (tot >= 0 && (!best || tot > best.tot)) best = { pitch: pitch, off: off, tot: tot };
                }
              }
              if (!best) { done({ err: 'PITCH' }); return; }
              function slotPng(d) {
                var x0 = best.off + d * best.pitch, x1 = x0 + best.pitch - 6;
                var y0 = bandY0, y1 = bandY1;
                var cw = x1 - x0, ch = y1 - y0;
                var cc = document.createElement('canvas'); cc.width = cw; cc.height = ch;
                var cx = cc.getContext('2d');
                var im = cx.createImageData(cw, ch);
                for (var yy = 0; yy < ch; yy++) for (var xx = 0; xx < cw; xx++) {
                  var g = bin[(yy + y0) * W + (xx + x0)] ? 0 : 255;
                  var o = (yy * cw + xx) * 4;
                  im.data[o] = im.data[o+1] = im.data[o+2] = g; im.data[o+3] = 255;
                }
                cx.putImageData(im, 0, 0);
                return cc.toDataURL('image/png').split(',')[1];
              }
              done({ pitch: best.pitch, off: best.off, band: [bandY0, bandY1], slots: [0,1,2,3,4,5].map(slotPng) });
            } catch (e) { done({ err: String(e && e.name || e) }) }
          };
          img.onerror = function(){ done({ err: 'IMG_LOI' }) };
          img.src = 'data:image/png;base64,${b64}';
        });
      })()`, 30000)
      if (slots.err) { console.log(f, 'LỖI', slots.err); continue }
      console.log(`=== ${f} pitch=${slots.pitch} off=${slots.off} band=${slots.band.join('-')} ===`)
      let digits = ''
      for (let d = 0; d < 6; d++) {
        fs.writeFileSync(path.join(__dirname, `slot_${f.match(/(\\d)/)[1]}_${d}.png`), Buffer.from(slots.slots[d], 'base64'))
        const { data } = await w.recognize(Buffer.from(slots.slots[d], 'base64'))
        const ch = String(data.text || '').replace(/\\D/g, '')
        digits += (ch || '?')
        allSlots.push({ file: f, slot: d, b64: slots.slots[d] })
        console.log(`  ô ${d + 1}: "${ch}" conf ${Math.round(data.confidence || 0)}`)
      }
      console.log(`  => CHUỖI: ${digits}`)
    }
    await w.terminate()

    // montage 6 cột × N dòng để vision đối chiếu
    const montage = await win.webContents.executeJavaScript(`(function(){
      var imgs = ${JSON.stringify(allSlots.map(s => s.b64))};
      return new Promise(function(done){
        var loaded = 0, total = imgs.length;
        if (!total) return done(null);
        var canv = [];
        for (var i = 0; i < total; i++) {
          (function(idx){
            var im = new Image();
            im.onload = function(){ canv[idx] = im; if (++loaded === total) {
              var CW = 100, CH = 160, GAP = 10, cols = 6, rows = Math.ceil(total / cols);
              var c = document.createElement('canvas');
              c.width = cols * (CW + GAP) + GAP; c.height = rows * (CH + GAP) + GAP;
              var ctx = c.getContext('2d');
              ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
              ctx.strokeStyle = '#999'; ctx.lineWidth = 2;
              for (var r = 0; r < rows; r++) for (var col = 0; col < cols; col++) {
                var k = r * cols + col; if (k >= total) break;
                var x0 = GAP + col * (CW + GAP), y0 = GAP + r * (CH + GAP);
                ctx.strokeRect(x0 - 3, y0 - 3, CW + 6, CH + 6);
                var g = canv[k];
                var sc = Math.min(CW / g.width, CH / g.height);
                ctx.drawImage(g, x0 + Math.round((CW - g.width * sc) / 2), y0 + Math.round((CH - g.height * sc) / 2), Math.round(g.width * sc), Math.round(g.height * sc));
              }
              done(c.toDataURL('image/png').split(',')[1]);
            } };
            im.onerror = function(){ canv[idx] = null; if (++loaded === total) done(null); };
            im.src = 'data:image/png;base64,' + imgs[idx];
          })(i);
        }
      });
    })()`, 30000)
    if (montage) fs.writeFileSync(path.join(__dirname, 'slot_montage.png'), Buffer.from(montage, 'base64'))
    console.log('slot_montage.png OK')
    win.destroy()
    app.quit()
  } catch (e) { console.error('ERR:', e.message); app.exit(1) }
})
