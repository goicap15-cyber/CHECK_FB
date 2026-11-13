// Test morphological opening trên captcha FB thật (đã nhị phân 3x trong captcha_debug)
// Chạy: node_modules\.bin\electron test_captcha_morph.js <file_captcha.png>
// Xuất captcha_morph_v*.png rồi OCR từng biến thể với PSM 7/8 để xem biến thể nào đọc được số
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const CAP = process.argv[2] || path.join(__dirname, 'captcha_try1.png')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
    })
    await win.loadURL('about:blank')
    const b64 = fs.readFileSync(CAP).toString('base64')
    const res = await win.webContents.executeJavaScript(`(function(){
      return new Promise(function(done){
        var img = new Image();
        img.onload = function(){
          try {
            // ảnh vào đã là 3x -> giữ nguyên scale (scale=1)
            var W = img.naturalWidth, H = img.naturalHeight;
            var c = document.createElement('canvas'); c.width = W; c.height = H;
            var ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, W, H);
            var px = ctx.getImageData(0, 0, W, H).data, sum = 0, n = 0;
            for (var i = 0; i < px.length; i += 4) { sum += (px[i] + px[i+1] + px[i+2]) / 3; n++; }
            var avg = sum / n;
            var bin = new Uint8Array(W * H);
            for (var p = 0, i2 = 0; p < bin.length; p++, i2 += 4) bin[p] = (((px[i2] + px[i2+1] + px[i2+2]) / 3) < avg) ? 1 : 0;
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
            function opening(r) { return morph(morph(bin, r, false), r, true); }
            function toB64(arr) {
              var cc = document.createElement('canvas'); cc.width = W; cc.height = H;
              var cx = cc.getContext('2d');
              var out = cx.createImageData(W, H);
              for (var p2 = 0, i3 = 0; p2 < arr.length; p2++, i3 += 4) {
                var g = arr[p2] ? 0 : 255;
                out.data[i3] = out.data[i3+1] = out.data[i3+2] = g; out.data[i3+3] = 255;
              }
              cx.putImageData(out, 0, 0);
              return cc.toDataURL('image/png').split(',')[1];
            }
            done({
              v0: toB64(bin),
              v1: toB64(opening(1)),
              v2: toB64(opening(2)),
              v3: toB64(opening(3)),
              v4: toB64(opening(4))
            });
          } catch (e) { done({ err: String(e && e.name || e) }) }
        };
        img.onerror = function(){ done({ err: 'IMG_DECODE_LOI' }) };
        img.src = 'data:image/png;base64,${b64}';
      });
    })()`, 30000)

    win.destroy()
    if (res.err) { console.error('PAGE ERR:', res.err); app.exit(1); return }
    const keys = ['v0', 'v1', 'v2', 'v3', 'v4']
    for (const k of keys) {
      if (res[k]) fs.writeFileSync(path.join(__dirname, `captcha_morph_${k}.png`), Buffer.from(res[k], 'base64'))
    }
    console.log('VARIANTS OK:', keys.map(k => `${k}=${res[k] ? res[k].length : '-'}`).join(' '))
    app.quit()
  } catch (e) {
    console.error('ERR:', e.message)
    app.exit(1)
  }
})
