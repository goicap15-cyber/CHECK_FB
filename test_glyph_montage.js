// Cắt glyph chữ số từ captcha raw (binarize 3x -> opening nhẹ -> component cao) -> montage lưới to
// để vision đọc nhãn chính xác (ảnh sạch, phóng to, không噪音)
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
    const allGlyphs = []
    const boxesInfo = []
    for (const f of FILES) {
      const p = path.join(__dirname, f)
      if (!fs.existsSync(p)) continue
      const b64 = fs.readFileSync(p).toString('base64')
      const res = await win.webContents.executeJavaScript(`(function(){
        return new Promise(function(done){
          var img = new Image();
          img.onload = function(){
            try {
              var scale = 3;
              var W = img.naturalWidth * scale, H = img.naturalHeight * scale;
              var c = document.createElement('canvas'); c.width = W; c.height = H;
              var ctx = c.getContext('2d');
              ctx.imageSmoothingEnabled = true;
              ctx.drawImage(img, 0, 0, W, H);
              var px = ctx.getImageData(0, 0, W, H).data;
              var bin = new Uint8Array(W * H);
              for (var q = 0, i2 = 0; q < bin.length; q++, i2 += 4) bin[q] = (((px[i2] + px[i2+1] + px[i2+2]) / 3) < 128) ? 1 : 0;
              function morph(arr, r, isDilate) {
                if (!r) return arr;
                var t1 = new Uint8Array(W * H), t2 = new Uint8Array(W * H);
                for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
                  var v = isDilate ? 0 : 1;
                  for (var k = -r; k <= r; k++) {
                    var xx = Math.min(W - 1, Math.max(0, x + k));
                    var s = arr[y * W + xx];
                    if (isDilate) { if (s) { v = 1; break; } } else { if (!s) { v = 0; break; } }
                  }
                  t1[y * W + x] = v;
                }
                for (var x2 = 0; x2 < W; x2++) for (var y2 = 0; y2 < H; y2++) {
                  var v2 = isDilate ? 0 : 1;
                  for (var k2 = -r; k2 <= r; k2++) {
                    var yy = Math.min(H - 1, Math.max(0, y2 + k2));
                    var s2 = t1[yy * W + x2];
                    if (isDilate) { if (s2) { v2 = 1; break; } } else { if (!s2) { v2 = 0; break; } }
                  }
                  t2[y2 * W + x2] = v2;
                }
                return t2;
              }
              var opened = morph(morph(bin, 4, false), 4, true); // opening r4@3x (~1.3px native)
              // component 8-conn trên ảnh đã mở
              var comp = new Int32Array(W * H).fill(-1), comps = [];
              for (var s = 0; s < opened.length; s++) {
                if (!opened[s] || comp[s] !== -1) continue;
                var id = comps.length, stack = [s], n = 0, minX = W, maxX = 0, minY = H, maxY = 0;
                while (stack.length) {
                  var cur = stack.pop();
                  if (comp[cur] === id) continue;
                  comp[cur] = id; n++;
                  var cx = cur % W, cy = (cur - cx) / W;
                  if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                  if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
                  var nb = [cur-1, cur+1, cur-W, cur+W, cur-W-1, cur-W+1, cur+W-1, cur+W+1];
                  for (var t = 0; t < 8; t++) { var q2 = nb[t]; if (q2 >= 0 && q2 < opened.length && opened[q2] && comp[q2] === -1) stack.push(q2); }
                }
                comps.push({ id: id, n: n, minX: minX, maxX: maxX, minY: minY, maxY: maxY });
              }
              // glyph ứng viên: cao >= 55px@3x (digit ~90-105), rộng <= 140
              var glyphs = comps.filter(function(cc){ return (cc.maxY - cc.minY + 1) >= 55 && (cc.maxX - cc.minX + 1) <= 140 && cc.n >= 60; })
                .sort(function(a,b){ return a.minX - b.minX; });
              // crop từng glyph từ ảnh opened, scale về cell 50x74, trả kèm vị trí
              function crop(cc) {
                var gw = cc.maxX - cc.minX + 1, gh = cc.maxY - cc.minY + 1;
                var sc = Math.min(50 / gw, 74 / gh);
                var nw = Math.max(1, Math.round(gw * sc)), nh = Math.max(1, Math.round(gh * sc));
                var cc2 = document.createElement('canvas'); cc2.width = nw; cc2.height = nh;
                var cx2 = cc2.getContext('2d');
                var im = cx2.createImageData(nw, nh);
                for (var y3 = 0; y3 < nh; y3++) for (var x3 = 0; x3 < nw; x3++) {
                  var sx = cc.minX + Math.floor(x3 / sc), sy = cc.minY + Math.floor(y3 / sc);
                  var g = opened[sy * W + sx] ? 0 : 255;
                  var o = (y3 * nw + x3) * 4;
                  im.data[o] = im.data[o+1] = im.data[o+2] = g; im.data[o+3] = 255;
                }
                cx2.putImageData(im, 0, 0);
                return cc2.toDataURL('image/png').split(',')[1];
              }
              done({ glyphs: glyphs.map(function(cc){ return { b64: crop(cc), x: cc.minX, w: cc.maxX - cc.minX + 1, h: cc.maxY - cc.minY + 1, n: cc.n }; }) });
            } catch (e) { done({ err: String(e && e.name || e) }) }
          };
          img.onerror = function(){ done({ err: 'IMG_LOI' }) };
          img.src = 'data:image/png;base64,${b64}';
        });
      })()`, 30000)
      if (res.err) { console.log(f, 'LỖI', res.err); continue }
      console.log(`${f}: ${res.glyphs.length} glyph — ` + res.glyphs.map(g => `${g.w}x${g.h}@${g.x}`).join(' '))
      for (const g of res.glyphs) { allGlyphs.push({ file: f, ...g }) }
    }

    // montage: mỗi dòng 6 cell (cell 60x90, glyph 50x74 căn giữa), nền trắng
    const cols = 6
    const rows = Math.ceil(allGlyphs.length / cols)
    const CW = 60, CH = 90, GAP = 8
    const mw = cols * (CW + GAP) + GAP
    const mh = rows * (CH + GAP) + GAP
    const montage = await win.webContents.executeJavaScript(`(function(){
      var imgs = ${JSON.stringify(allGlyphs.map(g => g.b64))};
      return new Promise(function(done){
        var loaded = 0, total = imgs.length;
        if (!total) return done(null);
        var canv = [];
        for (var i = 0; i < total; i++) {
          (function(idx){
            var im = new Image();
            im.onload = function(){
              canv[idx] = im;
              if (++loaded === total) {
                var cols = ${cols}, CW = ${CW}, CH = ${CH}, GAP = ${GAP};
                var rows = Math.ceil(total / cols);
                var c = document.createElement('canvas');
                c.width = ${mw}; c.height = ${mh};
                var ctx = c.getContext('2d');
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
                ctx.strokeStyle = '#ccc';
                for (var r = 0; r < rows; r++) for (var col = 0; col < cols; col++) {
                  var k = r * cols + col;
                  if (k >= total) break;
                  var x0 = GAP + col * (CW + GAP), y0 = GAP + r * (CH + GAP);
                  ctx.strokeRect(x0 - 2, y0 - 2, CW + 4, CH + 4);
                  var g = canv[k];
                  ctx.drawImage(g, x0 + Math.round((CW - g.width) / 2), y0 + Math.round((CH - g.height) / 2));
                }
                done(c.toDataURL('image/png').split(',')[1]);
              }
            };
            im.onerror = function(){ canv[idx] = null; if (++loaded === total) done(null); };
            im.src = 'data:image/png;base64,' + imgs[idx];
          })(i);
        }
      });
    })()`, 30000)
    if (montage) {
      fs.writeFileSync(path.join(__dirname, 'glyph_montage.png'), Buffer.from(montage, 'base64'))
      console.log('montage OK: glyph_montage.png (' + allGlyphs.length + ' glyph, ' + rows + ' dòng)')
    }
    fs.writeFileSync(path.join(__dirname, 'glyph_boxes.json'), JSON.stringify(allGlyphs.map(g => ({ file: g.file, x: g.x, w: g.w, h: g.h })), null, 1))
    win.destroy()
    app.quit()
  } catch (e) { console.error('ERR:', e.message); app.exit(1) }
})
