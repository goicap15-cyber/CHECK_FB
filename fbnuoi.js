// Engine NUÔI FB: nạp cookie (dạng uid|pass|2fa|cookie hoặc cookie trần) -> mở Chrome (tùy chọn proxy)
// -> Cookie sống: nuôi nick (lướt feed + like + kết bạn + tham gia nhóm) theo thời gian cấu hình
// -> Cookie chết: đăng nhập lại bằng uid|pass; cần 2FA thì sinh mã TOTP từ secret; không có secret -> báo lỗi + đóng Chrome
// Phần nuôi + login + 2FA port từ AUTO_BM (main.py + facebook_extension/content.js) sang Electron
const { BrowserWindow, session, screen } = require('electron')

const { autoLoginFB } = require('./fblogin.js')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }

// ── TOTP 6 số từ secret Base32 (giống AUTO_BM, thuần crypto không phụ thuộc thư viện) ──
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = String(str || '').replace(/[\s=-]/g, '').toUpperCase()
  let bits = ''
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch)
    if (idx === -1) throw new Error('Secret 2FA không phải Base32 hợp lệ')
    bits += idx.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

function totpFromSecret(secret) {
  const crypto = require('crypto')
  const key = base32Decode(secret)
  const counter = Math.floor(Date.now() / 30000)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter % 2 ** 32, 4)
  const hs = crypto.createHmac('sha1', key).update(buf).digest()
  const offset = hs[hs.length - 1] & 0x0f
  const code = ((hs[offset] & 0x7f) << 24) | (hs[offset + 1] << 16) | (hs[offset + 2] << 8) | hs[offset + 3]
  return String(code % 1000000).padStart(6, '0')
}

// ── Parse 1 dòng account: uid|pass|cookie | uid|pass|2fa|cookie | cookie trần ──
// Cookie chứa ";" nhưng không chứa "|" nên tách theo "|" an toàn
function is2faSegment(s) { return /^[A-Za-z2-7]{16,64}$/.test(s) && /[A-Z]/i.test(s) }
function isCookieSegment(s) {
  if (!s) return false
  const t = s.toLowerCase()
  return t.includes('c_user=') || t.includes('xs=') || t.includes('datr=') ||
    (s.includes(';') && s.includes('='))
}

function parseAccountLine(raw) {
  // Strip prefix [LIVE] / [CHECKPOINT] / [DIE] / [ERROR] / [xxx] đầu dòng
  // (main.js xuất kết quả nuôi có prefix này — nếu không strip thì parse bị lệch toàn bộ)
  const line = String(raw || '').trim().replace(/^\s*\[[^\]]*\]\s*/, '')
  if (!line) return null
  // Netscape nhiều dòng (dán cả khối, có thể bắt đầu bằng # comment): kiểm tra TRƯỚC nhánh bỏ comment
  if (line.includes('\n') && line.includes('\t')) {
    let uid = ''
    const m = line.match(/c_user\s+(\d{6,})/)
    if (m) uid = m[1]
    return { uid, pass: '', twofa: '', cookie: line, line: line.split('\n')[0].slice(0, 80) + '…' }
  }
  if (line.startsWith('#')) return null
  if (!line.includes('|')) {
    // 1 cột: cookie trần (hoặc chỉ cookie). UID tự suy từ c_user trong cookie
    const um = line.match(/c_user=(\d{6,})/)
    return { uid: um ? um[1] : '', pass: '', twofa: '', cookie: line, line: line.slice(0, 80) }
  }
  const parts = line.split('|').map(p => p.trim()).filter(p => p !== '')
  if (!parts.length) return null
  let uid = '', email = '', pass = '', twofa = '', cookie = ''
  const rest = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (i === 0 && /^\d{6,}$/.test(p)) { uid = p; continue }
    if (i === 0 && p.includes('@')) { email = p; continue }
    // Email ở bất kỳ vị trí (format uid|email|pass|2fa|cookie):
    // check TRƯỚC pass để tránh email bị nhầm vào field pass
    if (!email && p.includes('@') && !isCookieSegment(p) && !is2faSegment(p)) { email = p; continue }
    if (!pass && !isCookieSegment(p) && !is2faSegment(p) && !/^\d{6,}$/.test(p) && !p.includes('@') && !cookie) {
      // vẫn có thể là pass trùng định dạng 2fa -> chỉ nhận nếu chưa có cột nào khác
      if (i === 1 || i === 2 || i === 3) { pass = p; continue }
    }
    if (!twofa && is2faSegment(p) && !isCookieSegment(p)) { twofa = p; continue }
    if (isCookieSegment(p)) { cookie = p; continue }
    rest.push(p)
  }
  if (!cookie && rest.length) cookie = rest.pop()
  const um = cookie.match(/c_user=(\d{6,})/)
  if (!uid && um) uid = um[1]
  // Không cần cookie cũng được: còn uid|pass thì đăng nhập thuần
  if (!cookie && !uid && !email) return null
  return { uid, email, pass, twofa, cookie, line: line.slice(0, 80) }
}

