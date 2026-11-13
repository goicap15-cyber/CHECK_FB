// Debug mobile wbloks reg #2: test GÕ trực tiếp vào ô input[type=date] birthday
const { app, BrowserWindow, session } = require('electron')
const FBRegisterEngine = require('./fbreg.js')

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const READ_DATE_JS = `(function(){
  var e = document.querySelector('input[type="date"]');
  if (!e) return 'NO_DATE_INPUT';
  return JSON.stringify({ value: e.value, valid: e.validity && e.validity.valid, al: e.getAttribute('aria-label') });
})()`

app.whenReady().then(async () => {
  const log = (m) => { try { console.log(`[${new Date().toLocaleTimeString('vi-VN')}] ${m}`) } catch {} }
  const eng = new FBRegisterEngine({})
  const ses = session.fromPartition('testmobile2_' + Date.now())
  ses.setUserAgent(UA)
  const win = new BrowserWindow({
    width: 430, height: 830, show: true,
    title: 'TEST MOBILE REG #2 (birthday)',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false }
  })
  const wc = win.webContents
  win.on('closed', () => app.quit())

  try {
    wc.debugger.attach('1.3')
    wc.debugger.sendCommand('Network.setUserAgentOverride', { userAgent: UA, platform: 'iPhone' }).catch(() => {})
    wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {})
  } catch {}

  log('🌐 Mở m.facebook.com/reg/?locale=en_US ...')
  await win.loadURL('https://m.facebook.com/reg/?locale=en_US').catch(() => {})
  await sleep(7000)

  // Get started
  const gs = await eng._wbloksClick(win, wc, ['Get started'], log, 15000)
  log('Get started: ' + JSON.stringify(gs))
  await sleep(4000)

  // Tên
  await eng._wbloksFillInput(win, wc, ['First name'], 'Minh', log)
  await sleep(500)
  await eng._wbloksFillInput(win, wc, ['Last name'], 'Nguyen', log)
  await sleep(700)
  const nx = await eng._wbloksClick(win, wc, ['Next'], log, 12000)
  log('Next (tên): ' + JSON.stringify(nx))
  await sleep(4000)

  // ── MÀN BIRTHDAY: test gõ trực tiếp ──
  log('=== MÀN BIRTHDAY: test các cách điền ===')
  const dateInfo0 = await wc.executeJavaScript(READ_DATE_JS).catch(() => 'ERR')
  log('Trước khi điền: ' + dateInfo0)

  // Click vào giữa ô date (tọa độ lấy động)
  const pos = await wc.executeJavaScript(`(function(){
    var e = document.querySelector('input[type="date"]');
    if (!e) return null;
    e.scrollIntoView({block: 'center'});
    var r = e.getBoundingClientRect();
    return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)};
  })()`).catch(() => null)
  if (!pos) { log('Không thấy ô date!'); await sleep(10000); app.quit(); return }
  wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await sleep(70)
  wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await sleep(600)

  // CÁCH 1: insertText cả chuỗi MMDDYYYY (locale en-US: gõ tháng trước)
  const digits = '10222006' // 10/22/2006
  log('CÁCH 1: insertText("' + digits + '") — gõ MM DD YYYY...')
  await wc.insertText(digits).catch(e => log('insertText lỗi: ' + e.message))
  await sleep(800)
  let v = await wc.executeJavaScript(READ_DATE_JS).catch(() => 'ERR')
  log('Sau CÁCH 1: ' + v)
  let ok = false
  try { ok = JSON.parse(v).value === '2006-10-22' } catch {}

  // CÁCH 2: gõ từng ký tự bằng sendInputEvent type 'char' (giống bàn phím thật)
  if (!ok) {
    log('CÁCH 2: gõ từng ký tự sendInputEvent char...')
    // Clear trước: Ctrl+A + Backspace
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await sleep(100)
    for (const ch of digits) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(120)
    }
    await sleep(800)
    v = await wc.executeJavaScript(READ_DATE_JS).catch(() => 'ERR')
    log('Sau CÁCH 2: ' + v)
    try { ok = JSON.parse(v).value === '2006-10-22' } catch {}
  }

  // CÁCH 3: keyDown/keyUp từng số (keyCode số)
  if (!ok) {
    log('CÁCH 3: keyDown/keyUp keyCode số...')
    for (const ch of digits) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
      await sleep(120)
    }
    await sleep(800)
    v = await wc.executeJavaScript(READ_DATE_JS).catch(() => 'ERR')
    log('Sau CÁCH 3: ' + v)
    try { ok = JSON.parse(v).value === '2006-10-22' } catch {}
  }

  // CÁCH 4: native setter (cách cũ trong engine) — đối chứng
  if (!ok) {
    log('CÁCH 4: native setter + events (cách cũ)...')
    await wc.executeJavaScript(`(function(){
      var e = document.querySelector('input[type="date"]');
      if (!e) return;
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(e, '2006-10-22');
      e.dispatchEvent(new Event('input', {bubbles: true}));
      e.dispatchEvent(new Event('change', {bubbles: true}));
    })()`).catch(() => null)
    await sleep(800)
    v = await wc.executeJavaScript(READ_DATE_JS).catch(() => 'ERR')
    log('Sau CÁCH 4: ' + v)
  }

  // Xem nút Next có sáng không + bấm thử
  const nx2 = await eng._wbloksClick(win, wc, ['Next'], log, 8000)
  log('Next (birthday): ' + JSON.stringify(nx2))
  await sleep(4000)
  const after = await wc.executeJavaScript(`(function(){
    var ins = Array.from(document.querySelectorAll('input[aria-label], select[aria-label]'));
    var labels = [];
    for (var i = 0; i < ins.length; i++) {
      var e = ins[i]; var r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      labels.push(e.tagName + ':' + (e.getAttribute('aria-label') || e.name || ''));
    }
    var btns = Array.from(document.querySelectorAll('[role="button"]')).map(function(b){
      var r = b.getBoundingClientRect();
      return r.width > 2 ? (b.getAttribute('aria-label') || (b.innerText || '').substring(0, 20)) : null;
    }).filter(Boolean);
    return JSON.stringify({ labels: labels.slice(0, 8), buttons: btns.slice(0, 8) });
  })()`).catch(() => 'ERR')
  log('MÀN SAU BIRTHDAY: ' + after)

  log('🏁 Xong — giữ cửa sổ 15s')
  await sleep(15000)
  app.quit()
}).catch(e => { console.error('LỖI:', e); app.quit() })
