// Test flow THÊM AVATAR: profile -> "What's on your mind?" -> paste ảnh (clipboard) -> Post
const { app, BrowserWindow, session, screen, clipboard, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const L = (...a) => console.log('[T]', ...a)

const LINE = '[LIVE] 61596071456844|b6fd3950@tempmailapi.io.vn|!E7XXZG7m7Xp|T4WMLJDRTT3A3MZF|datr=47Thag4C-qhvkOg0Bks5PWTi; wd=418x775; dpr=1.25; sb=7bThahTi3Vo64SGwo9jQ9Ttk; c_user=61596071456844; xs=46%3AcZUoEXpAh-yPCQ%3A2%3A1793176841%3A-1%3A-1%3A%3AAcyytVTAEzcwccmSgJvVGoLs7QznfFFREEQxBmPbVw; fr=1VqhHCTAm7Sf9usDg.AWdY_mtyvAvHh89ecbH5fCk8NZ8CNoNQ5lQeJV-tcm1vPpyUews.Bq4bUb..AAA.0.0.Bq4bVS.AWdyKQlZwDDoWHZfrulTRUZmGY0; presence=C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1793176919343%2C%22v%22%3A1%7D'
const parts = LINE.split('|')
const UID = parts[0].replace('[LIVE]', '').trim()

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  try {
    L('test nick:', UID)
    const ses = session.fromPartition('avatar-test')
    const wa = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      x: wa.x + 40, y: wa.y + 40, width: 500, height: 860, show: true,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
    })
    const wc = win.webContents
    ses.setUserAgent(UA)

    const dump = async (label) => {
      const d = await wc.executeJavaScript(`(function(){
        var dlg = document.querySelector('div[role="dialog"]');
        var body = ((dlg ? dlg.innerText : '') || (document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').toLowerCase().substring(0, 200);
        var imgs = dlg ? dlg.querySelectorAll('img').length : -1;
        var postBtn = null;
        var cands = document.querySelectorAll('[aria-label="Post"], [aria-label="Đăng"]');
        for (var i = 0; i < cands.length; i++) { var r = cands[i].getBoundingClientRect(); if (r.width > 30) { postBtn = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: cands[i].getAttribute('aria-disabled') }; break; } }
        return { url: location.href.substring(0, 90), body: body, dialogImgs: imgs, postBtn: postBtn };
      })()`).catch(e => ({ err: e.message }))
      L('---', label, '---')
      L('URL:', d.url, '| dialog imgs:', d.dialogImgs, '| PostBtn:', JSON.stringify(d.postBtn))
      L('body:', JSON.stringify(d.body))
      return d
    }
    const clickPos = async (pos, label) => {
      if (!pos) { L('X', label, 'khong thay'); return false }
      wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      await sleep(70)
      wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      L('OK', label, 'click', '(' + pos.x + ',' + pos.y + ')')
      return true
    }

    // Nạp cookie
    const ckPart = parts.slice(4).join('|')
    for (const pair of ckPart.split(';').map(s => s.trim()).filter(Boolean)) {
      const i = pair.indexOf('=')
      if (i < 1) continue
      await ses.cookies.set({ url: 'https://www.facebook.com', name: pair.slice(0, i), value: pair.slice(i + 1), domain: '.facebook.com', path: '/', secure: true, sameSite: 'no_restriction' }).catch(e => L('cookie err', pair.slice(0, i), e.message))
    }
    L('Đã nạp cookie')

    // Tạo ảnh test 400x400 + đưa vào clipboard
    const pngB64 = await wc.executeJavaScript(`(function(){
      var c = document.createElement('canvas'); c.width = 400; c.height = 400;
      var x = c.getContext('2d');
      x.fillStyle = '#4a90d9'; x.fillRect(0, 0, 400, 400);
      x.fillStyle = '#fff'; x.font = 'bold 56px Arial'; x.fillText('AVATAR TEST', 30, 210);
      return c.toDataURL('image/png').split(',')[1];
    })()`)
    const imgBuf = Buffer.from(pngB64, 'base64')
    fs.writeFileSync(path.join(__dirname, 'test_avatar.png'), imgBuf)
    clipboard.writeImage(nativeImage.createFromBuffer(imgBuf))
    L('Ảnh test 400x400 đã vào clipboard (', imgBuf.length, 'bytes )')

    // Mở profile
    await Promise.race([wc.loadURL(`https://www.facebook.com/profile.php?id=${UID}&locale=vi_VN`, { userAgent: UA }), sleep(45000)]).catch(() => {})
    await sleep(7000)
    await dump('(1) profile đã mở')

    // Bấm "What's on your mind?"
    const clickedComposer = await clickPos(await wc.executeJavaScript(`(function(){
      var cands = Array.from(document.querySelectorAll('div[role="button"], button'));
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        var t = ((cands[i].textContent || '')).trim().toLowerCase();
        if (t.indexOf("what's on your mind") === -1 && t.indexOf('bạn đang nghĩ') === -1) continue;
        var r = cands[i].getBoundingClientRect();
        if (r.width < 40 || r.height < 12) continue;
        var s = r.width * r.height;
        if (!best || s < best.s) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: s };
      }
      return best;
    })()`).catch(() => null), '"What\'s on your mind?"')
    if (!clickedComposer) {
      await dump('(1b) KHÔNG thấy composer — dump để soi')
      win.destroy(); app.quit(); return
    }
    await sleep(5000)
    await dump('(2) dialog soạn bài mở')

    // Click vào ô soạn thảo rồi Ctrl+V dán ảnh
    await clickPos(await wc.executeJavaScript(`(function(){
      var ed = document.querySelector('div[role="dialog"] div[contenteditable="true"][role="textbox"], div[role="dialog"] [data-lexical-editor="true"], div[role="textbox"][contenteditable="true"]');
      if (!ed) return null;
      ed.scrollIntoView({ block: 'center' });
      var r = ed.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(60, r.height / 2)) };
    })()`).catch(() => null), 'ô soạn thảo')
    await sleep(800)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] })
    await sleep(100)
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] })
    L('Đã bấm Ctrl+V (dán ảnh từ clipboard)')
    await sleep(6000)
    const d3 = await dump('(3) sau Ctrl+V')

    // Bấm Post nếu nút ăn (không disabled)
    if (d3.postBtn && d3.postBtn.disabled !== 'true') {
      await clickPos(d3.postBtn, 'Post')
      await sleep(8000)
      await dump('(4) sau Post')
    } else {
      L('⚠ Nút Post không sẵn sàng (chưa dán được ảnh?) — không bấm')
    }
    win.destroy()
    app.quit()
  } catch (e) { console.error('[T] ERR:', e.message); app.exit(1) }
})