// 24-10: CHỈ desktop UA — UA mobile làm www.facebook.com redirect sang m.facebook.com,
// DOM khác hẳn nên selector like/kết bạn/nhóm không bao giờ khớp (bug nuôi không hành động)
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
]

// Từ khóa FB báo "bị hạn chế hành động" (subset từ AUTO_BM content.js)
const RATE_KEYWORDS = [
  'bị hạn chế', 'tạm thời bị chặn', 'bị chặn tạm thời', 'temporarily blocked',
  "you're blocked", 'you are blocked', 'temporarily restricted', 'tạm thời hạn chế',
  'giới hạn gửi lời mời', 'lượt gửi lời mời', 'too many friend requests',
  'hạn chế kết bạn', 'không thể gửi lời mời', "can't send friend request",
  'không thể tham gia', 'bị hạn chế tham gia', "can't join", 'too many group',
  'action blocked', 'hành động bị chặn', 'please try again later', 'hãy thử lại sau',
  "you've been temporarily", 'bạn đã bị hạn chế tạm thời', 'something went wrong', 'có lỗi xảy ra'
]

class FBNuoiEngine {
  constructor({ showBrowser, slot, proxy, minutes, onLog }) {
    this.showBrowser = showBrowser !== false
    this.slot = slot || 0
    this.proxy = proxy || ''
    this.minutes = minutes > 0 ? minutes : 15
    this.onLog = onLog || (() => {})
    this.win = null
    this.isAborted = false
  }

  log(msg) { this.onLog(msg) }

  // executeJavaScript có timeout: trang FB redirect-loop thì call này treo vĩnh viễn
  async js(wc, expr, to = 10000) {
    return Promise.race([
      wc.executeJavaScript(expr),
      sleep(to).then(() => { throw new Error('JS_TIMEOUT') })
    ]).catch(() => null)
  }

  abort() {
    this.isAborted = true
    if (this.win && !this.win.isDestroyed()) { try { this.win.destroy() } catch {} }
    this.win = null
  }

