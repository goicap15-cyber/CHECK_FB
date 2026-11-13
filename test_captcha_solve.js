// Test pipeline giải captcha FB: raw -> 3x binarize -> opening r lớn -> lọc component nhỏ
// -> crop -> OCR (tesseract trong main process). Chạy trên 3 mẫu raw thật.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const FILES = process.argv.slice(2).length ? process.argv.slice(2) : ['captcha_raw_1.png', 'captcha_raw_2.png', 'captcha_raw_3.png']
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

// pipeline trang: nhị phân 3x -> opening r -> lọc component nhỏ -> crop -> b64
const PAGE_PIPE = `(function(){
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
        var px = ctx.getImageData(0, 0, W, H).data, sum = 0, n = 0;
        for (var i = 0; i < px.length; i += 4) { sum += (px[i] + px[i+1] + px[i+2]) / 3; n++; }
        var avg = sum / n;
        var bin = new Uint8Array(W * H);
        for (var q = 0, i2 = 0; q < bin.length; q++, i2 += 4) bin[q] = (((px[i2] + px[i2+1] + px[i2+2]) / 3) < avg) ? 1 : 0;
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
        // lọc component nhỏ (rác) + crop bbox mực
        function cleanCrop(arr) {
          var comp = new Int32Array(W * H).fill(-1), comps = [];
          for (var s = 0; s < arr.length; s++) {
            if (!arr[s] || comp[s] !== -1) continue;
            var id = comps.length, stack = [s], cnt = 0, minX = W, maxX = 0, minY = H, maxY = 0;
            while (stack.length) {
              var cur = stack.pop();
              if (comp[cur] === id) continue;
              comp[cur] = id; cnt++;
              var cx = cur % W, cy = (cur - cx) / W;
              if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
              if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
              var nb = [cur-1, cur+1, cur-W, cur+W];
              for (var t = 0; t < 4; t++) { var q2 = nb[t]; if (q2 >= 0 && q2 < arr.length && arr[q2] && comp[q2] === -1) stack.push(q2); }
            }
            comps.push({ n: cnt, minX: minX, maxX: maxX, minY: minY, maxY: maxY, id: id });
          }
          var keep = comps.filter(function(cc){ return cc.n >= 400; });
          if (!keep.length) keep = comps.filter(function(cc){ return cc.n >= 100; });
          if (!keep.length) keep = comps;
          var keepIds = {};
          keep.forEach(function(cc){ keepIds[cc.id] = 1; });
          var out = new Uint8Array(W * H);
          for (var z = 0; z < arr.length; z++) if (arr[z] && keepIds[comp[z]]) out[z] = 1;
          var bX0 = W, bX1 = 0, bY0 = H, bY1 = 0;
          keep.forEach(function(cc){ bX0 = Math.min(bX0, cc.minX); bX1 = Math.max(bX1, cc.maxX); bY0 = Math.min(bY0, cc.minY); bY1 = Math.max(bY1, cc.maxY); });
          var pad = 12;
          bX0 = Math.max(0, bX0 - pad); bY0 = Math.max(0, bY0 - pad);
          bX1 = Math.min(W - 1, bX1 + pad); bY1 = Math.min(H - 1, bY1 + pad);
          var cw = bX1 - bX0 + 1, ch = bY1 - bY0 + 1;
          var cc2 = document.createElement('canvas'); cc2.width = cw; cc2.height = ch;
          var cx2 = cc2.getContext('2d');
          var im = cx2.createImageData(cw, ch);
          for (var y3 = 0; y3 < ch; y3++) for (var x3 = 0; x3 < cw; x3++) {
            var g = out[(y3 + bY0) * W + (x3 + bX0)] ? 0 : 255;
            var o = (y3 * cw + x3) * 4;
            im.data[o] = im.data[o+1] = im.data[o+2] = g; im.data[o+3] = 255;
          }
          cx2.putImageData(im, 0, 0);
          return cc2.toDataURL('image/png').split(',')[1];
        }
        done({
          goc: cleanCrop(bin),
          r8: cleanCrop(opening(8)),
          r10: cleanCrop(opening(10)),
          r12: cleanCrop(opening(12)),
          r14: cleanCrop(opening(14))
        });
      } catch (e) { done({ err: String(e && e.name || e) }) }
    };
    img.onerror = function(){ done({ err: 'IMG_LOI' }) };
    img.src = SRC_EXPR;
  });
})()`

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true } })
    await win.loadURL('about:blank')
    const { createWorker } = require('tesseract.js')
    const useBest = process.env.TESS_BEST === '1'
    const w = await createWorker('eng', 1, { langPath: useBest ? './tessdata_best' : './tessdata', gzip: false })

      let fileIdx = 0
    for (const f of FILES) {
      const p = path.join(__dirname, f)
      if (!fs.existsSync(p)) { console.log(f, 'KHÔNG TỒN TẠI'); continue }
      const b64 = fs.readFileSync(p).toString('base64')
      const expr = PAGE_PIPE.replace('SRC_EXPR', `'data:image/png;base64,${b64}'`)
      const res = await win.webContents.executeJavaScript(expr, 60000)
      if (res.err) { console.log(f, 'LỖI', res.err); continue }
      console.log('=== ' + f + ' ===')
      fs.writeFileSync(path.join(__dirname, f.replace('.png', '_solved_r12.png')), Buffer.from(res.r12, 'base64'))
      {
        const n = f.match(/(\d)/) ? f.match(/(\d)/)[1] : String(fileIdx)
        fs.writeFileSync(path.join(__dirname, `view_r8_${n}.png`), Buffer.from(res.r8, 'base64'))
        fs.writeFileSync(path.join(__dirname, `view_r10_${n}.png`), Buffer.from(res.r10, 'base64'))
        fs.writeFileSync(path.join(__dirname, `view_goc_${n}.png`), Buffer.from(res.goc, 'base64'))
      }
      if (process.env.SKIP_OCR === '1') { fileIdx++; continue }
      fileIdx++
      for (const key of ['goc', 'r8', 'r10', 'r12', 'r14']) {
        if (!res[key]) continue
        for (const wl of [false, true]) {
          await w.setParameters(Object.assign(
            { tessedit_pageseg_mode: '7' },
            wl ? { tessedit_char_whitelist: '0123456789' } : {}
          ))
          const { data } = await w.recognize(Buffer.from(res[key], 'base64'))
          const d = String(data.text || '').replace(/\D/g, '')
          console.log(`  ${key} wl=${wl ? 1 : 0} -> "${d}" conf ${Math.round(data.confidence || 0)}`)
        }
      }
    }
    await w.terminate()
    win.destroy()
    app.quit()
  } catch (e) { console.error('ERR:', e.message); app.exit(1) }
})
