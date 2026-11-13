// Test scrape Gmail inbox — chạy ĐÚNG đoạn JS của tool, dump từng dòng
const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')
const path = require('path')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Cookie goicap14 (user đã đưa ở trên — bản 29 cookie)
const jar = JSON.parse(fs.readFileSync('C:/Users/Admin/AppData/Local/Temp/gmail_cookie_goicap14.json', 'utf8'))
const cookieStr = jar.map(([k, v]) => k + '=' + v).join('; ')

// Đoạn scrape Y HỆT fbreg.js (copy nguyên văn)
const SCRAPE_JS = `(function(){
  var firstName = 'Rosalind';
  var out = [];
  var rows = Array.from(document.querySelectorAll('tr.zA'));
  for (var i = 0; i < rows.length; i++) {
    var t = (rows[i].innerText || '').replace(/\\s+/g, ' ');
    if (!/facebook/i.test(t)) continue;
    if (!/is your Facebook (confirmation )?code|enter this code/i.test(t)) continue;
    var timeEl = rows[i].querySelector('.xW span[title]');
    var timeTxt = timeEl ? ((timeEl.textContent || '') + '').trim() : '';
    var isToday = /^\\d{1,2}:\\d{2}(\\s?(AM|PM))?$/i.test(timeTxt);
    var m = t.match(/enter this code:\\s*(\\d{4,8})/i) || t.match(/(\\d{4,8})\\s+is your Facebook/i);
    out.push({ code: m ? m[1] : '', timeTxt: timeTxt, isToday: isToday,
      nameHit: firstName ? t.toLowerCase().indexOf(String(firstName).toLowerCase()) !== -1 : true,
      snippet: t.substring(0, 150) });
  }
  //Dump cả TỔNG số tr.zA và vài dòng đầu không lọc
  var all = [];
  var rowsAll = Array.from(document.querySelectorAll('tr.zA'));
  for (var j = 0; j < Math.min(rowsAll.length, 8); j++) {
    all.push((rowsAll[j].innerText || '').replace(/\\s+/g, ' ').substring(0, 100));
  }
  return JSON.stringify({ total_zA: rowsAll.length, matched: out, first8: all });
})()`

app.whenReady().then(async () => {
  const ses = session.fromPartition('scrapetest_' + Date.now())
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
  const win = new BrowserWindow({ width: 480, height: 860, show: true, title: 'TEST SCRAPE', webPreferences: { session: ses } })
  const wc = win.webContents
  const pairs = cookieStr.split(';').map(s => s.trim()).filter(Boolean)
  let ok = 0
  for (const pair of pairs) {
    const i = pair.indexOf('=')
    try {
      await ses.cookies.set({ url: 'https://mail.google.com/', name: pair.substring(0, i).trim(), value: pair.substring(i + 1).trim(), domain: '.google.com', path: '/', secure: true })
      ok++
    } catch (e) { console.log('cookie fail', pair.substring(0, 20), e.message) }
  }
  console.log(`[test] nạp ${ok}/${pairs.length} cookie`)
  try { await Promise.race([wc.loadURL('https://mail.google.com/mail/u/0/#inbox'), sleep(35000)]) } catch {}
  await sleep(6000)
  console.log('[test] URL:', wc.getURL().substring(0, 80))
  const r = await wc.executeJavaScript(SCRAPE_JS).catch(e => 'ERR ' + e.message)
  const parsed = JSON.parse(r)
  console.log('[test] Tổng tr.zA:', parsed.total_zA)
  console.log('[test] Dòng khớp facebook-code:', parsed.matched.length)
  parsed.matched.forEach(m => console.log('   →', JSON.stringify(m).substring(0, 180)))
  console.log('[test] 8 dòng đầu (không lọc):')
  parsed.first8.forEach((f, i) => console.log('  ', i + ':', f.substring(0, 110)))
  await sleep(8000)
  app.quit()
}).catch(e => { console.error('LỖI:', e.message); app.quit() })
