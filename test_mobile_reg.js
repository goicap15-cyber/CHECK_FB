// Debug mobile wbloks reg: mở m.facebook.com/reg từng bước, dump DOM mỗi màn
// Chạy: node_modules\electron\dist\electron.exe test_mobile_reg.js --enable-logging
const { app, BrowserWindow, session } = require('electron')
const FBRegisterEngine = require('./fbreg.js')

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const DUMP_JS = `(function(){
  var out = { url: location.href.substring(0, 90), inputs: [], buttons: [] };
  var ins = Array.from(document.querySelectorAll('input, textarea, select'));
  for (var i = 0; i < ins.length; i++) {
    var e = ins[i]; var r = e.getBoundingClientRect();
    out.inputs.push({
      al: e.getAttribute('aria-label') || '', name: e.name || '', type: e.type || '',
      ph: e.getAttribute('placeholder') || '', visible: r.width > 2 && r.height > 2,
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      val: (e.value || '').substring(0, 20)
    });
  }
  var btns = Array.from(document.querySelectorAll('[role="button"], button, a[href]'));
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j]; var rb = b.getBoundingClientRect();
    if (rb.width < 2 || rb.height < 2) continue;
    out.buttons.push({
      al: b.getAttribute('aria-label') || '', txt: ((b.innerText || '') + '').replace(/\\s+/g, ' ').trim().substring(0, 30),
      x: Math.round(rb.left), y: Math.round(rb.top), w: Math.round(rb.width), h: Math.round(rb.height)
    });
  }
  out.bodyText = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').substring(0, 180);
  return JSON.stringify(out);
})()`

app.whenReady().then(async () => {
  const log = (m) => { try { console.log(`[${new Date().toLocaleTimeString('vi-VN')}] ${m}`) } catch {} }
  const dump = async (label) => {
    const d = await wc.executeJavaScript(DUMP_JS).catch(() => 'DUMP_ERR')
    log(`── DUMP ${label}: ${typeof d === 'string' ? d.substring(0, 1400) : d}`)
  }

  const eng = new FBRegisterEngine({})
  const ses = session.fromPartition('testmobile_' + Date.now())
  ses.setUserAgent(UA)
  const win = new BrowserWindow({
    width: 430, height: 830, show: true,
    title: 'TEST MOBILE REG',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false }
  })
  const wc = win.webContents
  win.on('closed', () => app.quit())

  // Fake touch/platform như engine
  try {
    wc.debugger.attach('1.3')
    wc.debugger.sendCommand('Network.setUserAgentOverride', { userAgent: UA, platform: 'iPhone' }).catch(() => {})
    wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {})
  } catch (e) { log('debugger: ' + e.message) }

  log('🌐 Mở m.facebook.com/reg/?locale=en_US ...')
  await win.loadURL('https://m.facebook.com/reg/?locale=en_US').catch(e => log('load: ' + e.message))
  await sleep(7000)
  await dump('SAU LOAD')

  // 1. Bấm Get started bằng click vật lý của engine
  log('👉 Thử _wbloksClick Get started...')
  const gs = await eng._wbloksClick(win, wc, ['Get started', 'Bắt đầu'], log, 15000)
  log('Get started: ' + JSON.stringify(gs))
  await sleep(4000)
  await dump('SAU GET STARTED')

  // 2. Thử điền First name / Last name
  const f1 = await eng._wbloksFillInput(win, wc, ['First name'], 'Minh', log)
  log('Fill First name = ' + f1)
  await sleep(600)
  const f2 = await eng._wbloksFillInput(win, wc, ['Last name'], 'Nguyen', log)
  log('Fill Last name = ' + f2)
  await sleep(800)
  await dump('SAU ĐIỀN TÊN')

  // 3. Bấm Next
  const nx = await eng._wbloksClick(win, wc, ['Next'], log, 12000)
  log('Next: ' + JSON.stringify(nx))
  await sleep(4000)
  await dump('SAU NEXT')

  log('🏁 Xong test — giữ cửa sổ 15s')
  await sleep(15000)
  app.quit()
}).catch(e => { console.error('LỖI:', e); app.quit() })