  parseFBCookies(raw) {
    const out = []
    if (!raw) return out
    if (raw.indexOf('\n') !== -1 && raw.indexOf('\t') !== -1) {
      for (let line of raw.split(/\r?\n/)) {
        line = line.trim()
        if (!line) continue
        if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
        if (line.startsWith('#')) continue
        const f = line.split('\t')
        if (f.length >= 7) {
          out.push({ domain: f[0], path: f[2] || '/', secure: f[3] === 'TRUE', name: f[5], value: f.slice(6).join('\t') })
        }
      }
      if (out.length) return out
    }
    return raw.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
      const idx = pair.indexOf('=')
      return { domain: '.facebook.com', path: '/', secure: true, name: idx > -1 ? pair.substring(0, idx).trim() : pair.trim(), value: idx > -1 ? pair.substring(idx + 1).trim() : '' }
    }).filter(c => c.name && c.value)
  }

  async injectCookies(ses, pairs) {
    let ok = 0
    for (const c of pairs) {
      let domain = (c.domain || '.facebook.com').trim()
      if (!domain.startsWith('.')) domain = '.' + domain
      try {
        await ses.cookies.set({
          url: 'https://' + domain.replace(/^\./, '') + '/',
          name: c.name, value: c.value,
          domain, path: c.path || '/',
          secure: c.secure !== false,
          httpOnly: false,
          expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
        })
        ok++
      } catch (e) { this.log(`⚠ Cookie ${c.name}: ${e.message}`) }
    }
    return ok
  }

  // Lấy lại cookie mới nhất từ jar (chuỗi header a=b; c=d) để xuất kết quả
  async extractCookieString(ses) {
    try {
      const list = await ses.cookies.get({})
      const fb = list.filter(c => (c.domain || '').includes('facebook.com'))
      const prio = ['c_user', 'xs', 'datr', 'fr', 'sb']
      fb.sort((a, b) => {
        const ia = prio.indexOf(a.name), ib = prio.indexOf(b.name)
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      })
      return fb.map(c => `${c.name}=${c.value}`).join('; ')
    } catch { return '' }
  }

  async loadPage(wc, url, timeoutMs = 60000) {
    const started = Date.now()
    let forcedWww = false
    try {
      await Promise.race([wc.loadURL(url), sleep(timeoutMs)])
    } catch {}
    // Đợi render ổn định (title/URL sẵn, DOM có nội dung)
    while (Date.now() - started < timeoutMs) {
      if (this.isAborted) return false
      await sleep(1500)
      try {
        const ready = await this.js(wc, '(function(){return {u: location.href, len: (document.body && document.body.innerText || "").length}})()').catch(() => null)
        if (ready && ready.u && !ready.u.startsWith('chrome-error:') && ready.len > 40) {
          // 24-10: FB đẩy sang m./mbasic./d.facebook.com (session cũ/redirect) — DOM mobile
          // không có nút like/kết bạn/nhóm kiểu desktop -> ép về www một lần rồi chờ lại
          if (!forcedWww && /^https:\/\/(m|mbasic|d)\.facebook\.com/.test(ready.u)) {
            forcedWww = true
            this.log('📱 Bị đẩy sang ' + ready.u.split('/')[2] + ' - ép về www.facebook.com')
            try { await Promise.race([wc.loadURL(ready.u.replace(/^https:\/\/(m|mbasic|d)\./, 'https://www.')), sleep(30000)]) } catch {}
            continue
          }
          return true
        }
      } catch {}
    }
    return false
  }

  // Dò trạng thái trang hiện tại
  async detectState(wc) {
    return await this.js(wc, `
      (function() {
        var path = location.pathname || '';
        var href = location.href || '';
        var hrefLower = href.toLowerCase();
        var body = document.body;
        var t = ((body && body.innerText) || '').toLowerCase();
        var state = 'UNKNOWN';
        if (path.indexOf('/checkpoint') === 0 || path.indexOf('/confirmidentity') === 0) state = 'CHECKPOINT';
        else if (hrefLower.indexOf('/checkpoint') !== -1 || hrefLower.indexOf('/confirmidentity') !== -1) state = 'CHECKPOINT';
        else if (path.indexOf('/disabled') === 0 || path.indexOf('/suspended') === 0 || href.indexOf('260749603972907') !== -1) state = 'DIE';
        else {
          // Màn "Log in to your Meta Account" (FB fast-login profile cũ) —
          // ô pass ở đây KHÔNG có type=password (FB dùng type=text/tel), detectState cũ bỏ sót
          if (t.indexOf('log in to your meta account') !== -1 || t.indexOf('đăng nhập vào tài khoản meta') !== -1) {
            state = 'META_SCREEN';
          } else {
            var two = document.getElementById('approvals_code') || document.querySelector('input[name="approvals_code"]') || document.querySelector('input[autocomplete="one-time-code"]');
            if (two && two.offsetWidth > 0) state = 'NEED_2FA';
            else {
              var useAnother = document.querySelector('a[href*="/login/device-based/regular/login/"]') ||
                Array.from(document.querySelectorAll('span, a, div[role="button"], button')).find(function(el) {
                  var tx = el.textContent || '';
                  return tx.indexOf('Use another profile') !== -1 || tx.indexOf('tài khoản khác') !== -1 || tx.indexOf('dụng tài khoản khác') !== -1;
                });
              if (useAnother && useAnother.offsetWidth > 0) state = 'CHOOSER';
              else {
                var email = document.getElementById('email') || document.querySelector('input[name="email"]');
                var pass = document.getElementById('pass') || document.querySelector('input[name="pass"]');
                if (email && pass && email.offsetWidth > 0 && pass.offsetWidth > 0) state = 'LOGIN_FORM';
                else {
                  var fastPass = document.querySelector('input[type="password"]');
                  if (fastPass && fastPass.offsetWidth > 0) state = 'FAST_PASS';
                  else {
                    var feed = document.querySelector('div[role="feed"]') ||
                      document.querySelector('a[aria-label="Home"], a[aria-label="Trang chủ"], div[aria-label="Account"], div[aria-label="Tài khoản"]');
                    if (feed) state = 'FEED';
                    else if (t.indexOf('vui lòng đăng nhập') !== -1 || t.indexOf('log in to facebook') !== -1 || t.indexOf('đăng nhập facebook') !== -1) state = 'LOGIN_FORM';
                    // Bắt thêm: URL chứa /login nhưng body chưa render đủ
                    else if (hrefLower.indexOf('/login') !== -1 && t.length > 50) state = 'LOGIN_FORM';
                    else if (t.length > 200) state = 'PAGE';
                  }
                }
              }
            }
          }
        }
        return { state: state, url: href };
      })()
    `).catch(() => null)
  }

  // Click phần tử qua React Fiber + sự kiện DOM (như AUTO_BM) - hành động trong 1 lần executeJavaScript
  async runAction(wc, kind) {
    return await this.js(wc, `
      (function() {
        var kw = ${JSON.stringify(RATE_KEYWORDS)};
        var rate = false;
        try {
          var scopes = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="status"], [data-testid="error_message"]');
          for (var s = 0; s < scopes.length; s++) {
            var dtx = ((scopes[s].innerText || '') + '').toLowerCase();
            for (var k = 0; k < kw.length; k++) { if (dtx.indexOf(kw[k]) !== -1) { rate = true; break; } }
            if (rate) break;
          }
        } catch (e) {}
        var path = location.pathname || '';
        function reactClick(el) {
          try {
            var fk = Object.keys(el).find(function(k){ return k.indexOf('__reactFiber') === 0 || k.indexOf('__reactInternalInstance') === 0; });
            if (fk) {
              var f = el[fk];
              while (f) {
                if (f.memoizedProps && f.memoizedProps.onClick) {
                  f.memoizedProps.onClick({ type:'click', bubbles:true, stopPropagation:function(){}, preventDefault:function(){}, nativeEvent:{}, target:el });
                  break;
                }
                f = f.return;
              }
            }
          } catch (e) {}
          var o = { bubbles:true, cancelable:true };
          try {
            el.dispatchEvent(new MouseEvent('mousedown', o));
            el.dispatchEvent(new MouseEvent('mouseup', o));
            el.dispatchEvent(new MouseEvent('click', o));
          } catch (e) {}
          try { el.click(); } catch (e) {}
        }
        function collect(matchFn, excludeFn) {
          var out = [];
          document.querySelectorAll('[role="button"], button, a[role="button"]').forEach(function(b) {
            if (b.offsetWidth <= 0) return;
            // 27-10: bỏ qua mọi thứ nằm trong dialog/popup (popup reactions mở oan khiến nuôi đứng)
            try { if (b.closest('div[role="dialog"]')) return; } catch (e) {}
            var r = b.getBoundingClientRect();
            if (r.top < -80 || r.top > window.innerHeight + 300) return;
            var label = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
            if (matchFn(label.toLowerCase()) && !excludeFn(label.toLowerCase())) out.push(b);
          });
          return out;
        }
        var clicked = null, target = '';
        var kind = ${JSON.stringify(kind)};
        if (kind === 'feed' && path.indexOf('/friends') === -1 && path.indexOf('/groups') === -1) {
          // 27-10: nếu popup (dialog) còn mở từ vòng trước -> đóng ngay rồi mới hành động
          try {
            var dlg0 = document.querySelector('div[role="dialog"]');
            if (dlg0) {
              var x0 = dlg0.querySelector('[aria-label="Close"], [aria-label="Đóng"], [aria-label="Đóng cửa sổ"]');
              if (x0) x0.click();
            }
          } catch (e0) {}
          window.scrollBy({ top: 250 + Math.floor(Math.random() * 350), behavior: 'smooth' });
          // 24-10: match theo TIỀN TỐ thay vì === — label là ghép aria-label + innerText
          // ("thích thích"/"like like"/"thích bài viết của X") nên === 'like' không bao giờ khớp
          // 27-10: loại candidate chứa CHỮ SỐ (counter "Thích 9.4K" bấm vào mở popup reactions)
          var likes = collect(function(l){ return (l.indexOf('thích') === 0 || l.indexOf('like') === 0); },
                              function(l){ return l.indexOf('bỏ thích') !== -1 || l.indexOf('unlike') !== -1 || l.indexOf('đã thích') !== -1 || l.indexOf('reacted') !== -1 || l.indexOf('đã bày tỏ') !== -1 || l.indexOf('thích trang') !== -1 || l.indexOf('like page') !== -1
                                || l.indexOf('reacted to this') !== -1 || l.indexOf('see who reacted') !== -1 || l.indexOf('người đã bày tỏ') !== -1 || l.indexOf('bày tỏ cảm xúc') !== -1
                                || /\\d/.test(l); });
          if (likes.length && Math.random() < 0.7) {
            var b = likes[Math.floor(Math.random() * likes.length)];
            reactClick(b); clicked = 'like';
          }
        } else if (kind === 'friends' || path.indexOf('/friends') !== -1) {
          window.scrollBy({ top: 300 + Math.floor(Math.random() * 300), behavior: 'smooth' });
          // 24-10: exclusion 'bạn bè' cũ là substring -> loại oan nút "Thêm bạn bè" (UI VI),
          // friend phase không bao giờ click. Đổi sang so KHỚP CHÍNH XÁC nhãn nav.
          // Dedupe theo tên: aria-label không đổi ngay sau click -> không dedupe thì bấm
          // lặp cùng người (add->cancel->add như bot)
          if (!window.__nuoiDone) window.__nuoiDone = {};
          function nameOf(b) {
            var al = ((b.getAttribute('aria-label') || '') + '').toLowerCase();
            var m = al.match(/(?:kết bạn với|thêm bạn bè|add friend)\s+(.+)/i);
            return m ? m[1].replace(/\s+/g, ' ').trim() : '';
          }
          var fr = collect(function(l){ return l.indexOf('add friend') !== -1 || l.indexOf('kết bạn') !== -1 || l.indexOf('thêm bạn') !== -1; },
                            function(l){ return l.indexOf('hủy') !== -1 || l.indexOf('cancel') !== -1 || l.indexOf('sent') !== -1 || l.indexOf('requested') !== -1 || l.indexOf('đã gửi') !== -1 || l === 'bạn bè' || l === 'friends' || l.indexOf('nhắn tin') !== -1; })
                      .filter(function(b){ var n = nameOf(b); return !n || !window.__nuoiDone['fr_' + n]; });
          window.__nuoiFrCount = fr.length;
          if (fr.length) {
            var b2 = fr[Math.floor(Math.random() * fr.length)];
            var nm2 = nameOf(b2);
            if (nm2) window.__nuoiDone['fr_' + nm2] = 1;
            b2.scrollIntoView({ block: 'center', behavior: 'instant' });
            reactClick(b2); clicked = 'friend';
            target = nm2 || (b2.getAttribute('aria-label') || '');
          }
        } else if (kind === 'groups' || path.indexOf('/groups') !== -1) {
          window.scrollBy({ top: 300 + Math.floor(Math.random() * 300), behavior: 'smooth' });
          if (!window.__nuoiDone) window.__nuoiDone = {};
          var gr = [];
          document.querySelectorAll('[role="button"][aria-label]').forEach(function(b) {
            if (b.offsetWidth <= 0) return;
            var l = b.getAttribute('aria-label') || '';
            var r = b.getBoundingClientRect();
            if (r.top < -80 || r.top > window.innerHeight + 300) return;
            if ((l.indexOf('Tham gia nhóm') === 0 || l.indexOf('Join group') === 0 || l.indexOf('Join Group') === 0)
              && l.indexOf('đã tham gia') === -1 && l.indexOf('joined') === -1 && l.indexOf('đã gửi') === -1 && l.indexOf('pending') === -1) {
              var gn = l.replace(/^(Tham gia nhóm|Join [Gg]roup)\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
              if (!gn || !window.__nuoiDone['gr_' + gn]) gr.push(b);
            }
          });
          if (gr.length) {
            var b3 = gr[Math.floor(Math.random() * gr.length)];
            var g3 = (b3.getAttribute('aria-label') || '').replace(/^(Tham gia nhóm|Join [Gg]roup)\s*/i, '').replace(/\s+/g, ' ').trim();
            if (g3) window.__nuoiDone['gr_' + g3.toLowerCase()] = 1;
            b3.scrollIntoView({ block: 'center', behavior: 'instant' });
            reactClick(b3); clicked = 'group';
            target = g3;
          }
        }
        var t2 = ((document.body && document.body.innerText) || '').toLowerCase();
        var hrefL2 = (location.href || '').toLowerCase();
        // loginForm: bắt thêm màn Meta và URL /login
        var isLoginForm = (!!document.querySelector('input[name="email"]') && !!document.querySelector('input[name="pass"]'))
          || t2.indexOf('log in to your meta account') !== -1
          || t2.indexOf('đăng nhập vào tài khoản meta') !== -1
          || (hrefL2.indexOf('/login') !== -1 && t2.length > 50);
        return { clicked: clicked, target: target, rate: rate, path: path,
                 frCount: (typeof window.__nuoiFrCount === 'number' ? window.__nuoiFrCount : 0),
                 loginForm: isLoginForm,
                 checkpoint: path.indexOf('/checkpoint') === 0 || path.indexOf('/confirmidentity') === 0 || hrefL2.indexOf('/checkpoint') !== -1,
                 disabled: path.indexOf('/disabled') === 0 || path.indexOf('/suspended') === 0,
                 gone: t2.indexOf('trang kh\u00f4ng t\u1ed3n t\u1ea1i') !== -1 || t2.indexOf('page isn\u2019t available') !== -1 };
      })()
    `).catch(() => null)
  }

  // Điền 1 ô input theo selector (click tâm + insertText native) rồi verify giá trị
  async fillBySelector(wc, selectorJs, text) {
    const ok = await this.js(wc, `
      (function() {
        var el = ${selectorJs};
        if (!el || el.offsetWidth <= 0) return false;
        el.scrollIntoView({ block: 'center' });
        var r = el.getBoundingClientRect();
        window.__nuoiFill = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        return true;
      })()
    `)
    if (!ok) { this.log('   ⚠ fill: không tìm thấy ô input trong DOM'); return false }
    const pos = await this.js(wc, 'window.__nuoiFill')
    if (!pos) { this.log('   ⚠ fill: mất vị trí ô input (trang vừa chuyển?)'); return false }
    const wc2 = this.win ? this.win.webContents : wc
    wc2.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(70)
    wc2.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(150)
    // 24-10: XÓA ô trước khi gõ — insertText nối thêm vào ô còn text cũ làm giá trị nhân đôi
    // ("passpass") → verify fail → login loop 6 lần đều FAIL
    wc2.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    wc2.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await sleep(40)
    wc2.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    wc2.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await sleep(40)
    try { await wc2.insertText(String(text)) } catch (e) {
      this.log('   ⚠ fill: insertText lỗi ' + e.message)
      return false
    }
    await sleep(300)
    const verified = await this.js(wc, `
      (function() {
        var el = ${selectorJs};
        return !!el && el.value === ${JSON.stringify(String(text))};
      })()
    `)
    if (!verified) {
      const cur = await this.js(wc, `(function(){ var el = ${selectorJs}; return el ? el.value.slice(0, 20) : '(no el)'; })()`)
      this.log(`   ⚠ fill: giá trị chưa vào ô (đang là "${cur}")`)
      return false
    }
    return true
  }

  // Vòng đăng nhập lại theo màn hình (port từ AUTO_BM): tối đa 6 vòng dò - điền - submit
  // 27-10: flow login lại DÙNG CHUNG fblogin.js (đã test: gõ vật lý + đối chiếu UID
  // màn "Log in as" + Use another/X màn Meta + poll 2FA 45s + Trust this device)
  async doLogin(wc, acc) {
    if (!this.win || this.win.isDestroyed()) return 'STUCK'
    try { this.win.show(); this.win.focus() } catch {}
    const r = await autoLoginFB({
      win: this.win, wc,
      log: (m) => this.log('   ' + m),
      uid: acc.uid || '',
      email: acc.email || acc.uid || '',
      password: acc.pass || '',
      twofa: acc.twofa || '',
      isAborted: () => this.isAborted
    })
    if (r.status === 'LOGGED_IN') return 'LOGGED_IN'
    if (r.status === 'CHECKPOINT') return 'CHECKPOINT'
    if (r.status === 'NEED_2FA_NO_SECRET') return 'NEED_2FA_NO_SECRET'
    if (r.status === 'WRONG_PASSWORD') { this.log('   ⚠ ' + (r.note || 'FB từ chối mật khẩu')); return 'WRONG_PASSWORD' }
    return 'STUCK'
  }

  async run(account) {
    const acc = {
      uid: account.uid || '', email: account.email || '', pass: account.pass || '',
      twofa: account.twofa || '', cookie: account.cookie || ''
    }
    const label = acc.uid || acc.email || '(cookie trần)'
    this.log(`🌱 Bắt đầu nuôi ${label} trong ~${this.minutes} phút`)

    // 1. Session + proxy
    const partitionName = `persist:fbnuoi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const ses = session.fromPartition(partitionName)
    if (this.proxy && this.proxy.trim()) {
      try {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: this.proxy.trim() })
        this.log(`🌐 Proxy áp dụng: ${this.proxy.trim()}`)
      } catch (pe) { this.log(`⚠ Proxy lỗi: ${pe.message}`) }
    }
    const pickedUA = UA_LIST[Math.floor(Math.random() * UA_LIST.length)]
    ses.setUserAgent(pickedUA)

    // 2. Cửa sổ — 27-10 (yêu cầu user): THU BÉ NHƯ ĐIỆN THOẠI (430x830) xếp lưới như reg.
    //    Chỉ dùng khi Hiện cửa sổ; chế độ ẩn vẫn off-screen như cũ.
    const winPos = {}
    let winW = 430, winH = 830
    if (this.showBrowser) {
      try {
        const wa = screen.getPrimaryDisplay().workArea
        winW = Math.min(430, wa.width)
        winH = Math.min(830, wa.height)
        const cols = Math.max(1, Math.floor(wa.width / (winW + 10)))
        const rows = Math.max(1, Math.floor(wa.height / (winH + 10)))
        const cells = cols * rows
        const s = this.slot % cells
        winPos.x = wa.x + (s % cols) * (winW + 10)
        winPos.y = wa.y + Math.floor(s / cols) * (winH + 10)
        if (this.slot >= cells) {
          winPos.x += (this.slot - cells + 1) * 28
          winPos.y += (this.slot - cells + 1) * 28
        }
      } catch {}
    }
    const win = new BrowserWindow({
      width: winW, height: winH, show: Boolean(this.showBrowser), ...winPos,
      title: `Nuôi FB - ${label}`,
      // backgroundThrottling:false — cửa sổ ẨN bị Chromium bóp timer, scroll/hành động chết đứng
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false, backgroundThrottling: false }
    })
    this.win = win
    const wc = win.webContents
    win.on('closed', () => { this.win = null })
    const cleanup = async () => {
      this.log('🧹 Dọn dẹp phiên...')
      try { if (!win.isDestroyed()) win.destroy() } catch {}
      this.log('🧹 Đã destroy window')
      this.win = null
      // clearStorageData có thể treo khi session còn request dở - race với timeout
      try { await Promise.race([ses.clearStorageData(), sleep(5000)]) } catch {}
    }

    // 3. Nạp cookie
    const pairs = this.parseFBCookies(acc.cookie)
    if (pairs.length) {
      const ok = await this.injectCookies(ses, pairs)
      this.log(`🍪 Đã nạp ${ok}/${pairs.length} cookie vào trình duyệt`)
    } else {
      this.log('⚠ Không đọc được cookie nào từ dòng này - sẽ thử đăng nhập trực tiếp')
    }

    // 4. Mở facebook.com và phân loại
    this.log('⏳ Mở facebook.com để kiểm tra phiên đăng nhập...')
    const loaded = await this.loadPage(wc, 'https://www.facebook.com/', 60000)
    if (this.isAborted) { await cleanup(); return { success: false, status: 'ERROR', uid: acc.uid, error: 'Đã hủy' } }
    if (!loaded) {
      await cleanup()
      return { success: false, status: 'ERROR', uid: acc.uid, error: 'Không tải được Facebook (proxy chết/chậm?)', proxyFail: true }
    }

    let st = await this.detectState(wc)
    this.log(`🔍 Trạng thái trang: ${st ? st.state : 'không đọc được DOM'}`)

    // CHOOSER (màn chọn profile): cookie còn sống - bấm nút fast-login (aria "Continue <Tên>")
    // trước, không có thì mới coi là cần đăng nhập lại
    if (st && st.state === 'CHOOSER') {
      const fast = await this.js(wc, `
        (function() {
          var btns = Array.from(document.querySelectorAll('div[role="button"], button'));
          var target = null;
          for (var i = 0; i < btns.length; i++) {
            var al = (btns[i].getAttribute('aria-label') || '').trim();
            var tx = (btns[i].textContent || '').trim();
            if (/^continue\\s+\\S/i.test(al) || /^(continue as|tiếp tục với)\\s+\\S/i.test(tx) || /^tiếp tục\\s+\\S/i.test(al)) {
              if (al.indexOf('Use another') === -1) { target = btns[i]; break; }
            }
          }
          if (!target) {
            for (var i = 0; i < btns.length; i++) {
              var al = (btns[i].getAttribute('aria-label') || '').trim();
              var tx = (btns[i].textContent || '').trim();
              if (al === 'Continue' || tx === 'Continue') { target = btns[i]; break; }
            }
          }
          if (target) { target.click(); return 'CLICKED_FAST'; }
          return 'NO_FAST';
        })()
      `)
      if (fast === 'CLICKED_FAST') {
        this.log('👉 Bấm fast-login "Continue <tên>" - phiên cookie còn sống')
        await sleep(6000)
        st = await this.detectState(wc)
        this.log(`🔍 Trạng thái sau fast-login: ${st ? st.state : '?'}`)
      }
    }

    // 5. Cookie chết -> đăng nhập lại
    // META_SCREEN: màn "Log in to your Meta Account" — fblogin.js xử lý được
    // LOGIN_FORM / CHOOSER / FAST_PASS: các dạng màn login FB chuẩn
    const needLogin = st && (
      st.state === 'LOGIN_FORM' || st.state === 'CHOOSER' ||
      st.state === 'FAST_PASS' || st.state === 'META_SCREEN'
    )
    if (needLogin) {
      if (!(acc.uid || acc.email) || !acc.pass) {
        await cleanup()
        return {
          success: false, status: 'ERROR', uid: acc.uid,
          error: 'Cookie DIE và không có tài khoản/mật khẩu để đăng nhập lại (dòng cần dạng uid|pass|cookie)'
        }
      }
      this.log(`🔐 Cookie DIE (màn: ${st.state}) - đăng nhập lại bằng tài khoản ${acc.uid}`)
      const loginRes = await this.doLogin(wc, acc)
      if (this.isAborted) { await cleanup(); return { success: false, status: 'ERROR', uid: acc.uid, error: 'Đã hủy' } }
      if (loginRes === 'NEED_2FA_NO_SECRET') {
        await cleanup()
        return { success: false, status: 'ERROR', uid: acc.uid, error: 'Facebook yêu cầu mã 2FA nhưng dòng này không có secret 2FA. Đóng Chrome.' }
      }
      if (loginRes === 'CHECKPOINT') {
        await cleanup()
        return { success: false, status: 'CHECKPOINT', uid: acc.uid, error: 'Đăng nhập xong nhưng tài khoản đang checkpoint' }
      }
      if (loginRes !== 'LOGGED_IN') {
        await cleanup()
        return { success: false, status: 'ERROR', uid: acc.uid, error: 'Đăng nhập thất bại (sai mật khẩu / Facebook chặn?). Đóng Chrome.' }
      }
      this.log('✅ Đăng nhập thành công - tiếp tục nuôi')
      st = await this.detectState(wc)
    }

    if (st && st.state === 'CHECKPOINT') {
      await cleanup()
      return { success: false, status: 'CHECKPOINT', uid: acc.uid, error: 'Tài khoản checkpoint' }
    }
    if (st && st.state === 'DIE') {
      await cleanup()
      return { success: false, status: 'DIE', uid: acc.uid, error: 'Tài khoản bị khóa/vô hiệu hóa' }
    }
    // Sau bước login, hoặc cookie die mà state vẫn còn ở login/meta → thử lại nếu có pass
    const stillNeedLogin = st && (
      st.state === 'NEED_2FA' || st.state === 'LOGIN_FORM' ||
      st.state === 'META_SCREEN' || st.state === 'FAST_PASS'
    )
    if (stillNeedLogin) {
      // Vẫn bị đẩy về login sau khi nạp cookie -> thử login nếu có pass
      if ((acc.uid || acc.email) && acc.pass) {
        this.log(`🔐 Vẫn ở màn login (${st.state}) sau nạp cookie - thử login lại`)
        const loginRes = await this.doLogin(wc, acc)
        if (loginRes === 'NEED_2FA_NO_SECRET') {
          await cleanup()
          return { success: false, status: 'ERROR', uid: acc.uid, error: 'Facebook yêu cầu mã 2FA nhưng dòng này không có secret 2FA. Đóng Chrome.' }
        }
        if (loginRes === 'CHECKPOINT') {
          await cleanup()
          return { success: false, status: 'CHECKPOINT', uid: acc.uid, error: 'Tài khoản checkpoint' }
        }
        if (loginRes !== 'LOGGED_IN') {
          await cleanup()
          return { success: false, status: 'ERROR', uid: acc.uid, error: 'Đăng nhập thất bại sau khi nạp cookie. Đóng Chrome.' }
        }
        st = await this.detectState(wc)
      } else {
        await cleanup()
        return { success: false, status: 'DIE', uid: acc.uid, error: 'Cookie DIE (bị đẩy về trang đăng nhập) và không có tài khoản/mật khẩu' }
      }
    }

    // 6. Vòng nuôi: feed -> friends -> groups, chia thời gian theo tổng phút
    const totalMs = this.minutes * 60 * 1000
    const phases = [
      { name: 'feed', url: 'https://www.facebook.com/', ms: Math.max(60000, Math.round(totalMs * 0.4)) },
      { name: 'friends', url: 'https://www.facebook.com/friends', ms: Math.max(60000, Math.round(totalMs * 0.3)) },
      { name: 'groups', url: 'https://www.facebook.com/groups/discover', ms: Math.max(60000, Math.round(totalMs * 0.3)) }
    ]
    const stats = { like: 0, friend: 0, group: 0 }
    const phaseNames = { feed: 'lướt bảng tin', friends: 'kết bạn', groups: 'tham gia nhóm' }
    const runStart = Date.now()

    for (const ph of phases) {
      if (this.isAborted) break
      const remainTotal = totalMs - (Date.now() - runStart)
      if (remainTotal <= 30000) break
      const phaseMs = Math.min(ph.ms, remainTotal)
      this.log(`▶️ Giai đoạn ${phaseNames[ph.name]} (~${Math.round(phaseMs / 60000)} phút)...`)
      if (ph.name !== 'feed') {
        const okNav = await this.loadPage(wc, ph.url, 45000)
        if (this.isAborted) break
        if (!okNav) { this.log(`⚠ Không tải được trang ${ph.url} - bỏ qua giai đoạn này`); continue }
      }
      let stChk = await this.detectState(wc)
      if (stChk && (stChk.state === 'CHECKPOINT')) {
        await cleanup()
        return { success: false, status: 'CHECKPOINT', uid: acc.uid, error: 'Bị đẩy về checkpoint khi đang nuôi', stats }
      }
      const phaseEnd = Date.now() + phaseMs
      let idleStreak = 0
      let firstScan = true
      while (Date.now() < phaseEnd && !this.isAborted) {
        const r = await this.runAction(wc, ph.name)
        if (firstScan && r) {
          firstScan = false
          if (ph.name === 'friends') this.log(`🔍 Quét trang bạn bè: thấy ${r.frCount} nút kết bạn`)
        }
        if (!r) {
          idleStreak++
          if (idleStreak >= 6) { this.log('⚠ Không đọc được trang (trắng treo?) - dừng nuôi nick này'); break }
          await sleep(4000)
          continue
        }
        idleStreak = 0
        if (r.checkpoint) {
          await cleanup()
          return { success: false, status: 'CHECKPOINT', uid: acc.uid, error: 'Facebook checkpoint giữa lúc nuôi', stats }
        }
        if (r.disabled) {
          await cleanup()
          return { success: false, status: 'DIE', uid: acc.uid, error: 'Tài khoản bị khóa giữa lúc nuôi', stats }
        }
        if (r.loginForm) {
          // Bị đá về trang đăng nhập giữa lúc nuôi — thử login lại nếu có pass
          this.log('⚠ Bị đá về trang đăng nhập giữa lúc nuôi')
          if ((acc.uid || acc.email) && acc.pass) {
            this.log('🔐 Thử đăng nhập lại giữa vòng nuôi...')
            const midLogin = await this.doLogin(wc, acc)
            if (midLogin === 'LOGGED_IN') {
              this.log('✅ Đăng nhập lại thành công - tiếp tục nuôi')
              await sleep(3000)
              continue
            }
          }
          this.log('⛔ Không thể đăng nhập lại - dừng nick này')
          break
        }
        if (r.rate) {
          this.log(`⚠ Facebook báo hạn chế hành động - nghỉ 60s chỉ lướt nhẹ...`)
          await sleep(60000)
          continue
        }
        if (r.clicked === 'like') { stats.like++; this.log('👍 Đã thích 1 bài viết trên bảng tin') }
        else if (r.clicked === 'friend') { stats.friend++; this.log(`👥 Đã gửi lời mời kết bạn${r.target ? `: ${r.target}` : ''}`) }
        else if (r.clicked === 'group') { stats.group++; this.log(`🏢 Đã gửi yêu cầu tham gia nhóm${r.target ? `: ${r.target}` : ''}`) }
        await sleep(rand(5000, 9000))
      }
      if (Date.now() - runStart >= totalMs) break
    }

    // 7. Phân loại cuối + lấy cookie mới nhất
    const freshCookie = await this.extractCookieString(ses)
    let finalState = null
    try { finalState = await this.detectState(wc) } catch {}
    const urlNow = (finalState && finalState.url) || ''
    const bad = urlNow.includes('/checkpoint') || urlNow.includes('/confirmidentity') || urlNow.includes('/login')
    await cleanup()
    if (bad) {
      return { success: false, status: 'CHECKPOINT', uid: acc.uid, error: 'Kết thúc phiên nhưng URL về checkpoint/login', stats, cookie: freshCookie }
    }
    this.log(`🏁 Nuôi xong ${acc.uid || ''}: 👍${stats.like} 👥${stats.friend} 🏢${stats.group}`)
    return { success: true, status: 'LIVE', uid: acc.uid, stats, cookie: freshCookie }
  }
}

module.exports = { FBNuoiEngine, parseAccountLine, totpFromSecret }
