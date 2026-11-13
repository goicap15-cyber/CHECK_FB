// Test node thuần: ẨN HẲN khỏi taskbar (Win32 SW_HIDE) + incognito cho Chrome thật (chrome_cdp.js)
const fs = require('fs')
const { execSync } = require('child_process')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const { createRealChromeSession, win32WindowVisible } = require('./chrome_cdp')

let fails = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`)
  if (!cond) fails++
}

async function main() {
  const log = m => console.log('  ' + m)
  console.log('== 1. Launch Chrome thật (showBrowser = true) ==')
  const { win, browser, sessionId, targetId, cleanup } = await createRealChromeSession({
    showBrowser: true, slot: 0, proxy: null, proxyAuth: null, lang: 'en-US,en;q=0.9', log,
  })
  const pid = win._chromePid

  console.log('== 2. Kiểm tra incognito qua cmdline của chrome.exe ==')
  let cmd = ''
  try { cmd = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`, { encoding: 'utf8', timeout: 10000 }) } catch {}
  check('chrome.exe chạy với --incognito', /--incognito/i.test(cmd))
  check('chrome.exe chạy với --disable-blink-features=AutomationControlled', /AutomationControlled/i.test(cmd))

  console.log('== 3. CDP hoạt động trong incognito ==')
  const v = await win.webContents.executeJavaScript('1 + 1')
  check('executeJavaScript trả về 2', v === 2)

  console.log('== 4. State ban đầu: hiện trên desktop ==')
  check('isVisible() = true', win.isVisible() === true)
  const vis0 = await win32WindowVisible(pid)
  check(`Win32 IsWindowVisible = 1 (thấy trên taskbar) → ${vis0}`, vis0 === '1')

  console.log('== 5. win.hide() → ẨN HẲN khỏi taskbar ==')
  let t0 = Date.now()
  await win.hide()
  console.log(`  (hide mất ${Date.now() - t0}ms)`)
  check('isVisible() = false sau hide', win.isVisible() === false)
  const vis1 = await win32WindowVisible(pid)
  check(`Win32 IsWindowVisible = 0 (BIẾN MẤT khỏi taskbar) → ${vis1}`, vis1 === '0')

  console.log('== 6. win.show() hiện lại ==')
  t0 = Date.now()
  await win.show()
  console.log(`  (show mất ${Date.now() - t0}ms)`)
  check('isVisible() = true sau show', win.isVisible() === true)
  const vis2 = await win32WindowVisible(pid)
  check(`Win32 IsWindowVisible = 1 (đã hiện lại) → ${vis2}`, vis2 === '1')

  console.log('== 7. Chu kỳ 2: hide -> show -> hide ==')
  await win.hide(); await sleep(300)
  check('lần 2: isVisible() = false', win.isVisible() === false)
  check('lần 2: IsWindowVisible = 0', (await win32WindowVisible(pid)) === '0')
  await win.show(); await sleep(300)
  check('lần 2: isVisible() = true', win.isVisible() === true)
  check('lần 2: IsWindowVisible = 1', (await win32WindowVisible(pid)) === '1')
  await win.hide(); await sleep(300)
  check('lần 3: isVisible() = false', win.isVisible() === false)
  check('lần 3: IsWindowVisible = 0', (await win32WindowVisible(pid)) === '0')

  console.log('== 8. Cleanup: kill Chrome + xóa profile ==')
  const profileDir = win._profileDir
  await cleanup()
  await sleep(500)
  check('profile dir đã bị xóa', !fs.existsSync(profileDir))

  if (browser && typeof browser.close === 'function') { try { browser.close() } catch {} }

  console.log('\n== 9. Phase 2: Launch sẵn ở chế độ ẨN (showBrowser = false) ==')
  const s2 = await createRealChromeSession({
    showBrowser: false, slot: 1, proxy: null, proxyAuth: null, lang: 'en-US,en;q=0.9', log,
  })
  const pid2 = s2.win._chromePid
  await sleep(1000)
  check('launch ẩn: isVisible() = false', s2.win.isVisible() === false)
  const lv0 = await win32WindowVisible(pid2)
  check(`launch ẩn: IsWindowVisible = 0 (không có trên taskbar từ đầu) → ${lv0}`, lv0 === '0')
  await s2.win.show(); await sleep(300)
  check('show sau launch ẩn: IsWindowVisible = 1', (await win32WindowVisible(pid2)) === '1')
  await s2.win.hide(); await sleep(300)
  check('hide lại: IsWindowVisible = 0', (await win32WindowVisible(pid2)) === '0')
  const dir2 = s2.win._profileDir
  await s2.cleanup()
  await sleep(500)
  check('phase 2: profile đã bị xóa', !fs.existsSync(dir2))
  if (s2.browser && typeof s2.browser.close === 'function') { try { s2.browser.close() } catch {} }

  console.log(fails === 0 ? '\n=== TẤT CẢ PASS ===' : `\n=== ${fails} FAIL ===`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => { console.error('TEST CRASH:', e.message); process.exit(2) })
