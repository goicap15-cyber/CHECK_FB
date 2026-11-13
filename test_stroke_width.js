// Đo độ dày nét (distance transform) + connected components trên captcha raw
// -> biết chữ dày bao nhiêu px vs nét nhiễu mảnh bao nhiêu px để chọn bán kính opening
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
            var bin = new Uint8Array(W * H);
            for (var q = 0, i = 0; q < bin.length; q++, i += 4) bin[q] = ((px[i] + px[i+1] + px[i+2]) / 3 < 128) ? 1 : 0;
            // distance transform (chamfer 2-pass, 8-neighbors)
            var INF = 9999;
            var D = new Float32Array(W * H);
            for (var k = 0; k < D.length; k++) D[k] = bin[k] ? INF : 0;
            for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
              var idx = y * W + x;
              if (!bin[idx]) continue;
              var m = D[idx];
              if (y > 0) { m = Math.min(m, D[idx - W] + 1); if (x > 0) m = Math.min(m, D[idx - W - 1] + 1.414); if (x < W-1) m = Math.min(m, D[idx - W + 1] + 1.414); }
              if (x > 0) m = Math.min(m, D[idx - 1] + 1);
              D[idx] = m;
            }
            for (var y2 = H - 1; y2 >= 0; y2--) for (var x2 = W - 1; x2 >= 0; x2--) {
              var idx2 = y2 * W + x2;
              if (!bin[idx2]) continue;
              var m2 = D[idx2];
              if (y2 < H-1) { m2 = Math.min(m2, D[idx2 + W] + 1); if (x2 > 0) m2 = Math.min(m2, D[idx2 + W - 1] + 1.414); if (x2 < W-1) m2 = Math.min(m2, D[idx2 + W + 1] + 1.414); }
              if (x2 < W-1) m2 = Math.min(m2, D[idx2 + 1] + 1);
              D[idx2] = m2;
            }
            // histogram khoảng cách (làm tròn 0.5)
            var hist = {};
            for (var k2 = 0; k2 < D.length; k2++) if (bin[k2]) { var v = Math.round(D[k2] * 2) / 2; hist[v] = (hist[v] || 0) + 1; }
            var histTop = Object.entries(hist).sort(function(a,b){ return parseFloat(a[0]) - parseFloat(b[0]); })
              .map(function(e){ return e[0] + ':' + e[1]; });
            // connected components (BFS) + max distance mỗi component
            var comp = new Int32Array(W * H).fill(-1);
            var comps = [];
            for (var s = 0; s < bin.length; s++) {
              if (!bin[s] || comp[s] !== -1) continue;
              var id = comps.length, stack = [s], n = 0, maxD = 0, minX = W, maxX = 0, minY = H, maxY = 0;
              while (stack.length) {
                var cur = stack.pop();
                if (comp[cur] === id) continue;
                comp[cur] = id; n++;
                if (D[cur] > maxD) maxD = D[cur];
                var cx = cur % W, cy = (cur - cx) / W;
                if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
                var nb = [cur-1, cur+1, cur-W, cur+W, cur-W-1, cur-W+1, cur+W-1, cur+W+1];
                for (var t = 0; t < 8; t++) { var q2 = nb[t]; if (q2 >= 0 && q2 < bin.length && bin[q2] && comp[q2] === -1) stack.push(q2); }
              }
              comps.push({ n: n, maxD: Math.round(maxD * 10) / 10, w: maxX - minX + 1, h: maxY - minY + 1, x0: minX, y0: minY });
            }
            comps.sort(function(a,b){ return b.n - a.n; });
            done({ W: W, H: H, hist: histTop.slice(0, 14), nComp: comps.length,
              comps: comps.slice(0, 10).map(function(cc){ return 'sz' + cc.n + '/d' + cc.maxD + '/box' + cc.w + 'x' + cc.h + '@' + cc.x0 + ',' + cc.y0; }) });
          };
          img.onerror = function(){ done({ err: 'IMG_LOI' }) };
          img.src = 'data:image/png;base64,${b64}';
        });
      })()`, 30000)
      if (res.err) { console.log(f, 'LỖI', res.err); continue }
      console.log('=== ' + f + ' (' + res.W + 'x' + res.H + ') — ' + res.nComp + ' components ===')
      console.log('  Hist khoảng cách:', res.hist.join(' | '))
      console.log('  Components:', res.comps.join('\n             '))
    }
    win.destroy()
    app.quit()
  } catch (e) { console.error('ERR:', e.message); app.exit(1) }
})
