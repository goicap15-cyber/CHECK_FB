const { app, BrowserWindow, ipcMain, dialog, shell, session, net, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const crypto = require('crypto')

let mainWindow
let authWindow
let checkingAborted = false
let activeBrowserWindows = []

// ==================== AUTH / PASSWORD SYSTEM ====================

// ⚠️  ĐỔI MASTER PASSWORD Ở ĐÂY (dùng để đổi mật khẩu app)
// Đây là SHA-256 của chuỗi: MASTER_FB2024
// Để đổi master password: thay hash bên dưới = sha256 của chuỗi mới
const MASTER_HASH = 'f20a623b4e0568fae893683450eb3030026e6d5424a9608063b99237da213a3c'
// Mật khẩu master mặc định: MASTER_FB2024
// Để tạo hash mới: node -e "const c=require('crypto');console.log(c.createHash('sha256').update('YOUR_MASTER_PASS').digest('hex'))"

const CONFIG_FILE = path.join(app.getPath('userData'), 'fb_checker_cfg.json')

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex')
}

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function writeConfig(data) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function getAppPasswordHash() {
  const cfg = readConfig()
  // Mật khẩu app mặc định: 1234
  return cfg.appPasswordHash || sha256('1234')
}

function getMasterHash() {
  return MASTER_HASH
}

// ==================== WINDOW ====================

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    frame: false,
    backgroundColor: '#07071a',
    show: false,
  })

  mainWindow.loadFile('index.html')
  mainWindow.once('ready-to-show', () => mainWindow.show())
}

function createAuthWindow() {
  appHadWindow = true
  authWindow = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    center: true,
    frame: false,
    backgroundColor: '#07071a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'auth-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  authWindow.loadFile('auth.html')
  authWindow.once('ready-to-show', () => {
    authWindow.show()
  })

  // Không cho đóng auth window (bắt buộc phải nhập pass)
  authWindow.on('close', (e) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      app.quit()
    }
  })
}

// Mỗi phiên reg/TikTok tạo 1 partition persist riêng -> cache đĩa tích lũy qua các lần chạy
// -> mở app dọn hết partition cũ (lúc này chưa có engine nào chạy nên xóa an toàn)
function cleanupOldPartitions() {
  try {
    const partDir = path.join(app.getPath('userData'), 'Partitions')
    if (!fs.existsSync(partDir)) return
    for (const d of fs.readdirSync(partDir)) {
      // rác từ: Auto Reg (fbreg_) / TikTok (ttreg_) / checker worker (fb_worker_) /
      // check proxy (proxychk_) / tạo BM + invite + quét BM (bm...) / tạo account BM (adacc...)
      if (/^(fbreg_|ttreg_|fb_worker_|proxychk_|bm|adacc)/.test(d)) {
        try {
          fs.rmSync(path.join(partDir, d), { recursive: true, force: true })
          console.log('[dọn rác] Xóa partition cũ: ' + d)
        } catch {}
      }
    }
  } catch {}
}

// ID bản build main process — renderer đối chiếu để phát hiện "process cũ còn sống +
// UI mới load từ đĩa" (update file mà app cũ chưa tắt hẳn -> thiếu IPC handler mới).
// Mỗi lần sync code phải bump số này ở main.js VÀ renderer.js cho bằng nhau.
const APP_BUILD_ID = 20261025.46
ipcMain.handle('app:buildinfo', () => APP_BUILD_ID)

// Chống chạy 2 app cùng lúc: 2 instance sẽ giành chung key SMS/proxy/email và ghi chung
// file log/kết quả -> FB từ chối đăng ký hàng loạt ("An error occurred during your
// registration"). Lần mở thứ 2 tự thoát và focus vào cửa sổ app đang chạy.
const gotSingleLock = app.requestSingleInstanceLock()
if (!gotSingleLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : (authWindow && !authWindow.isDestroyed() ? authWindow : null)
    if (w) {
      try {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      } catch {}
    } else if (!isRegRunning && !isBMRunning && !isTikTokRunning && !isNuoiRunning && !isCkptRunning && !isAuthRunning && !isPageRunning) {
      // Process ẩn không còn cửa sổ nào mà cũng không chạy gì (zombie do window-all-closed
      // từng bỏ qua quit) -> tự thoát để lần bấm exe tiếp theo được nạp code mới từ đĩa
      app.quit()
    }
  })
}

app.whenReady().then(() => {
  cleanupOldPartitions()
  createAuthWindow()
  restoreCkptRechecks()
  notifyNuoiQueue()   // gửi danh sách hàng chờ nuôi (persist từ lần chạy trước) lên UI
})

// ── Ghi sự cố renderer/child-process (chẩn đoán chrome bị ngắt đột ngột khi đa luồng) ──
const CRASH_LOG = path.join(__dirname, 'crash_log.txt')
function logCrash(msg) {
  try { fs.appendFileSync(CRASH_LOG, `[${new Date().toLocaleString('vi-VN', { hour12: false })}] ${msg}\n`, 'utf8') } catch {}
}
app.on('child-process-gone', (e, details) => {
  logCrash(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} service=${details.service || '?'}`)
})
app.on('render-process-gone', (e, wc, details) => {
  let url = '?'
  try { url = (wc && wc.getURL) ? wc.getURL().substring(0, 90) : '?' } catch {}
  logCrash(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode} url=${url}`)
})


// ── Chống app tắt đột ngột ──
// Crash log ra file cạnh app: uncaughtException/unhandledRejection/renderer chết
// đều được ghi lại thay vì chết im lặng (không hiểu sao tool tắt).
const crashLog = (msg) => {
  try {
    fs.appendFileSync(path.join(__dirname, 'main_crash_log.txt'),
      `[${new Date().toLocaleString('vi-VN', { hour12: false })}] ${msg}\n`, 'utf8')
  } catch {}
}
process.on('uncaughtException', (err) => {
  crashLog('uncaughtException: ' + (err && err.stack || err))
})
process.on('unhandledRejection', (reason) => {
  crashLog('unhandledRejection: ' + (reason && (reason.stack || reason.message) || reason))
})
app.on('child-process-gone', (e, details) => {
  crashLog('child-process-gone: ' + JSON.stringify(details))
})
app.on('render-process-gone', (e, wc, details) => {
  crashLog(`render-process-gone (webContents #${wc && wc.id}): ` + JSON.stringify(details))
})

app.on('window-all-closed', () => {
  // Đang chạy reg/BM mà tất cả cửa sổ đóng (3 Chrome lỗi tự đóng, main window
  // có thể đã bị tắt) -> KHÔNG quit giữa chừng, giữ app sống
  if (isRegRunning || isBMRunning || isTikTokRunning) {
    crashLog('window-all-closed bỏ qua vì đang chạy reg/BM/TikTok (giữ app sống)')
    return
  }
  if (process.platform !== 'darwin') app.quit()
})

// Sau khi run xong mà không còn cửa sổ nào (main đã đóng, Chrome reg tự đóng hết)
// -> thoát app thay vì thành process ẩn không cửa sổ
let appHadWindow = false
setInterval(() => {
  try {
    if (appHadWindow && !isRegRunning && !isBMRunning && !isTikTokRunning && BrowserWindow.getAllWindows().length === 0) {
      crashLog('Không còn cửa sổ nào sau khi chạy xong - thoát app')
      app.quit()
    }
  } catch {}
}, 5000)

// ==================== AUTH IPC ====================

ipcMain.handle('auth:verify', async (event, pwd) => {
  if (!pwd) return false
  return sha256(pwd) === getAppPasswordHash()
})

ipcMain.handle('auth:verifyMaster', async (event, pwd) => {
  if (!pwd) return false
  return sha256(pwd) === getMasterHash()
})

ipcMain.handle('auth:changePassword', async (event, newPwd) => {
  if (!newPwd || newPwd.length < 4) return false
  const cfg = readConfig()
  cfg.appPasswordHash = sha256(newPwd)
  return writeConfig(cfg)
})

ipcMain.on('auth:unlock', () => {
  // Mở main window, đóng auth window
  createMainWindow()
  if (authWindow && !authWindow.isDestroyed()) {
    // Đợi main window ready rồi mới đóng auth
    if (mainWindow) {
      mainWindow.once('ready-to-show', () => {
        if (authWindow && !authWindow.isDestroyed()) authWindow.destroy()
      })
    } else {
      authWindow.destroy()
    }
  }
})

// ==================== COOKIE PARSING & DECODING ====================

function decodeBuffer(buf) {
  if (!buf || buf.length === 0) return ''
  // UTF-16 LE BOM
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  // UTF-16 BE BOM
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le')
  // UTF-8 BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8')
  // Detect UTF-16 LE without BOM (common in Windows Notepad)
  let nulls = 0
  const sampleLen = Math.min(buf.length, 120)
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) nulls++
  }
  if (nulls > 10) return buf.toString('utf16le')
  return buf.toString('utf8')
}

function cleanCookieString(str) {
  if (!str) return ''
  str = str.replace(/[\r\n]/g, ' ').trim()
  // Format like UID|PASS|2FA|COOKIE or UID|COOKIE
  if (str.includes('|')) {
    const parts = str.split('|')
    const cookiePart = parts.find(p => p.includes('xs=') || p.includes('c_user='))
    if (cookiePart) str = cookiePart.trim()
  }
  // Remove enclosing quotes or brackets
  str = str.replace(/^["'`\s]+|["'`\s]+$/g, '')
  return str
}

// Cookie Gmail (Auto Reg FB v2): SID/HSID/SSID/... — chấp nhận chung với cookie FB
function isFbOrGmailCookie(s) {
  const t = String(s || '')
  if (t.includes('c_user=') || t.includes('xs=')) return true
  return /(?:^|[;s])(?:__Secure-)?(?:1PSID|3PSID|SID|HSID|SSID|APISID|SAPISID)=/.test(t)
}

function parseCookieContent(content) {
  const cookies = []
  if (!content) return cookies
  content = content.trim()
  if (!content) return cookies

  // 1. Whole file JSON
  if (content.startsWith('[') || content.startsWith('{')) {
    try {
      const parsed = JSON.parse(content)
      // Extension format: [{name, value}, ...]
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name && parsed[0].value !== undefined) {
        const cStr = parsed.map(c => `${c.name}=${c.value}`).join('; ')
        if (isFbOrGmailCookie(cStr)) {
          cookies.push({ cookie: cStr, raw: '' })
          return cookies
        }
      }
      // Array of accounts
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') {
            const c = cleanCookieString(item)
            if (isFbOrGmailCookie(c)) cookies.push({ cookie: c, raw: item })
          } else if (Array.isArray(item)) {
            const cStr = item.filter(c => c.name && c.value !== undefined).map(c => `${c.name}=${c.value}`).join('; ')
            if (isFbOrGmailCookie(cStr)) cookies.push({ cookie: cStr, raw: '' })
          } else if (item && typeof item === 'object') {
            if (item.cookie) {
              const c = cleanCookieString(item.cookie)
              if (c) cookies.push({ cookie: c, raw: item.cookie })
            } else if (item.c_user || item.xs) {
              const cStr = Object.entries(item).map(([k, v]) => `${k}=${v}`).join('; ')
              cookies.push({ cookie: cStr, raw: '' })
            }
          }
        }
        if (cookies.length > 0) return cookies
      }
      // Single object
      if (parsed && typeof parsed === 'object') {
        if (parsed.cookie) {
          const c = cleanCookieString(parsed.cookie)
          if (c) return [{ cookie: c, raw: parsed.cookie }]
        }
        if (parsed.c_user || parsed.xs) {
          return [{ cookie: Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join('; '), raw: '' }]
        }
      }
    } catch {}
  }

  // 2. Netscape format (tab separated)
  if (content.includes('\t') && (content.includes('c_user') || content.includes('xs'))) {
    const lines = content.split(/\r?\n/)
    let currentAccount = []
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) {
        if (currentAccount.length > 0) {
          const cStr = currentAccount.join('; ')
          if (isFbOrGmailCookie(cStr)) cookies.push({ cookie: cStr, raw: '' })
          currentAccount = []
        }
        continue
      }
      if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue
      const parts = line.split(/\t+/)
      if (parts.length >= 7) {
        const name = parts[parts.length - 2].trim()
        const value = parts[parts.length - 1].trim()
        if (name && value) currentAccount.push(`${name}=${value}`)
      }
    }
    if (currentAccount.length > 0) {
      const cStr = currentAccount.join('; ')
      if (isFbOrGmailCookie(cStr)) cookies.push({ cookie: cStr, raw: '' })
    }
    if (cookies.length > 0) return cookies
  }

  // 3. Line by line
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue

    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t)
        if (Array.isArray(arr) && arr[0]?.name) {
          const cStr = arr.map(c => `${c.name}=${c.value}`).join('; ')
          if (isFbOrGmailCookie(cStr)) {
            cookies.push({ cookie: cStr, raw: t })
            continue
          }
        }
      } catch {}
    }

    const cleaned = cleanCookieString(t)
    if (isFbOrGmailCookie(cleaned)) {
      cookies.push({ cookie: cleaned, raw: t })
    }
  }
  return cookies
}

const IGNORE_EXTENSIONS = new Set(['.exe', '.dll', '.zip', '.rar', '.7z', '.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mp3', '.pdf', '.docx', '.xlsx', '.ico'])

// Dòng nhập dạng UID|PASS|...|COOKIE (reg export) -> lấy thêm id/email/mật khẩu
function extractAccountMeta(raw) {
  const meta = { uid: '', email: '', password: '' }
  const line = String(raw || '').replace(/^\s*\[[^\]]*\]\s*/, '')
  if (!line.includes('|')) return meta
  const parts = line.split('|').map(p => p.trim())
  const cookieIdx = parts.findIndex(p => p.includes('xs=') || p.includes('c_user='))
  const fields = parts.slice(0, cookieIdx === -1 ? parts.length : cookieIdx)
    for (const f of fields) {
      if (!f) continue
      if (!meta.uid && /^\d{6,}$/.test(f)) meta.uid = f
      else if (!meta.email && f.includes('@')) meta.email = f
      else if (!meta.password) meta.password = f
      // Khóa 2FA (base32 16+ ký tự, ví dụ PMYX2PA3UKBAPHM6 / PMYX 2PA3 UKBA PHM6) —
      // đứng sau password trong dòng uid|pass|2fa|cookie, dùng để lấy OTP khi check cần login lại
      else if (!meta.twofa && /^[A-Z2-7]{16,32}$/i.test(String(f).replace(/[\s-]/g, '')) && f.length >= 16) meta.twofa = f
    }
    return meta
}

function makeCookieEntry(o, label) {
  const meta = extractAccountMeta(o.raw)
  return { cookie: o.cookie, raw: o.raw || '', file: label, uid: meta.uid, email: meta.email, password: meta.password, twofa: meta.twofa || '' }
}

function readFromFolder(folderPath) {
  const entries = []
  const scanDir = (dir, prefix) => {
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (item.isDirectory()) {
        scanDir(path.join(dir, item.name), prefix ? `${prefix}/${item.name}` : item.name)
      } else if (item.isFile()) {
        const ext = path.extname(item.name).toLowerCase()
        if (IGNORE_EXTENSIONS.has(ext)) continue
        try {
          const buf = fs.readFileSync(path.join(dir, item.name))
          const content = decodeBuffer(buf)
          const cookies = parseCookieContent(content)
          const label = prefix ? `${prefix}/${item.name}` : item.name
          cookies.forEach(o => entries.push(makeCookieEntry(o, label)))
        } catch {}
      }
    }
  }
  scanDir(folderPath, '')
  return entries
}

function readFromZip(zipPath) {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(zipPath)
  const entries = []
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const ext = path.extname(entry.entryName).toLowerCase()
    if (IGNORE_EXTENSIONS.has(ext)) continue
    try {
      const buf = entry.getData()
      const content = decodeBuffer(buf)
      const cookies = parseCookieContent(content)
      cookies.forEach(o => entries.push(makeCookieEntry(o, entry.entryName)))
    } catch {}
  }
  return entries
}

function readFromFiles(filePaths) {
  const entries = []
  for (const fp of filePaths) {
    try {
      const buf = fs.readFileSync(fp)
      const content = decodeBuffer(buf)
      const cookies = parseCookieContent(content)
      cookies.forEach(o => entries.push(makeCookieEntry(o, path.basename(fp))))
    } catch {}
  }
  return entries
}

// ==================== HTTP & FACEBOOK CHECK ====================

function extractUid(cookieStr) {
  const m = (cookieStr || '').match(/c_user=(\d+)/)
  return m ? m[1] : ''
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
}

function checkFacebookMe(cookieStr) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.facebook.com',
      path: '/me',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': cookieStr,
        'sec-ch-ua': '"Not-A.Brand";v="99", "Chromium";v="124"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1'
      },
      timeout: 4500
    }, (res) => {
      const loc = (res.headers.location || '').trim()
      const statusCode = res.statusCode

      const locLower = loc.toLowerCase()

      // 1. Checkpoint / Vô hiệu hóa / Xác minh mã
      if (
        locLower.includes('/checkpoint') ||
        locLower.includes('checkpoint') ||
        locLower.includes('/disabled') ||
        locLower.includes('/suspended') ||
        locLower.includes('confirmemail') ||
        locLower.includes('confirmphone') ||
        locLower.includes('confirmcontactpoint') ||
        locLower.includes('two_factor') ||
        locLower.includes('two_step') ||
        locLower.includes('/identity') ||
        locLower.includes('/challenge') ||
        locLower.includes('/roadblock')
      ) {
        res.resume()
        return resolve({ status: 'CHECKPOINT', loc })
      }

      // 2. Die / Bị đẩy về trang đăng nhập — NHƯNG login kèm next=...checkpoint... là
      // checkpoint ngầm (bug 27-10: login lại bị đẩy về checkpoint, check cũ báo DIE/LIVE sai)
      if (
        !loc ||
        loc === 'https://www.facebook.com/' ||
        loc === 'https://www.facebook.com/?_rdr' ||
        locLower.includes('/login') ||
        locLower.includes('login.php') ||
        locLower.includes('/r.php')
      ) {
        if (locLower.includes('checkpoint') || locLower.includes('two_factor') || locLower.includes('/challenge')) {
          return resolve({ status: 'CHECKPOINT', loc })
        }
        return resolve({ status: 'DIE', loc })
      }

      // 3. Live: chuyển hướng sang profile hoặc trang người dùng
      if (loc.startsWith('https://www.facebook.com/') && !locLower.includes('/login')) {
        res.resume()
        let name = ''
        try {
          const u = new URL(loc)
          const p = u.pathname.replace(/^\/+|\/+$/g, '')
          if (p && !p.startsWith('profile.php') && !p.includes('/')) {
            name = p
          }
        } catch {}
        return resolve({ status: 'LIVE', loc, name })
      }

      // 4. Trả 200 OK: KHÔNG tự kết luận LIVE — checkpoint nhiều khi trả 200 kèm trang
      // chặn HTML (bug 27-10: nick checkpoint bị báo LIVE). Đọc body dò dấu checkpoint.
      if (statusCode === 200) {
        let body = ''
        let done = false
        const finish = () => {
          if (done) return
          done = true
          const b = body.toLowerCase()
          if (
            b.includes('checkpoint') ||
            b.includes('confirm your identity') ||
            b.includes('xác minh danh tính') ||
            b.includes('tài khoản của bạn đã bị khóa') ||
            b.includes('your account has been disabled') ||
            b.includes('account has been locked') ||
            b.includes('upload a photo') ||
            b.includes('photo id') ||
            b.includes('vô hiệu hóa') ||
            b.includes('select a confirmation option')
          ) {
            return resolve({ status: 'CHECKPOINT', loc: '200_BODY' })
          }
          if (b.includes('name="login"') || b.includes('đăng nhập') || b.includes('log into facebook')) {
            return resolve({ status: 'DIE', loc: '200_LOGIN' })
          }
          return resolve({ status: 'LIVE', loc: '200_OK' })
        }
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c; if (body.length > 150000) finish() })
        res.on('end', finish)
        res.on('error', finish)
        return
      }

      res.resume()
      return resolve({ status: 'DIE', loc })
    })

    req.on('error', (e) => resolve({ status: 'ERROR', error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 'ERROR', error: 'Timeout' }) })
    req.end()
  })
}

function fetchProfileName(uid, cookieStr) {
  if (!uid || uid === '?') return Promise.resolve('')
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.facebook.com',
      path: `/${uid}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': cookieStr,
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none'
      },
      timeout: 2500
    }, (res) => {
      let buf = ''
      res.on('data', chunk => {
        buf += chunk
        if (buf.length > 20000) res.destroy()
      })
      res.on('close', () => {
        const m = buf.match(/<title[^>]*>([^<]+)<\/title>/i)
        if (m) {
          let name = decodeHtmlEntities(m[1])
            .replace(/\s*\|.*$/, '').replace(/\s*-\s*Facebook.*$/, '').trim()
          const nLower = name.toLowerCase()
          if (nLower === 'facebook' || nLower.includes('log in') || nLower.includes('đăng nhập')) {
            name = ''
          }
          return resolve(name)
        }
        resolve('')
      })
    })
    req.on('error', () => resolve(''))
    req.on('timeout', () => { req.destroy(); resolve('') })
    req.end()
  })
}

async function checkSingleCookie(entry) {
  let { cookie, file } = entry
  cookie = (cookie || '').replace(/[\r\n]/g, ' ').trim()
  const uid = extractUid(cookie)

  // Nếu không có cả xs và c_user
  if (!cookie.includes('xs=') && !uid) {
    return { cookie, file, status: 'INVALID', uid: uid || '?', name: '' }
  }

  try {
    const checkRes = await checkFacebookMe(cookie)
    let name = checkRes.name || ''

    // Nếu LIVE mà chưa có tên, cố gắng lấy tên nhẹ nhàng
    if (checkRes.status === 'LIVE' && !name && uid) {
      try {
        name = await fetchProfileName(uid, cookie)
      } catch {}
    }

    return {
      cookie,
      file,
      status: checkRes.status,
      uid: uid || '—',
      name: name || '',
      error: checkRes.error || ''
    }
  } catch (err) {
    return {
      cookie,
      file,
      status: 'ERROR',
      uid: uid || '—',
      name: '',
      error: err.message
    }
  }
}

// ==================== IPC HANDLERS ====================

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Chọn thư mục chứa cookie'
  })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
  try {
    const entries = readFromFolder(r.filePaths[0])
    return { path: r.filePaths[0], entries, count: entries.length }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('dialog:zip', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'ZIP Archive', extensions: ['zip'] },
      { name: 'Tất cả file', extensions: ['*'] }
    ],
    title: 'Chọn file ZIP chứa cookie'
  })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
  try {
    const entries = readFromZip(r.filePaths[0])
    return { path: r.filePaths[0], entries, count: entries.length }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('dialog:files', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'File Cookie (*.txt, *.json, *.csv, *.log)', extensions: ['txt', 'json', 'csv', 'log', 'cookie', 'cookies'] },
      { name: 'Tất cả file (*.*)', extensions: ['*'] }
    ],
    title: 'Chọn file chứa cookie'
  })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
  try {
    const entries = readFromFiles(r.filePaths)
    return { entries, count: entries.length }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('cookies:parseText', async (event, text) => {
  try {
    const cookies = parseCookieContent(text || '')
    const entries = cookies.map(o => makeCookieEntry(o, 'Dán trực tiếp'))
    return { entries, count: entries.length }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('dialog:dropPath', async (event, targetPath) => {
  if (!targetPath) return { error: 'Đường dẫn không hợp lệ' }
  try {
    const stat = fs.statSync(targetPath)
    if (stat.isDirectory()) {
      const entries = readFromFolder(targetPath)
      return { path: targetPath, entries, count: entries.length }
    } else {
      const ext = path.extname(targetPath).toLowerCase()
      if (ext === '.zip') {
        const entries = readFromZip(targetPath)
        return { path: targetPath, entries, count: entries.length }
      } else {
        const entries = readFromFiles([targetPath])
        return { path: targetPath, entries, count: entries.length }
      }
    }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('dialog:dropZip2', async (event, zipPath) => {
  try {
    const entries = readFromZip(zipPath)
    return { path: zipPath, entries, count: entries.length }
  } catch (e) { return { error: e.message } }
})

let sharedRegEngine = null // Engine dùng chung: lấy OTP 2fa.page khi check cần tự login lại

async function checkCookieInBrowser(win, ses, entry, workerId, totalIndex) {
  let { cookie, file } = entry
  cookie = (cookie || '').replace(/[\r\n]/g, ' ').trim()
  const uid = extractUid(cookie)

  if (!cookie.includes('xs=') && !uid) {
    return { cookie, file, status: 'INVALID', uid: uid || entry.uid || '?', email: entry.email || '', password: entry.password || '', name: '' }
  }

  if (win.isDestroyed() || checkingAborted) {
    return { cookie, file, status: 'DIE', uid: uid || entry.uid || '—', email: entry.email || '', password: entry.password || '', name: '' }
  }

  win.setTitle(`[Chrome Luồng #${workerId + 1}] Đang nạp Cookie #${totalIndex + 1} (UID: ${uid || 'N/A'})...`)

  // 1. Xóa sạch dữ liệu phiên trước của partition này
  try { await ses.clearStorageData() } catch {}

  // 2. Set các cookie vào Facebook
  const cookiePairs = cookie.split(';').map(s => s.trim()).filter(Boolean)
  for (const pair of cookiePairs) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const name = pair.slice(0, eqIdx).trim()
    const value = pair.slice(eqIdx + 1).trim()
    if (!name) continue
    try {
      await ses.cookies.set({
        url: 'https://www.facebook.com',
        name,
        value,
        domain: '.facebook.com',
        path: '/',
        secure: true,
        sameSite: 'no_restriction'
      })
    } catch {}
  }

  // 3. Mở Facebook
  try {
    await win.loadURL('https://www.facebook.com/', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    })
  } catch (err) {
    if (checkingAborted) return { cookie, file, status: 'DIE', uid: uid || '—', name: '' }
  }

  // 4. Đợi trang chuyển hướng và render DOM
  await new Promise(r => setTimeout(r, 2200))

  if (win.isDestroyed() || checkingAborted) {
    return { cookie, file, status: 'DIE', uid: uid || '—', name: '' }
  }

  const currentUrl = win.webContents.getURL().toLowerCase()

  // 5. Kiểm tra thực tế DOM xem đã login thành công vào bên trong hay bị chặn ở ngoài login/continue
  // (bọc thành hàm để gọi lại sau khi tự login)
  const evaluateState = async () => await win.webContents.executeJavaScript(`
      (function() {
        const url = window.location.href.toLowerCase();
        const bodyText = (document.body ? document.body.innerText : '').toLowerCase();

        // 1. Checkpoint / Xác minh tài khoản / Nhập mã / Bị khóa / Vô hiệu hóa
        const hasCodeInput = !!document.querySelector('input[name*="code"], input[name="confirmation_code"], input[autocomplete="one-time-code"], input[name*="captcha"], input[name="vcode"]');
        const hasCheckpointText = 
          bodyText.includes('인증 코드') ||
          bodyText.includes('계정을 확인') ||
          bodyText.includes('xác minh danh tính') ||
          bodyText.includes('mã xác nhận') ||
          bodyText.includes('nhập mã') ||
          bodyText.includes('confirmation code') ||
          bodyText.includes('confirm your account') ||
          bodyText.includes('enter the code') ||
          bodyText.includes('enter code') ||
          bodyText.includes('tài khoản của bạn đã bị vô hiệu hóa') ||
          bodyText.includes('your account has been disabled') ||
          bodyText.includes('we suspended your account') ||
          bodyText.includes('phê duyệt đăng nhập') ||
          bodyText.includes('login approval');

        if (
          url.includes('/checkpoint') ||
          url.includes('checkpoint') ||
          url.includes('confirmemail') ||
          url.includes('confirmphone') ||
          url.includes('confirmcontactpoint') ||
          url.includes('two_factor') ||
          url.includes('two_step') ||
          url.includes('/identity') ||
          url.includes('/challenge') ||
          url.includes('/roadblock') ||
          url.includes('/disabled') ||
          url.includes('/suspended') ||
          url.includes('security/2fa') ||
          hasCodeInput ||
          hasCheckpointText
        ) {
          return { status: 'CHECKPOINT', name: '' };
        }

        // 2. Chắc chắn DIE nếu URL ở trang đăng nhập hoặc device-based
        if (
          url.includes('/login') ||
          url.includes('login.php') ||
          url.includes('/r.php') ||
          url.includes('/recover') ||
          url.includes('device-based')
        ) {
          return { status: 'DIE', name: '' };
        }

        // 3. Màn hình chọn tài khoản / Nhấp vào ảnh để đăng nhập / Nút "Continue"
        const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], a'));
        const hasContinueOrLoginBtn = allButtons.some(b => {
          const t = (b.textContent || '').trim().toLowerCase();
          return t === 'continue' || 
                 t === 'tiếp tục' || 
                 t.startsWith('continue as') || 
                 t.startsWith('tiếp tục dưới tên') ||
                 t === 'log in' || 
                 t === 'đăng nhập';
        });

        const hasInputs = !!document.querySelector('input[name="email"], input#email, input[name="pass"], input[type="password"]');
        const hasLoginForm = !!document.querySelector('form[action*="/login/"], form[action*="login.php"], div[data-testid="royal_login_form"]');

        const hasLoginText = bodyText.includes('tạo tài khoản mới') || 
                             bodyText.includes('create new account') ||
                             bodyText.includes('quên mật khẩu') ||
                             bodyText.includes('forgot password') ||
                             bodyText.includes('recent accounts') ||
                             bodyText.includes('nhấp vào ảnh đại diện') ||
                             bodyText.includes('tài khoản gần đây');

        // Bị chặn ở cổng đăng nhập ➔ DIE
        if (hasContinueOrLoginBtn || hasInputs || hasLoginForm || hasLoginText) {
          return { status: 'DIE', name: '' };
        }

        // 4. ĐIỀU KIỆN TIÊN QUYẾT ĐỂ ĐƯỢC COI LÀ LIVE:
        // Phải có ít nhất 1 thành phần chính thức bên trong Facebook khi đã đăng nhập thành công
        const hasSearch = !!document.querySelector('input[aria-label*="Search"], input[aria-label*="Tìm kiếm"], input[placeholder*="Search"], input[placeholder*="Tìm kiếm"]');
        const hasNavHome = !!document.querySelector('a[aria-label*="Home"], a[aria-label*="Trang chủ"], div[aria-label*="Home"], div[aria-label*="Trang chủ"]');
        const hasProfileMenu = !!document.querySelector('div[aria-label*="Your profile"], div[aria-label*="Tài khoản của bạn"], a[href*="/me/"]');
        const hasFeed = !!document.querySelector('div[role="feed"], div[aria-label*="Stories"], div[aria-label*="Bảng tin"], div[aria-label*="Tin"], div[data-pagelet="Feed"]');

        // Nếu đã vào được bên trong giao diện Facebook:
        if (hasSearch || hasNavHome || hasProfileMenu || hasFeed) {
          let name = '';
          const profileLink = document.querySelector('a[href*="/me/"], a[aria-label*="Trang cá nhân"], a[aria-label*="Profile"]');
          if (profileLink) {
            name = profileLink.getAttribute('aria-label') || profileLink.textContent || '';
            name = name.replace(/Trang cá nhân của | Profile/gi, '').trim();
          }
          const title = (document.title || '').trim();
          if (!name && title && !title.toLowerCase().includes('facebook') && !title.toLowerCase().includes('log in') && !title.toLowerCase().includes('đăng nhập')) {
            name = title.replace(/\\s*\\|.*$/, '').trim();
          }
          return { status: 'LIVE', name };
        }

        // Không có dấu hiệu đã đăng nhập ➔ DIE
        return { status: 'DIE', name: '' };
      })()
    `).catch(() => null)

  let evalResult = await evaluateState()
  let status = evalResult?.status || 'DIE'
  let name = evalResult?.name || ''

  // ── TỰ LOGIN LẠI: nick rơi ở màn login/Continue mà dòng có mật khẩu (uid|pass|2fa|cookie) ──
  // Continue fast-login -> điền mật khẩu -> nếu hỏi mã 2FA thì lấy OTP từ 2fa.page (key cột 2FA)
  // -> login xong check tiếp; LIVE thì lấy luôn cookie mới từ phiên
  let note = ''
  if (status === 'DIE' && entry.password && !win.isDestroyed() && !checkingAborted) {
    // Gõ vật lý KHÔNG vào cửa sổ ẩn/off-screen (test 27-10) — đưa lên màn hình trước
    try {
      if (!win.isVisible()) win.show()
      const wa = screen.getPrimaryDisplay().workArea
      const b = win.getBounds()
      if (b.x >= wa.x + wa.width || b.x < wa.x || b.y < wa.y) {
        win.setBounds({ x: wa.x + 30, y: wa.y + 30, width: b.width, height: b.height })
      }
      win.focus()
    } catch {}
    win.setTitle(`[Chrome Luồng #${workerId + 1}] Đang tự login lại UID ${uid || '?'}...`)
    try {
      // 27-10 fix: React của FB nuốt synthetic .click() -> mọi nút bấm bằng TỌA ĐỘ VẬT LÝ
      const physClick = async (finderJs) => {
        const pos = await win.webContents.executeJavaScript(finderJs).catch(() => null)
        if (!pos) return false
        win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
        await new Promise(r => setTimeout(r, 70))
        win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
        return true
      }
      // 27-10: flow login lại DÙNG CHUNG fblogin.js (đã test thành công: gõ vật lý +
      // đối chiếu UID màn "Log in as" + Use another/X màn Meta + poll 2FA 45s + Trust)
      const loginRes = await autoLoginFB({
        win, wc,
        log: (m) => console.log(`[Check UID ${uid}] ${m}`),
        uid: uid || '',
        email: entry.email || '',
        password: entry.password || '',
        twofa: entry.twofa || '',
        isAborted: () => checkingAborted
      })
      if (loginRes.status === 'WRONG_PASSWORD') {
        note = 'Sai mật khẩu — FB không nhận pass trong dòng (' + (loginRes.note || '') + ')'
        status = 'DIE'
        console.log(`[Check UID ${uid}] ${note}`)
      } else if (loginRes.status === 'NEED_2FA_NO_SECRET') {
        note = 'Cần mã 2FA nhưng dòng không có key 2FA'
        status = 'DIE'
        console.log(`[Check UID ${uid}] ${note}`)
      } else if (loginRes.status === 'CHECKPOINT') {
        note = loginRes.note || 'FB chặn màn xác minh'
        status = 'CHECKPOINT'
        console.log(`[Check UID ${uid}] ${note}`)
      } else if (loginRes.status === 'STUCK') {
        note = 'Tự login thất bại (' + (loginRes.note || 'lý do không rõ') + ')'
        status = 'DIE'
        console.log(`[Check UID ${uid}] ${note}`)
      }


      // B4: đánh giá lại sau login
      evalResult = await evaluateState()
      status = evalResult?.status || 'DIE'
      name = evalResult?.name || ''

      if (status === 'LIVE') {
        // Lấy cookie MỚI từ phiên đăng nhập để export ra file
        try {
          const list = await ses.cookies.get({})
          const fb = list.filter(c => (c.domain || '').includes('facebook.com') && c.value)
          const fresh = fb.map(c => `${c.name}=${c.value}`).join('; ')
          if (fresh.includes('c_user=')) {
            cookie = fresh
            note = (note ? note + ' — ' : '') + 'Đã tự login lại thành công' + (needed2fa ? ' (qua 2FA)' : '') + ', cookie mới'
          } else {
            note = (note ? note + ' — ' : '') + 'Đã tự login lại thành công' + (needed2fa ? ' (qua 2FA)' : '')
          }
        } catch {}
      } else if (status === 'CHECKPOINT') {
        note = (note ? note + ' — ' : '') + 'Login được nhưng checkpoint'
      } else {
        if (!note) note = 'Tự login thất bại (sai mật khẩu / 2FA chặn)'
        status = 'DIE'
      }
      console.log(`[Check UID ${uid}] tự login -> ${status}${note ? ' (' + note + ')' : ''}`)
    } catch (eLogin) {
      note = 'Lỗi flow tự login: ' + eLogin.message
      status = 'DIE'
    }
  }

  if (!win.isDestroyed()) {
    win.setTitle(`[Chrome Luồng #${workerId + 1}] ➜ ${status} | UID: ${uid || 'N/A'} ${name ? '(' + name + ')' : ''}`)
  }

  return {
    cookie,
    file,
    status,
    uid: uid || '—',
    email: entry?.email || '', // Lưu thêm email nếu có
    password: entry?.password || '', // Lưu thêm password nếu có
    twofa: entry?.twofa || '',
    name,
    note
  }
}

ipcMain.handle('cookies:check', async (event, { entries, concurrency = 3, showBrowser = true }) => {
  checkingAborted = false
  activeBrowserWindows = []
  
  // Lọc trùng: key = c_user (uid), cookie không có c_user thì dùng nguyên chuỗi cookie
  const inputEntries = Array.isArray(entries) ? entries : []
  const seenKeys = new Set()
  const filteredEntries = []
  let duplicatesRemoved = 0

  for (const entry of inputEntries) {
    if (!entry || !entry.cookie) continue
    const key = extractUid(entry.cookie) || String(entry.cookie).replace(/\s+/g, '')
    if (seenKeys.has(key)) { duplicatesRemoved++; continue }
    seenKeys.add(key)
    filteredEntries.push(entry)
  }

  if (duplicatesRemoved > 0) {
    console.log(`[Check Cookie] Đã lọc ${duplicatesRemoved} cookie trùng (theo UID c_user)`)
  }

  if (!filteredEntries.length) {
    return { error: 'Không có cookie hợp lệ để kiểm tra' }
  }

  const results = new Array(filteredEntries.length).fill(null)
  let taskIdx = 0
  let completed = 0
  const startTime = Date.now()

  const numWorkers = Math.min(Math.max(concurrency, 1), filteredEntries.length)

  const runWorker = async (workerId) => {
    const partitionName = `persist:fb_worker_${workerId}_${Date.now()}`
    const ses = session.fromPartition(partitionName)

    // Xếp các cửa sổ Chrome dàn đều trên màn hình
    const winWidth = 440
    const winHeight = 580
    const screenX = 40 + (workerId % 3) * 450
    const screenY = 50 + Math.floor(workerId / 3) * 310

    let win = null
    try {
      win = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        x: screenX,
        y: screenY,
        show: showBrowser,
        title: `Chrome Luồng #${workerId + 1} - Khởi động...`,
        autoHideMenuBar: true,
        webPreferences: {
          session: ses,
          nodeIntegration: false,
          contextIsolation: true
        }
      })
      activeBrowserWindows.push(win)

      win.on('closed', () => {
        activeBrowserWindows = activeBrowserWindows.filter(w => w !== win)
      })

      while (taskIdx < filteredEntries.length && !checkingAborted) {
        if (!win || win.isDestroyed()) break

        const i = taskIdx++
        const entry = filteredEntries[i]

        const result = await checkCookieInBrowser(win, ses, entry, workerId, i)
        results[i] = result
        completed++

        const elapsed = (Date.now() - startTime) / 1000
        const speed = completed / elapsed
        const remaining = filteredEntries.length - completed
        const eta = speed > 0 ? Math.round(remaining / speed) : 0

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('check:progress', {
            index: i,
            result,
            completed,
            total: filteredEntries.length,
            speed: speed.toFixed(1),
            eta
          })
        }
      }
    } catch (err) {
      console.warn(`Worker #${workerId} error:`, err)
    } finally {
      if (win && !win.isDestroyed()) {
        // destroy() thay close(): trang đã đăng nhập có thể chặn close -> renderer sống mãi ăn RAM
        try { win.destroy() } catch {}
      }
      activeBrowserWindows = activeBrowserWindows.filter(w => w !== win)
    }
  }

  const workers = Array.from({ length: numWorkers }, (_, id) => runWorker(id))
  await Promise.all(workers)

  const stats = {
    total: results.length,
    live: results.filter(r => r?.status === 'LIVE').length,
    die: results.filter(r => r?.status === 'DIE').length,
    checkpoint: results.filter(r => r?.status === 'CHECKPOINT').length,
    error: results.filter(r => ['ERROR', 'INVALID'].includes(r?.status)).length,
    aborted: checkingAborted,
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('check:complete', stats)
  }
  
  // Trả về cả kết quả + thống kê lọc trùng
  return { results, stats, duplicatesRemoved }
})

ipcMain.handle('cookies:abort', () => {
  checkingAborted = true
  activeBrowserWindows.forEach(w => {
    try { if (!w.isDestroyed()) w.close() } catch {}
  })
  activeBrowserWindows = []
})

// ── MỞ CHROME XEM FB THEO COOKIE (tick ở bảng Kiểm Tra Cookie) ──
// Mỗi acc 1 cửa sổ riêng với session persist (login giữ lại khi mở lại);
// user tự tắt bằng nút X trên cửa sổ.
const openFBViewers = new Map() // uid -> BrowserWindow
ipcMain.handle('chk:openBrowser', async (event, { uid, name, cookie }) => {
  try {
    const key = String(uid || 'cookie-' + String(cookie || '').length + '-' + (name || ''))
    const old = openFBViewers.get(key)
    if (old && !old.isDestroyed()) {
      if (old.isMinimized()) old.restore()
      old.show()
      old.focus()
      return { ok: true, reused: true }
    }

    const sess = session.fromPartition('persist:fbview-' + key)
    const pairs = String(cookie || '').split(';').map(p => p.trim()).filter(Boolean).map(pair => {
      const i = pair.indexOf('=')
      return { name: i > -1 ? pair.substring(0, i).trim() : pair.trim(), value: i > -1 ? pair.substring(i + 1).trim() : '' }
    }).filter(c => c.name)
    for (const c of pairs) {
      for (const url of ['https://www.facebook.com', 'https://business.facebook.com']) {
        await sess.cookies.set({ url, name: c.name, value: c.value, domain: '.facebook.com', path: '/', secure: true, sameSite: 'no_restriction', expirationDate: Math.floor(Date.now() / 1000) + 86400 * 365 }).catch(() => {})
      }
    }
    await sess.cookies.flushStore()

    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      title: 'FB - ' + (uid || name || 'cookie'),
      autoHideMenuBar: true,
      webPreferences: { session: sess, nodeIntegration: false }
    })
    win.loadURL('https://www.facebook.com/')
    openFBViewers.set(key, win)
    win.on('closed', () => { openFBViewers.delete(key) })
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
})

function cookieToNetscape(cookieStr) {
  if (!cookieStr) return ''
  cookieStr = cookieStr.trim()
  if (cookieStr.includes('\t') && (cookieStr.includes('c_user') || cookieStr.includes('xs'))) {
    if (!cookieStr.startsWith('# Netscape')) {
      return '# Netscape HTTP Cookie File\n# http://curl.haxx.se/rfc/cookie_spec.html\n\n' + cookieStr
    }
    return cookieStr
  }

  const lines = [
    '# Netscape HTTP Cookie File',
    '# http://curl.haxx.se/rfc/cookie_spec.html',
    '# This file was generated by FB Cookie Checker',
    ''
  ]

  const pairs = cookieStr.split(';').map(s => s.trim()).filter(Boolean)
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const name = pair.slice(0, eqIdx).trim()
    const value = pair.slice(eqIdx + 1).trim()
    if (!name) continue
    lines.push(`.facebook.com\tTRUE\t/\tTRUE\t1799999999\t${name}\t${value}`)
  }
  return lines.join('\n')
}

ipcMain.handle('results:exportLiveFolder', async (event, liveResults, filterStatus = 'LIVE') => {
  // 25-10: nhận thêm filterStatus ('LIVE' | 'CHECKPOINT') — xuất folder Netscape cho Live HOẶC Checkpoint
  const rows = (liveResults || []).filter(r => r?.status === filterStatus)
  if (!rows.length) {
    return { error: `Không có cookie ${filterStatus} nào để xuất!` }
  }

  const label = filterStatus === 'CHECKPOINT' ? 'Checkpoint' : 'Live'
  const r = await dialog.showOpenDialog(mainWindow, {
    title: `Chọn nơi lưu thư mục ${label} Cookies (Netscape)`,
    properties: ['openDirectory', 'createDirectory']
  })

  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }

  const baseFolder = r.filePaths[0]
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  const timeTag = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const tag = filterStatus === 'CHECKPOINT' ? 'Ckpt_Cookies' : 'Live_Cookies'
  const targetDir = path.join(baseFolder, `${tag}_${timeTag}`)

  try {
    fs.mkdirSync(targetDir, { recursive: true })

    const allNetscapeLines = []
    const allRawLines = []

    rows.forEach((item, idx) => {
      const uid = item.uid && item.uid !== '—' && item.uid !== '?' ? item.uid : `cookie_${idx + 1}`
      const netscapeContent = cookieToNetscape(item.cookie)
      const fileName = `${uid}.txt`
      fs.writeFileSync(path.join(targetDir, fileName), netscapeContent, 'utf8')

      allNetscapeLines.push(`# UID: ${uid} | Name: ${item.name || 'N/A'}\n${netscapeContent}\n`)
      allRawLines.push(item.cookie)
    })

    // Đồng thời tạo thêm 2 file tổng hợp để tiện sử dụng:
    fs.writeFileSync(path.join(targetDir, `_tat_ca_${filterStatus.toLowerCase()}_netscape.txt`), allNetscapeLines.join('\n---\n\n'), 'utf8')
    fs.writeFileSync(path.join(targetDir, `_tat_ca_${filterStatus.toLowerCase()}_raw.txt`), allRawLines.join('\n'), 'utf8')

    // File master: uid|email|password|2FA|name|cookie — cột 2FA đứng sau password đúng
    // thứ tự extractAccountMeta() đọc lại (check/menu 1 lấy OTP từ key khi login lại;
    // trước đây thiếu cột này nên import lại mất 2FA, bảng check hiện N/A)
    const masterContent = rows.map((item, idx) => {
      const uid = item.uid && item.uid !== '—' && item.uid !== '?' ? item.uid : `cookie_${idx + 1}`
      const twofa = String(item.twofa || item.twoFaKey || '').replace(/[\s-]/g, '')
      return `${uid}|${item.email || ''}|${item.password || ''}|${twofa}|${item.name || 'N/A'}|${item.cookie || ''}`
    }).join('\n')
    fs.writeFileSync(path.join(targetDir, filterStatus === 'CHECKPOINT' ? '_master_uid_ckpt.txt' : '_master_uid_pass.txt'), masterContent, 'utf8')

    // Tự động mở thư mục vừa xuất
    shell.openPath(targetDir)

    return { success: true, count: rows.length, path: targetDir }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('results:export', async (event, { results, format }) => {
  const ext = format === 'json' ? 'json' : 'txt'
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Export kết quả',
    defaultPath: `fb_results_${Date.now()}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  })
  if (r.canceled) return false

  let content = ''
  if (format === 'json') {
    content = JSON.stringify(results, null, 2)
  } else if (format === 'live_only') {
    // uid|email|password|2FA|cookie — thêm cột 2FA để import lại không mất key
    content = results.filter(r => r?.status === 'LIVE').map(r =>
      `${r.uid || '—'}|${r.email || ''}|${r.password || ''}|${String(r.twofa || '').replace(/[\s-]/g, '')}|${r.cookie || r.cookieStr || ''}`
    ).join('\n')
  } else if (format === 'all_txt') {
    content = results.map(r => {
      if (!r) return ''
      // Format mở rộng: uid|email|password|status|name|cookie
      return `[${r.status}] UID: ${r.uid} | Email: ${r.email || '—'} | Pass: ${r.password || '—'} | 2FA: ${r.twofa || 'N/A'} | Name: ${r.name || 'N/A'} | File: ${r.file}\n${r.cookie}`
    }).join('\n---\n')
  } else if (format === 'uid_live') {
    // uid|email|password|2FA cho nick live
    content = results.filter(r => r?.status === 'LIVE').map(r =>
      `${r.uid || '—'}|${r.email || ''}|${r.password || ''}|${String(r.twofa || '').replace(/[\s-]/g, '')}`
    ).join('\n')
  }

  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    shell.showItemInFolder(r.filePath)
    return true
  } catch (e) { return false }
})

// ==================== AUTO REG FACEBOOK & TEMPMAIL ====================
const TempMailMMO = require('./tempmail.js')
const TempMailId = require('./tempmailid.js')
const MailTm = require('./mailtm.js')
const TempMailG = require('./tempmailg.js')
const MailTd = require('./mailtd.js')
const SMSPVA = require('./sms.js')
const FBRegisterEngine = require('./fbreg.js')
const { findChromePath } = require('./chrome_cdp.js')
const { LDPlayerEngine, detectLdPlayerInstall } = require('./ldplayer.js')
const { parseProxyLine, checkProxy, flagOf, fetchProxyFromApi } = require('./proxy-utils.js')
const { FBNuoiEngine, parseAccountLine, totpFromSecret } = require('./fbnuoi.js')

let activeRegEngines = []
let isRegRunning = false
let regShowBrowserNow = true

// Proxy có user/pass: Chromium không nhận user:pass trong proxyRules
// nên bắt event login của app để tự trả credential khi proxy hỏi (407)
const proxyCredentials = new Map()
app.on('login', (event, webContents, details, authInfo, callback) => {
  try {
    if (authInfo && authInfo.isProxy) {
      const cred = proxyCredentials.get(`${authInfo.host}:${String(authInfo.port)}`)
      if (cred) return callback(cred.user, cred.pass)
    }
  } catch {}
})

ipcMain.handle('reg:getDomains', async (event, provider = 'tempmailapi') => {
  // Mail Own: catch-all trên server riêng — domain cố định của hệ thống
  if (provider === 'mailown') return ['khangvitoro.store', 'genblackmmoonline.online']
  if (provider === 'mailtd') return await new MailTd().getDomains()
  if (provider === 'mailtm') {
    const tm = new MailTm()
    return await tm.getDomains()
  }
  const tm = provider === 'tempmailid' ? new TempMailId() : new TempMailMMO()
  return await tm.getDomains()
})

ipcMain.handle('reg:testMail', async (event, domain, provider = 'tempmailapi') => {
  const tm = provider === 'mailtm'     ? new MailTm()
           : provider === 'tempmailid' ? new TempMailId()
           : new TempMailMMO()
  try {
    const res = await tm.createEmail(provider === 'mailtm' ? undefined : domain)
    return { success: true, email: res.email, sidToken: res.sidToken }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('reg:testSms', async () => {
  const sms = new SMSPVA()
  try {
    const balance = await sms.getBalance()
    return { success: true, balance }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('reg:getSmsPrices', async () => {
  const sms = new SMSPVA()
  try {
    const prices = await sms.getPrices()
    return { success: true, ...prices }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── SETTINGS: TempMail API key ──
ipcMain.handle('settings:getApiKey', async () => {
  return TempMailMMO.getApiKey ? TempMailMMO.getApiKey() : ''
})

// Lưu key mới: test trước bằng cách tạo email thật (200 = key sống),
// thất bại thì trả lỗi và GIỮ nguyên key cũ
ipcMain.handle('settings:saveApiKey', async (event, key) => {
  const k = String(key || '').trim()
  if (!k) return { success: false, error: 'Chưa nhập key' }
  const old = TempMailMMO.getApiKey()
  TempMailMMO.setApiKey(k)
  try {
    const tm = new TempMailMMO()
    const info = await tm.createEmail()
    return { success: true, email: info.email }
  } catch (err) {
    TempMailMMO.setApiKey(old)
    return { success: false, error: err.message }
  }
})

// ── SETTINGS: TempMail.id.vn token ──
ipcMain.handle('settings:getTempmailIdKey', async () => {
  return TempMailId.getApiKey ? TempMailId.getApiKey() : ''
})

// Lưu token mới: test trước bằng cách tạo email thật, lỗi thì giữ nguyên token cũ
ipcMain.handle('settings:saveTempmailIdKey', async (event, key) => {
  const k = String(key || '').trim()
  if (!k) return { success: false, error: 'Chưa nhập token' }
  const old = TempMailId.getApiKey()
  TempMailId.setApiKey(k)
  try {
    const tm = new TempMailId()
    const info = await tm.createEmail()
    return { success: true, email: info.email }
  } catch (err) {
    TempMailId.setApiKey(old)
    return { success: false, error: err.message }
  }
})

// ── SETTINGS: Mail.td API token ──
ipcMain.handle('settings:getMailTdKey', async () => {
  return MailTd.getApiKey ? MailTd.getApiKey() : ''
})

ipcMain.handle('settings:saveMailTdKey', async (event, key) => {
  const k = String(key || '').trim()
  if (!k) return { success: false, error: 'Chưa nhập key' }
  const old = MailTd.getApiKey()
  MailTd.setApiKey(k)
  try {
    const td = new MailTd()
    await td.createEmail()
    return { success: true }
  } catch (err) {
    MailTd.setApiKey(old)
    return { success: false, error: err.message }
  }
})

// ── SETTINGS: TempMailG API key ──
ipcMain.handle('settings:getTempmailGKey', async () => {
  return TempMailG.getApiKey ? TempMailG.getApiKey() : ''
})

ipcMain.handle('settings:saveTempmailGKey', async (event, key) => {
  const k = String(key || '').trim()
  if (!k) return { success: false, error: 'Chưa nhập key' }
  const old = TempMailG.getApiKey()
  TempMailG.setApiKey(k)
  try {
    const tm = new TempMailG()
    await tm.createEmail()
    return { success: true }
  } catch (err) {
    TempMailG.setApiKey(old)
    return { success: false, error: err.message }
  }
})

// ── SETTINGS: LDPlayer path (tự detect + override bằng file) ──
ipcMain.handle('settings:getLdPath', async () => {
  try {
    const inst = await detectLdPlayerInstall()
    return { success: !!inst, path: inst ? inst.dir : '', ldconsolePath: inst ? inst.ldconsolePath : '', adbPath: inst ? inst.adbPath : '' }
  } catch (err) {
    return { success: false, path: '', error: err.message }
  }
})

ipcMain.handle('settings:saveLdPath', async (event, dir) => {
  const d = String(dir || '').trim()
  if (!d) return { success: false, error: 'Chưa nhập đường dẫn' }
  const lc = path.join(d, 'ldconsole.exe')
  if (!fs.existsSync(lc)) return { success: false, error: 'Không thấy ldconsole.exe trong thư mục này' }
  try {
    fs.writeFileSync(path.join(__dirname, 'ldplayer_path.txt'), d, 'utf8')
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('reg:testLdplayer', async () => {
  try {
    const inst = await detectLdPlayerInstall()
    if (!inst) return { success: false, error: 'Không tìm thấy LDPlayer - cài LDPlayer hoặc khai báo đường dẫn trong Settings' }
    const { execFile } = require('child_process')
    const list2 = await new Promise((resolve) => {
      try {
        execFile(inst.ldconsolePath, ['list2'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
          resolve(String(stdout || ''))
        })
      } catch (e) {
        resolve('')
      }
    })
    const instances = list2.split(/\r?\n/).filter(l => /^\d+,/.test(l.trim()))
    return { success: true, path: inst.dir, ldconsolePath: inst.ldconsolePath, adbPath: inst.adbPath, instances: instances.length, raw: list2.substring(0, 400) }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── SETTINGS: SMSPVA API key (test = gọi /activation/balance) ──
ipcMain.handle('settings:getSmsKey', async () => {
  return SMSPVA.getApiKey ? SMSPVA.getApiKey() : ''
})

ipcMain.handle('settings:saveSmsKey', async (event, key) => {
  const k = String(key || '').trim()
  if (!k) return { success: false, error: 'Chưa nhập key' }
  const old = SMSPVA.getApiKey()
  SMSPVA.setApiKey(k)
  try {
    const sms = new SMSPVA()
    const balance = await sms.getBalance()
    if (balance == null) throw new Error('Không đọc được số dư từ SMSPVA')
    return { success: true, balance }
  } catch (err) {
    SMSPVA.setApiKey(old)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('reg:pickProxyFile', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn file danh sách proxy (.txt)',
    filters: [{ name: 'Text', extensions: ['txt', 'text'] }],
    properties: ['openFile']
  })
  if (r.canceled || !r.filePaths.length) return { canceled: true }
  try {
    return { content: fs.readFileSync(r.filePaths[0], 'utf8') }
  } catch (e) {
    return { error: 'Không đọc được file: ' + e.message }
  }
})

ipcMain.handle('reg:start', async (event, { count = 1, domain = null, showBrowser = true, proxy = null, mode = 'tempmail', emailProvider = 'tempmailapi', smsOperator = null, concurrency = 1, continuous = false, regVia = 'web', variant = 'v1', gmailAccounts = [], gmailVariant = 'plus', gmailCookies = [] } = {}) => {
  if (isRegRunning) {
    return { error: 'Tiến trình đăng ký đang chạy!' }
  }

  isRegRunning = true
  regShowBrowserNow = !!showBrowser
  const results = []

  // Chế độ LDPlayer: phải tìm thấy bộ cài LDPlayer (ldconsole + adb) trước khi chạy
  let ldInstall = null
  if (mode === 'ldplayer') {
    ldInstall = await detectLdPlayerInstall()
    if (!ldInstall) {
      isRegRunning = false
      return { error: 'Không tìm thấy LDPlayer trên máy! Cài LDPlayer (hoặc khai báo đường dẫn LDPlayer trong Settings) rồi thử lại.' }
    }
  }

  // v1 dùng kênh reg:*, tab Reg v2 dùng regv2:* (log/bảng riêng, không lẫn nhau)
  const ch = variant === 'v2' ? 'regv2' : 'reg'
  const sendLog = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ch + ':log', msg)
    }
  }

  const sendResult = (acc) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ch + ':accountResult', acc)
    }
  }

  const numWorkers = Math.min(Math.max(concurrency, 1), count)
  // 21-10 chiều: user chốt quay lại Electron khi flow đã ổn. Guard 10s trong fbreg.js
  // đã chặn bug CDP đen màn hình (promise addScript bị drop khi ≥3 session).
  // Lưu ý: ≥3 cửa sổ song song có thể mất stealth inject sớm (chỉ còn inject qua
  // dom-ready) — đen màn hình thì không. Muốn Chrome thật: đổi thành true.
  const USE_REAL_CHROME_REG = false
  const realChromePath = USE_REAL_CHROME_REG ? findChromePath() : null
  const useRealChrome = mode !== 'ldplayer' && !!realChromePath
  if (useRealChrome) sendLog(`🪟 Dùng CHROME THẬT để reg: ${realChromePath}`)
  else if (mode !== 'ldplayer') sendLog('🪟 Reg bằng cửa sổ Electron (Chrome nhúng của dự án)')
  const engines = []
  for (let w = 0; w < numWorkers; w++) {
    engines.push(mode === 'ldplayer'
      ? new LDPlayerEngine({ instanceIndex: w, install: ldInstall })
      : new FBRegisterEngine({ realChrome: useRealChrome, gmailAccounts }))
  }
  activeRegEngines = engines

  sendLog(`🚀 Bắt đầu tiến trình Auto Reg Facebook (Tổng: ${continuous ? 'LIÊN TỤC - reg đến khi bấm Dừng' : count + ' tài khoản'} | Chế độ: ${mode === 'sms' ? 'SMS - SMSPVA' : mode === 'ldplayer' ? 'LDPlayer - Facebook Lite' : `TempMail - ${emailProvider === 'tempmailid' ? 'tempmail.id.vn' : 'tempmailapi.io.vn'}`} | ${numWorkers} ${mode === 'ldplayer' ? 'giả lập LDPlayer' : 'Chrome'} chạy song song)...`)
  if (continuous && mode === 'sms') sendLog('⚠ Chế độ liên tục + SMS: sẽ thuê số liên tục (tốn tiền) cho đến khi bấm Dừng!')
  if (mode === 'ldplayer') sendLog(`📁 LDPlayer: ${ldInstall.ldconsolePath} | ${ldInstall.adbPath}`)

  // Parse proxy: dòng dạng link http(s) = nguồn API (mỗi nick tự gọi lấy proxy mới),
  // còn lại là proxy tĩnh (pre-check trước khi chạy)
  const rawProxyLines = String(proxy || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const apiProxyLines = [...new Set(rawProxyLines.filter(l => /^https?:\/\/[^/]+\/\S/.test(l)))]
  const apiProxySet = new Set(apiProxyLines)
  const parsedProxies = rawProxyLines.filter(l => !apiProxySet.has(l)).map(parseProxyLine).filter(Boolean)
  let aliveProxies = []
  const lastApiProxy = new Map()
  // TMProxy 1 key = 1 proxy duy nhất: 3 luồng cùng gọi get-new-proxy sẽ xoay IP
  // liên tục và giết proxy luồng khác đang dùng → cascade "proxy chết". Các luồng
  // dùng chung proxy tốt gần nhất của key, chỉ xoay IP khi nó thật sự chết.
  const apiProxyLastGood = new Map()
  const API_PROXY_REUSE_MS = 10 * 60 * 1000

  if (mode !== 'ldplayer' && (parsedProxies.length || apiProxyLines.length)) {
    for (const p of parsedProxies) {
      if (p.auth) proxyCredentials.set(`${p.auth.host}:${p.auth.port}`, { user: p.auth.user, pass: p.auth.pass })
    }
    if (parsedProxies.length) {
      sendLog(`🌐 Đang kiểm tra ${parsedProxies.length} proxy tĩnh (tải IP + thử Facebook, tối đa 25s)...`)
      const checks = await Promise.all(parsedProxies.map(p => checkProxy(p)))
      parsedProxies.forEach((p, idx) => {
        const c = checks[idx]
        if (c) {
          p.ip = c.ip
          p.geo = c.geo
          p.pingMs = c.pingMs
          aliveProxies.push(p)
          const g = c.geo
          const geoTxt = g && g.country && g.country !== 'N/A'
            ? ` [${flagOf(g.countryCode)} ${g.country}${g.city ? ' - ' + g.city : ''}${g.isp ? ' · ' + g.isp : ''}]`
            : ''
          sendLog(`   ✓ Proxy #${idx + 1} ${p.display} → ${geoTxt} IP ra: ${c.ip} (${c.pingMs}ms)`)
        } else {
          sendLog(`   ✗ Proxy #${idx + 1} ${p.display} CHẾT hoặc sai user/pass → bỏ qua`)
        }
      })
    }
    if (apiProxyLines.length) {
      sendLog(`🔌 Có ${apiProxyLines.length} link API proxy - mỗi tài khoản sẽ tự gọi API lấy proxy mới khi reg`)
      const testP = await fetchProxyFromApi(apiProxyLines[0])
      if (testP) {
        lastApiProxy.set(apiProxyLines[0], testP)
        if (testP.auth) proxyCredentials.set(`${testP.auth.host}:${testP.auth.port}`, { user: testP.auth.user, pass: testP.auth.pass })
        const tc = await checkProxy(testP)
        if (tc) {
          const tg = tc.geo
          const tGeo = tg && tg.country && tg.country !== 'N/A' ? ` [${flagOf(tg.countryCode)} ${tg.country}]` : ''
          testP.ip = tc.ip
          testP.geo = tc.geo
          testP.pingMs = tc.pingMs
          apiProxyLastGood.set(apiProxyLines[0], { proxy: testP, okAt: Date.now() })
          sendLog(`   ✓ Test link API OK: ${testP.display}${tGeo} IP ra: ${tc.ip} (${tc.pingMs}ms)`)
        } else {
          sendLog(`   ⚠ Link API trả proxy ${testP.display} nhưng không tải được Facebook qua nó - lúc reg vẫn thử lại`)
        }
      } else {
        sendLog('   ⚠ Test link API chưa lấy được proxy (sai link/hết key) - lúc reg sẽ thử lại từng nick')
      }
    }
    if (!aliveProxies.length && !apiProxyLines.length) {
      sendLog('❌ Tất cả proxy đều chết - dừng reg để không burn tài khoản bằng IP thật!')
      isRegRunning = false
      activeRegEngines = []
      return { error: 'Tất cả proxy đều chết hoặc sai user/pass!' }
    }
    const srcTxt = []
    if (aliveProxies.length) srcTxt.push(`${aliveProxies.length}/${parsedProxies.length} proxy tĩnh (xoay vòng)`)
    if (apiProxyLines.length) srcTxt.push(`${apiProxyLines.length} link API (mỗi nick 1 proxy mới)`)
    sendLog(`✓ Dùng ${srcTxt.join(' + ')}`)
  } else if (mode === 'ldplayer' && (parsedProxies.length || apiProxyLines.length)) {
    sendLog('⚠ Chế độ LDPlayer: giả lập Android chưa dùng được proxy có user/pass - reg bằng IP máy (FB Lite trên app ít bị FB chặn hơn web r.php)')
  } else {
    sendLog('⚠ KHÔNG có proxy nào - sẽ reg bằng IP MÁY THẬT. FB dễ từ chối ("An error occurred") và số SMS thuê bị đốt tiền!')
  }

  // Lấy 1 proxy từ link API cho nick: gọi API → lưu proxy tốt gần nhất.
  // Link API từ chối đổi IP quá sớm (TMProxy yêu cầu giữ IP tối thiểu vài phút) hoặc mạng hụt
  // → dùng lại proxy gần nhất (đã check lại) thay vì bỏ nick
  const acquireApiProxy = async (apiUrl, i, attempt) => {
    const good = apiProxyLastGood.get(apiUrl)
    if (good && Date.now() - good.okAt < API_PROXY_REUSE_MS) {
      sendLog(`🌍 Tài khoản ${i} dùng chung proxy của key (còn tốt): ${good.proxy.display} - 1 key chỉ có 1 proxy tại một thời điểm`)
      return good.proxy
    }
    if (good) {
      // Proxy quá 10p tuổi: check lại, còn sống thì dùng tiếp, chết mới xoay IP mới
      const rc = await checkProxy(good.proxy)
      if (rc) {
        good.okAt = Date.now()
        good.proxy.ip = rc.ip
        good.proxy.geo = rc.geo
        good.proxy.pingMs = rc.pingMs
        sendLog(`🌍 Tài khoản ${i} dùng chung proxy của key (check lại vẫn sống): ${good.proxy.display} → IP ra: ${rc.ip}`)
        return good.proxy
      }
      apiProxyLastGood.delete(apiUrl)
      sendLog('   ✗ Proxy cũ của key đã chết → xoay IP mới')
    }
    sendLog(`🔌 Gọi link API lấy proxy mới cho tài khoản ${i}${attempt > 0 ? ` (thử lại lần ${attempt + 1})` : ''}...`)
    let apiP = await fetchProxyFromApi(apiUrl)
    if (apiP) lastApiProxy.set(apiUrl, apiP)
    else {
      const lastP = lastApiProxy.get(apiUrl)
      if (lastP) {
        sendLog(`   ⚠ Link API chưa trả proxy mới (đổi IP quá sớm/mạng hụt) - dùng lại proxy gần nhất ${lastP.display}`)
        apiP = lastP
      }
    }
    if (!apiP) {
      sendLog('   ✗ Link API không trả được proxy → thử nguồn khác')
      return null
    }
    if (apiP.auth) proxyCredentials.set(`${apiP.auth.host}:${apiP.auth.port}`, { user: apiP.auth.user, pass: apiP.auth.pass })
    const apiC = await checkProxy(apiP)
    if (!apiC) {
      sendLog(`   ✗ Proxy API ${apiP.display} chết/chặn Facebook → thử nguồn khác`)
      if (lastApiProxy.get(apiUrl) === apiP) lastApiProxy.delete(apiUrl)
      return null
    }
    apiP.ip = apiC.ip
    apiP.geo = apiC.geo
    apiP.pingMs = apiC.pingMs
    const g = apiP.geo
    const geoTxt = g && g.country && g.country !== 'N/A' ? ` [${flagOf(g.countryCode)} ${g.country}]` : ''
    apiProxyLastGood.set(apiUrl, { proxy: apiP, okAt: Date.now() })
    sendLog(`   ✓ Proxy API ${apiP.display}${geoTxt} → IP ra: ${apiC.ip} (${apiC.pingMs}ms)`)
    return apiP
  }

  // Chạy background không làm nghẽn IPC call
  ;(async () => {
    let proxyOffset = 0
    let apiOffset = 0
    let nextAccount = 1

    // ── v2: trạng thái cookie Gmail — mỗi luồng 1 cookie riêng; FB checkpoint hoặc
    // cookie chết -> loại cookie khỏi vòng xoay, luồng lấy cookie kế tiếp còn sống
    const workerCookie = []
    const deadCookies = new Set()
    let cookieCursor = 0
    const nextLiveCookie = () => {
      if (deadCookies.size >= gmailCookies.length) return null
      for (let t = 0; t < gmailCookies.length; t++) {
        const cand = gmailCookies[cookieCursor % gmailCookies.length]
        cookieCursor++
        if (!deadCookies.has(cand)) return cand
      }
      return null
    }

    const worker = async (w) => {
      let engine = engines[w]

      while (isRegRunning && !engine.isAborted) {
        const i = nextAccount
        if (!continuous && i > count) break
        nextAccount++

        sendLog(`━━━━━━━━━━ [Luồng ${w + 1}] Đang xử lý tài khoản ${continuous ? '#' + i + ' (liên tục)' : i + '/' + count} ━━━━━━━━━━`)
        sendLog(`🧭 v2 trace worker: gmailCookies[${i - 1}] = ${(gmailCookies[i - 1] || '').length} ký tự | emailProvider=${emailProvider} | variant=${variant}`)

        // ── v2: mỗi LUỒNG giữ 1 cookie Gmail riêng — cookie chết/checkpoint thì xoay cookie khác ──
        let v2GmailCookie = ''
        if (variant === 'v2' && gmailCookies.length) {
          if (!workerCookie[w] || deadCookies.has(workerCookie[w])) {
            const c = nextLiveCookie()
            if (!c) {
              sendLog(`🏁 Hết cookie Gmail sống — dừng luồng ${w + 1} (${deadCookies.size}/${gmailCookies.length} cookie đã loại)`)
              break
            }
            workerCookie[w] = c
            sendLog(`📧 Luồng ${w + 1} giữ cookie Gmail riêng — còn ${gmailCookies.length - deadCookies.size}/${gmailCookies.length} cookie sống`)
          }
          v2GmailCookie = workerCookie[w]
        }

        // Proxy rẻ hay chết tạm thời (ERR_TIMED_OUT vài giây sau khi qua pre-check):
        // thử tối đa 3 proxy khác nhau cho cùng 1 tài khoản trước khi tính là lỗi
        const maxTries = apiProxyLines.length ? 3 : Math.min(3, aliveProxies.length || 1)
        let res = null
        let regPick = null   // 28-10: proxy cuối cùng đã dùng (gắn vào kết quả + VietSeeding)
        for (let attempt = 0; attempt < maxTries; attempt++) {
          let pick = null
          // Ưu tiên link API: mỗi lần thử tự gọi lấy 1 proxy mới cho nick này
          if (apiProxyLines.length && mode !== 'ldplayer') {
            const apiUrl = apiProxyLines[apiOffset % apiProxyLines.length]
            apiOffset++
            pick = await acquireApiProxy(apiUrl, i, attempt)
          }
          // Không có API hoặc API hụt: xoay vòng proxy tĩnh đã pre-check
          if (!pick && aliveProxies.length) {
            pick = aliveProxies[proxyOffset % aliveProxies.length]
            const pickNum = (proxyOffset % aliveProxies.length) + 1
            proxyOffset++
            const g = pick.geo
            const geoTxt = g && g.country && g.country !== 'N/A' ? ` [${flagOf(g.countryCode)} ${g.country}]` : ''
            sendLog(`🌍 Tài khoản ${i}/${count} dùng Proxy #${pickNum}: ${pick.display}${geoTxt} (IP ra: ${pick.ip})${attempt > 0 ? ` (thử lại lần ${attempt + 1})` : ''}`)
          }
          if (!pick && mode !== 'ldplayer' && (apiProxyLines.length || parsedProxies.length)) {
            if (attempt + 1 < maxTries) {
              // API fail tạm thời (cooldown/proxy chết vài chục giây): chờ thử lại thay vì bỏ nick ngay
              sendLog(`⚠ Chưa lấy được proxy cho tài khoản ${i} - chờ 20s rồi thử lại (lần ${attempt + 2}/${maxTries})...`)
              await new Promise(r => setTimeout(r, 20000))
              continue
            }
            sendLog(`❌ Không lấy được proxy nào cho tài khoản ${i} - bỏ nick này, KHÔNG reg bằng IP máy thật!`)
            res = { success: false, status: 'ERROR', error: 'Không lấy được proxy từ API/danh sách' }
            break
          }
          let wdTimer = null
          const runNick = engine.registerSingleAccount({
            mode,
            domain,
            emailProvider: mode === 'tempmail' ? emailProvider : 'tempmailapi',
            smsOperator: mode === 'sms' ? smsOperator : null,
            showBrowser: regShowBrowserNow,
            proxy: pick ? pick.rules : null,
            proxyAuth: pick ? (pick.auth || null) : null,
            proxyGeo: pick ? (pick.geo || null) : null,
            slot: w,
            regVia,
            gmailVariant,
            // v2: cookie theo LUỒNG (workerCookie đã xoay khi cookie chết) — bug 24-10:
            // trước đây truyền gmailCookies[i-1] nên cookie bị đánh dấu chết vẫn bị dùng lại
            gmailCookie: v2GmailCookie || gmailCookies[i - 1] || '',
            onLog: sendLog
          })
          if (mode === 'ldplayer') {
            res = await runNick
          } else {
            // Chrome trắng trang/renderer treo -> luồng reg có thể treo vĩnh viễn.
            // Watchdog: quá 12 phút = hủy phiên, đóng Chrome, tính softFail để mở Chrome mới cho nick này
            try {
              res = await Promise.race([
                runNick,
                new Promise(resolve => {
                  wdTimer = setTimeout(() => {
                    sendLog(`⏱ Tài khoản ${i}: Chrome treo/trắng trang quá 12 phút - đóng Chrome này, mở Chrome mới...`)
                    try { engine.abort() } catch {}
                    resolve({ success: false, status: 'ERROR', softFail: true, error: 'Chrome treo quá 12 phút (trắng trang/không phản hồi)' })
                  }, 12 * 60 * 1000)
                })
              ])
            } catch (engErr) {
              // Bug 24-10: engine văng exception làm worker chết IM LẶNG (15:28:38 -
              // proxy nối xong rồi tắt thومة) — bắt lại, log rõ, tính softFail mở Chrome mới
              sendLog(`❌ Engine reg văng lỗi: ${engErr.message} - mở Chrome mới cho nick này`)
              res = { success: false, status: 'ERROR', softFail: true, error: 'Engine văng lỗi: ' + engErr.message }
            }
            if (wdTimer) { clearTimeout(wdTimer); wdTimer = null }
            // Engine cũ đã bị abort (đừng để worker cầm engine chết) - thay engine mới cho nick sau
            if (String(res.error || '').indexOf('treo quá 12 phút') !== -1) {
              try { engines[w] = new FBRegisterEngine({ realChrome: useRealChrome, gmailAccounts }); engine = engines[w] } catch {}
            }
          }
          if (res.proxyFail && pick) {
            // Proxy API chết giữa chừng: gỡ khỏi lastGood để nick sau xoay IP mới
            for (const [u, v] of apiProxyLastGood) { if (v.proxy === pick) apiProxyLastGood.delete(u) }
          }
          if (!res.proxyFail && aliveProxies.includes(pick)) pick.fails = 0
          const maxRetry = res.softFail ? Math.max(maxTries, 3) : maxTries
          if (res.proxyFail && attempt + 1 < maxRetry && (apiProxyLines.length || aliveProxies.length > 1)) {
            if (aliveProxies.includes(pick)) {
              pick.fails = (pick.fails || 0) + 1
              if (pick.fails >= 2) {
                aliveProxies.splice(aliveProxies.indexOf(pick), 1)
                sendLog(`🗑 Bỏ Proxy ${pick.display} khỏi vòng xoay (hỏng ${pick.fails} lần khi tải Facebook)`)
              }
            }
            sendLog(`🔄 Proxy không tải được Facebook - thử proxy khác cho tài khoản ${i} (lần ${attempt + 2}/${maxRetry})...`)
            continue
          }
          // Lỗi do trang (tên/pass đỏ, trắng trang, kẹt form) - không phải lỗi proxy:
          // vẫn đóng Chrome này mở Chrome mới (email/tên mới) kể cả khi chỉ có 1 proxy hay IP nhà
          if (res.softFail && attempt + 1 < maxRetry) {
            sendLog(`🔄 Lỗi phiên này (trang lỗi/ô đỏ) - đóng Chrome, mở Chrome mới cho tài khoản ${i} (lần ${attempt + 2}/${maxRetry})...`)
            continue
          }
          regPick = pick
          break
        }

        // 27-10: gắn proxy đã reg vào kết quả (cột Proxy bảng v2 + gửi kèm VietSeeding)
        res.proxy = regPick ? (regPick.display || regPick.rules || '') : 'IP nhà'
        // 28-10: chuỗi proxy ĐẦY ĐỦ (kèm user:pass) để gửi seeding — bên đó dùng được ngay
        res.proxyFull = regPick
          ? (regPick.auth ? `${regPick.auth.host}:${regPick.auth.port}:${regPick.auth.user}:${regPick.auth.pass}` : (regPick.rules || regPick.display || ''))
          : 'IP nhà'
        res.sedding = ''

        results.push(res)
        sendResult(res)

        // 28-10: via LIVE đã dùng proxy tĩnh -> XÓA proxy đó khỏi danh sách xoay
        // (mỗi proxy chỉ đi với 1 via, không tái sử dụng cho nick sau)
        if (res.status === 'LIVE' && regPick && aliveProxies.length) {
          const usedIdx = aliveProxies.findIndex(p => p.rules === regPick.rules)
          if (usedIdx > -1) {
            aliveProxies.splice(usedIdx, 1)
            sendLog(`🗑 Proxy ${regPick.display} đã dùng cho via ${res.uid} — xóa khỏi danh sách xoay`)
          }
        }

        // ── v2: FB reg ra CHECKPOINT (hoặc cookie Gmail chết) -> LOẠI cookie Gmail đó
        // khỏi vòng xoay, luồng tự lấy cookie kế tiếp còn sống cho nick sau
        if (variant === 'v2' && workerCookie[w]) {
          const errText = String((res && res.error) || '')
          if ((res && res.status === 'CHECKPOINT') || errText.includes('Cookie Gmail chết')) {
            deadCookies.add(workerCookie[w])
            sendLog(`🗑 Cookie Gmail của luồng ${w + 1} bị LOẠI (nick reg ra checkpoint / cookie chết) — còn ${gmailCookies.length - deadCookies.size} cookie sống, luồng chuyển sang cookie khác`)
            workerCookie[w] = null
          }
        }

        // Nếu Live thì tự động ghi vào file live_reg_accounts.txt
        // Format: [LIVE] uid|email|password|2FA|cookie — cột 2FA đứng sau password
        // đúng format extractAccountMeta() đọc lại (check/auth lấy OTP từ key khi login lại)
        if (res.status === 'LIVE') {
          try {
            const twoFa = String(res.twoFaKey || (res.contactFlow && res.contactFlow.twoFaKey) || '').replace(/[\s-]/g, '')
            const liveLine = `[LIVE] ${res.uid || res.email}|${res.email || ''}|${res.password}|${twoFa}|${res.cookieStr}\n`
            const savePath = path.join(app.getPath('desktop'), 'FB_LIVE_REG.txt')
            fs.appendFileSync(savePath, liveLine, 'utf8')
            sendLog(`💾 Đã tự động lưu nick Live vào: ${savePath}${twoFa ? ' (2FA: ' + twoFa + ')' : ' (chưa bật được 2FA)'}`)
          } catch (fe) {
            sendLog(`⚠️ Không ghi được file Desktop: ${fe.message}`)
          }
          // 27-10: gửi VIA LIVE sang VietSeeding (kèm proxy đầy đủ) + tự gửi bù VIA pending cũ.
          // Trạng thái gửi (PASS/DEAD) đẩy về UI cập nhật cột Seeding theo uid
          sendViaToVietSeeding(res, sendLog, res.proxyFull).then((st) => {
            res.sedding = st || 'DEAD'
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(ch + ':sedding', { uid: res.uid, st: res.sedding })
            }
          }).catch(() => {
            res.sedding = 'DEAD'
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(ch + ':sedding', { uid: res.uid, st: 'DEAD' })
            }
          })
          retryPendingVietSeeding(sendLog).catch(() => {})
          // 28-10: VIA reg ra LIVE -> TỰ ĐỘNG xếp qua menu THÊM AVATAR (chạy nền)
          enqueueAutoAvatar(res, sendLog)
          // 28-10: VIA LIVE -> TỰ ĐỘNG đẩy sang NUÔI FB (kèm proxy riêng đã reg)
          enqueueAutoNuoi({
            uid: res.uid, email: res.email || '', pass: res.password || '',
            twofa: String(res.twoFaKey || (res.contactFlow && res.contactFlow.twoFaKey) || '').replace(/[\s-]/g, ''),
            cookie: res.cookieStr || res.cookie || '',
            proxyRules: regPick ? (regPick.rules || '') : '',
            proxyDisplay: res.proxy || ''
          }, sendLog)
        }

        if (nextAccount <= count && isRegRunning && !engine.isAborted) {
          sendLog(`⏳ [Luồng ${w + 1}] Nghỉ 5 giây trước khi reg tài khoản tiếp theo...`)
          await new Promise(r => setTimeout(r, 5000))
        }
      }
    }

    await Promise.all(engines.map((_, w) => worker(w)))

    isRegRunning = false
    activeRegEngines = []
    sendLog(continuous ? '⏹ Đã dừng chế độ Reg liên tục!' : '🏁 Hoàn tất phiên đăng ký!')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ch + ':done', { total: count, results })
    }
  })()

  return { success: true }
})

ipcMain.handle('reg:stop', async () => {
  isRegRunning = false
  for (const eng of activeRegEngines) {
    try { eng.abort() } catch {}
  }
  activeRegEngines = []
  return { success: true }
})

ipcMain.handle('reg:toggleShowBrowser', async (event, show) => {
  regShowBrowserNow = !!show
  let changed = 0
  for (const eng of activeRegEngines) {
    try { if (eng && typeof eng.setShowBrowser === 'function') changed += eng.setShowBrowser(!!show) || 0 } catch {}
  }
  return { success: true, changed }
})

ipcMain.handle('reg:exportLive', async (event, accounts) => {
  const liveAccs = (accounts || []).filter(a => a.status === 'LIVE')
  if (liveAccs.length === 0) return { error: 'Không có tài khoản Live nào để xuất' }

  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất danh sách Nick Live',
    defaultPath: `FB_REG_LIVE_${Date.now()}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })
  if (r.canceled) return { canceled: true }

  // Format mới: uid|email|password|status|name|phone
  const content = liveAccs.map(a => 
    `${a.uid || a.email}|${a.email || ''}|${a.password || ''}|${a.status || ''}|${a.name || ''}|${a.phone || ''}`
  ).join('\n')
  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    shell.showItemInFolder(r.filePath)
    return { success: true, count: liveAccs.length, path: r.filePath }
  } catch (err) {
    return { error: err.message }
  }
})

// 25-10: xuất nick CHECKPOINT của Auto Reg — kèm 2FA + lý do để xử lý lại sau
ipcMain.handle('reg:exportCkpt', async (event, accounts) => {
  const ckptAccs = (accounts || []).filter(a => a && a.status === 'CHECKPOINT')
  if (ckptAccs.length === 0) return { error: 'Không có nick Checkpoint nào để xuất' }

  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất danh sách Nick Checkpoint',
    defaultPath: `FB_REG_CKPT_${Date.now()}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })
  if (r.canceled) return { canceled: true }

  // [CKPT] uid|email|password|2FA|lý do|cookie — prefix [..] parser tự strip, cookie cuối dòng
  const content = ckptAccs.map(a =>
    `[CKPT] ${(a.uid || '') || a.email || ''}|${a.email || ''}|${a.password || ''}|${String(a.twoFaKey || (a.contactFlow && a.contactFlow.twoFaKey) || '').replace(/[\s-]/g, '')}|${String(a.error || 'checkpoint').replace(/\|/g, '/').substring(0, 100)}|${a.cookieStr || a.cookie || ''}`
  ).join('\n')
  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    shell.showItemInFolder(r.filePath)
    return { success: true, count: ckptAccs.length, path: r.filePath }
  } catch (err) {
    return { error: err.message }
  }
})

// ==================== ACCOUNT BM ====================
const { FBBMEngine } = require('./fbbm')
const { FBAdAccEngine } = require('./fbadacc')
const { FBInviteEngine } = require('./fbinvite')
let isBMRunning  = false
let activeBMEngines = []

function sendBMLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bm:log', msg)
  }
}

ipcMain.handle('bm:start', async (event, opts) => {
  if (isBMRunning) return { error: 'Đang có tiến trình BM đang chạy!' }

  const { bmName, bmEmail, concurrency = 2, perCookie = 1, proxy, showBrowser, cookies } = opts
  if (!cookies || !cookies.length) return { error: 'Không có cookie nào để chạy' }

  isBMRunning = true
  activeBMEngines = []

  ;(async () => {
    const queue = [...cookies]
    let running = 0
    let finished = 0

    async function runOne(cookieEntry) {
      running++
      // Notify UI: cookie này đang chạy
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bm:running', { cookie: cookieEntry.cookie })
      }

      for (let bmIdx = 0; bmIdx < perCookie; bmIdx++) {
        if (!isBMRunning) break

        const engine = new FBBMEngine({
          cookie:      cookieEntry.cookie,
          bmName:      `${bmName}${perCookie > 1 ? ` ${bmIdx + 1}` : ''}`,
          email:       bmEmail,
          proxy:       proxy || null,
          showBrowser: showBrowser !== false,
          onLog:       (msg) => sendBMLog(`[${cookieEntry.uid || 'cookie'}] ${msg}`)
        })
        activeBMEngines.push(engine)

        sendBMLog(`🚀 Bắt đầu tạo BM ${bmIdx + 1}/${perCookie} cho cookie: ${cookieEntry.uid || cookieEntry.cookie.substring(0, 30)}...`)

        const result = await engine.createBM()

        // Map status về success/failed/error
        let uiStatus = 'error'
        if (result.status === 'SUCCESS')    uiStatus = 'success'
        else if (result.status === 'ABORTED') uiStatus = 'failed'
        else if (result.status === 'DEAD' || result.status === 'CHECKPOINT') uiStatus = 'failed'
        else if (result.status === 'FAILED') uiStatus = 'failed'

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('bm:result', {
            cookie:   cookieEntry.cookie,
            status:   uiStatus,
            bmId:     result.bmId || null,
            reason:   result.reason || '',
            bmName:   result.bmName,
          })
        }

        // Ghi tự động vào file nếu thành công
        if (uiStatus === 'success') {
          try {
            const line = `[BM OK] UID:${cookieEntry.uid || ''} | BM:${result.bmName} | ID:${result.bmId || ''} | Email:${bmEmail}\n`
            const savePath = path.join(app.getPath('desktop'), 'FB_BM_RESULTS.txt')
            fs.appendFileSync(savePath, line, 'utf8')
            sendBMLog(`💾 Đã lưu kết quả BM vào: ${savePath}`)
          } catch {}
        }

        // Xóa engine khỏi mảng
        const eIdx = activeBMEngines.indexOf(engine)
        if (eIdx > -1) activeBMEngines.splice(eIdx, 1)
      }

      running--
      finished++

      // Chạy cookie tiếp theo nếu có
      if (isBMRunning && queue.length > 0) {
        const next = queue.shift()
        await runOne(next)
      }
    }

    // Khởi chạy concurrency luồng
    const initBatch = queue.splice(0, concurrency)
    await Promise.all(initBatch.map(c => runOne(c)))

    isBMRunning = false
    sendBMLog(`✅ Hoàn tất! Đã xử lý ${finished} cookie.`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bm:done', { finished })
    }
  })()

  return { success: true }
})

ipcMain.handle('bm:stop', async () => {
  isBMRunning = false
  bmScanAbort = true
  activeBMEngines.forEach(e => { try { e.abort() } catch {} })
  activeBMEngines = []
  sendBMLog('⏹ Đã dừng tất cả tiến trình tạo BM')
  return { success: true }
})

// ── TẠO AD ACCOUNT TRONG BM (menu con tab Account BM) ──
ipcMain.handle('bmacc:start', async (event, opts) => {
  if (isBMRunning) return { error: 'Đang có tiến trình BM đang chạy!' }

  const { businessId, accName, timezone, currency, concurrency = 2, proxy, showBrowser, cookies } = opts
  if (!businessId || !/^\d{10,20}$/.test(String(businessId))) return { error: 'Business ID (BM) không hợp lệ!' }
  if (!cookies || !cookies.length) return { error: 'Không có cookie nào để chạy' }

  isBMRunning = true
  activeBMEngines = []

  ;(async () => {
    const queue = [...cookies]
    let finished = 0

    async function runOne(cookieEntry) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bm:running', { cookie: cookieEntry.cookie })
      }

      const engine = new FBAdAccEngine({
        cookie:      cookieEntry.cookie,
        businessId,
        accName,
        timezone,
        currency,
        proxy:       proxy || null,
        showBrowser: showBrowser !== false,
        onLog:       (msg) => sendBMLog(`[${cookieEntry.uid || 'cookie'}] ${msg}`)
      })
      activeBMEngines.push(engine)

      sendBMLog(`🚀 Tạo ad account trong BM ${businessId} cho cookie: ${cookieEntry.uid || cookieEntry.cookie.substring(0, 30)}...`)

      const result = await engine.createAdAccount()

      let uiStatus = 'error'
      if (result.status === 'SUCCESS')    uiStatus = 'success'
      else if (result.status === 'ABORTED') uiStatus = 'failed'
      else if (result.status === 'DEAD' || result.status === 'CHECKPOINT') uiStatus = 'failed'
      else if (result.status === 'FAILED') uiStatus = 'failed'

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bm:result', {
          cookie:   cookieEntry.cookie,
          status:   uiStatus,
          bmId:     businessId,
          reason:   result.reason || '',
          bmName:   result.accName,
        })
      }

      if (uiStatus === 'success') {
        try {
          const line = `[ADACC OK] UID:${cookieEntry.uid || ''} | BM:${businessId} | ACC:${result.accName || accName}\n`
          const savePath = path.join(app.getPath('desktop'), 'FB_BM_RESULTS.txt')
          fs.appendFileSync(savePath, line, 'utf8')
          sendBMLog(`💾 Đã lưu kết quả vào: ${savePath}`)
        } catch {}
      }

      const eIdx = activeBMEngines.indexOf(engine)
      if (eIdx > -1) activeBMEngines.splice(eIdx, 1)

      finished++
      if (isBMRunning && queue.length > 0) {
        const next = queue.shift()
        await runOne(next)
      }
    }

    const initBatch = queue.splice(0, Math.max(1, concurrency))
    await Promise.all(initBatch.map(c => runOne(c)))

    isBMRunning = false
    sendBMLog(`✅ Hoàn tất! Đã xử lý ${finished} cookie.`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bm:done', { finished })
    }
  })()

  return { success: true }
})

// ── QUÉT BM: dò BM ID của từng cookie (chỉ xem, không tạo gì) ──
let bmScanAbort = false
ipcMain.handle('bm:scan', async (event, opts) => {
  if (isBMRunning) return { error: 'Đang có tiến trình BM đang chạy!' }
  const { concurrency = 2, showBrowser, cookies } = opts
  if (!cookies || !cookies.length) return { error: 'Không có cookie nào để quét BM' }

  isBMRunning = true
  bmScanAbort = false

  const parseCookies = (raw) => String(raw || '').split(';').map(p => p.trim()).filter(Boolean).map(pair => {
    const i = pair.indexOf('=')
    return { name: i > -1 ? pair.substring(0, i).trim() : pair.trim(), value: i > -1 ? pair.substring(i + 1).trim() : '' }
  }).filter(c => c.name)

  ;(async () => {
    const queue = [...cookies]
    let finished = 0

    async function scanOne(cookieEntry) {
      let win = null
      let bmId = null
      let reason = ''
      try {
        const pid = 'bmscan' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
        const accSess = session.fromPartition('persist:' + pid)
        const pairs = parseCookies(cookieEntry.cookie)
        for (const c of pairs) {
          for (const url of ['https://www.facebook.com', 'https://business.facebook.com']) {
            await accSess.cookies.set({ url, name: c.name, value: c.value, domain: '.facebook.com', path: '/', secure: true, httpOnly: false, sameSite: 'no_restriction', expirationDate: Math.floor(Date.now() / 1000) + 86400 * 365 }).catch(() => {})
          }
        }
        await accSess.cookies.flushStore()

        win = new BrowserWindow({ width: 1100, height: 800, show: showBrowser !== false, webPreferences: { session: accSess, nodeIntegration: false, contextIsolation: false } })
        const wc = win.webContents
        const loadP = win.loadURL('https://business.facebook.com/')
        loadP.catch(() => {})
        await Promise.race([loadP, sleep(20000)])

        for (let i = 0; i < 25 && !bmId && !bmScanAbort; i++) {
          await sleep(1000)
          const u = wc.getURL()
          if (/\/login|loginpage|\/checkpoint\//.test(u)) { reason = 'Cookie hết hạn / checkpoint'; break }
          const m = u.match(/business_id=(\d{10,20})/)
          if (m) { bmId = m[1]; break }
        }
        if (!bmId && !reason) reason = bmScanAbort ? 'Đã dừng' : 'Cookie chưa có BM nào'
      } catch (err) {
        reason = 'Lỗi quét: ' + err.message
      } finally {
        try { if (win && !win.isDestroyed()) win.destroy() } catch {}
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bm:scanResult', {
          cookie: cookieEntry.cookie,
          uid: cookieEntry.uid || '',
          bmId,
          reason
        })
      }
      sendBMLog(bmId ? `🔍 [${cookieEntry.uid || 'cookie'}] BM ID: ${bmId}` : `🔍 [${cookieEntry.uid || 'cookie'}] ${reason}`)

      finished++
      if (!bmScanAbort && isBMRunning && queue.length > 0) {
        await scanOne(queue.shift())
      }
    }

    const initBatch = queue.splice(0, Math.max(1, concurrency))
    await Promise.all(initBatch.map(c => scanOne(c)))

    isBMRunning = false
    sendBMLog(`✅ Quét BM hoàn tất: ${finished} cookie.`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bm:scanDone', { finished })
    }
  })()

  return { success: true }
})

// ── TẠO LINK MỜI VÀO BM (Invite people + lấy link từ email tạm) ──
ipcMain.handle('bminvite:start', async (event, opts) => {
  if (isBMRunning) return { error: 'Đang có tiến trình BM đang chạy!' }

  const { concurrency = 2, showBrowser, cookies } = opts
  if (!cookies || !cookies.length) return { error: 'Không có cookie/BM nào để tạo link mời' }

  isBMRunning = true
  activeBMEngines = []

  const inviteResults = []

  ;(async () => {
    const queue = [...cookies]
    let finished = 0

    async function runOne(cookieEntry) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bm:running', { cookie: cookieEntry.cookie })
      }

      const engine = new FBInviteEngine({
        cookie:      cookieEntry.cookie,
        businessId:  cookieEntry.bmId,
        proxy:       null,
        showBrowser: showBrowser !== false,
        onLog:       (msg) => sendBMLog(`[${cookieEntry.uid || 'cookie'}] ${msg}`)
      })
      activeBMEngines.push(engine)

      sendBMLog(`🔗 Tạo link mời ${cookieEntry.bmId ? 'vào BM ' + cookieEntry.bmId : '(tự tìm BM theo cookie)'} cho cookie: ${cookieEntry.uid || cookieEntry.cookie.substring(0, 30)}...`)

      const result = await engine.createInviteLink()
      const usedBmId = result.businessId || cookieEntry.bmId || null

      let uiStatus = 'error'
      if (result.status === 'SUCCESS') uiStatus = 'success'
      else if (result.status) uiStatus = 'failed'

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bminvite:result', {
          cookie:     cookieEntry.cookie,
          uid:        cookieEntry.uid || '',
          status:     uiStatus,
          bmId:       usedBmId,
          email:      result.email || '',
          inviteLink: result.inviteLink || null,
          reason:     result.reason || ''
        })
      }

      if (uiStatus === 'success') {
        inviteResults.push({ bmId: usedBmId, uid: cookieEntry.uid || '', email: result.email, inviteLink: result.inviteLink })
        try {
          const line = `UID:${cookieEntry.uid || ''} | BM:${usedBmId || ''} | LINK:${result.inviteLink}\n`
          const savePath = path.join(app.getPath('desktop'), 'FB_BM_RESULTS.txt')
          fs.appendFileSync(savePath, line, 'utf8')
          sendBMLog(`💾 Đã lưu link mời vào: ${savePath}`)
        } catch {}
      } else {
        sendBMLog(`❌ [${cookieEntry.uid || 'cookie'}] ${result.reason || 'Thất bại'}`)
      }

      const eIdx = activeBMEngines.indexOf(engine)
      if (eIdx > -1) activeBMEngines.splice(eIdx, 1)

      finished++
      if (isBMRunning && queue.length > 0) {
        const next = queue.shift()
        await runOne(next)
      }
    }

    const initBatch = queue.splice(0, Math.max(1, concurrency))
    await Promise.all(initBatch.map(c => runOne(c)))

    isBMRunning = false
    sendBMLog(`✅ Hoàn tất! Đã xử lý ${finished} cookie.`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bminvite:done', { finished, results: inviteResults })
    }
  })()

  return { success: true }
})

// ── EXPORT KẾT QUẢ LINK MỜI ──
ipcMain.handle('bminvite:export', async (event, results) => {
  if (!results || !results.length) return { error: 'Không có link mời để xuất' }

  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất link mời BM',
    defaultPath: `FB_BM_INVITE_${Date.now()}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })
  if (r.canceled) return { canceled: true }

  const content = results.map(item =>
    `UID:${item.uid || ''} | BM:${item.bmId || ''} | LINK:${item.inviteLink || ''}`
  ).join('\n')

  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    shell.showItemInFolder(r.filePath)
    return { success: true, count: results.length, path: r.filePath }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('bm:exportResults', async (event, results) => {
  if (!results || !results.length) return { error: 'Không có kết quả để xuất' }

  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất kết quả BM',
    defaultPath: `FB_BM_${Date.now()}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })
  if (r.canceled) return { canceled: true }

  const content = results.map(item =>
    `[BM OK] UID:${item.uid || ''} | Name:${item.name || ''} | BM_ID:${item.bmId || ''} | Cookie:${item.cookie ? item.cookie.substring(0, 60) : ''}...`
  ).join('\n')

  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    shell.showItemInFolder(r.filePath)
    return { success: true, count: results.length, path: r.filePath }
  } catch (err) {
    return { error: err.message }
  }
})

// ==================== REG TIKTOK ====================
const { TikTokEngine } = require('./tiktok')
let isTikTokRunning = false
let activeTTEngines = []

function sendTTLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tiktok:log', msg)
  }
}

ipcMain.handle('tiktok:start', async (event, opts) => {
  if (isTikTokRunning) return { error: 'Đang có tiến trình REG TIKTOK chạy!' }

  const { showBrowser, proxy, cookies } = opts
  if (!cookies || !cookies.length) return { error: 'Không có cookie nào để chạy' }

  isTikTokRunning = true
  activeTTEngines = []
  const results = []

  ;(async () => {
    for (let i = 0; i < cookies.length; i++) {
      if (!isTikTokRunning) break
      const entry = cookies[i]
      sendTTLog(`── [${i + 1}/${cookies.length}] Cookie ${entry.uid || 'không rõ UID'} ──`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tiktok:running', { cookie: entry.cookie })
      }

      const eng = new TikTokEngine({
        cookie:      entry.cookie,
        showBrowser: showBrowser !== false,
        proxy:       proxy || '',
        slot:        i,
        onLog:       (m) => sendTTLog(m)
      })
      activeTTEngines.push(eng)

      let res
      try { res = await eng.run() } catch (err) { res = { success: false, reason: err && err.message } }
      const eIdx = activeTTEngines.indexOf(eng)
      if (eIdx > -1) activeTTEngines.splice(eIdx, 1)

      const result = {
        cookie:   entry.cookie,
        uid:      res.uid || entry.uid || '',
        fbName:   res.fbName || '',
        status:   res.success ? 'success' : 'failed',
        reason:   res.reason || '',
        ttCookie: res.ttCookie || ''
      }
      results.push(result)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tiktok:result', result)
      }

      if (res.success) {
        try {
          const line = `[TT OK] UID:${result.uid} | COOKIE:${result.ttCookie}\n`
          const savePath = path.join(app.getPath('desktop'), 'TIKTOK_RESULTS.txt')
          fs.appendFileSync(savePath, line, 'utf8')
          sendTTLog(`💾 Đã lưu vào: ${savePath}`)
        } catch {}
      } else {
        sendTTLog(`❌ [${result.uid || 'cookie'}] ${result.reason || 'Thất bại'}`)
      }
      await new Promise(r => setTimeout(r, 2000))
    }

    isTikTokRunning = false
    activeTTEngines = []
    const ok = results.filter(r => r.status === 'success').length
    sendTTLog(`🏁 Hoàn tất! ${ok}/${results.length} cookie đăng nhập TikTok thành công.`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tiktok:done', { finished: results.length, results })
    }
  })()

  return { success: true }
})

ipcMain.handle('tiktok:stop', async () => {
  isTikTokRunning = false
  for (const eng of activeTTEngines) {
    try { eng.abort() } catch {}
  }
  activeTTEngines = []
  return { success: true }
})

ipcMain.handle('tiktok:export', async (event, results) => {
  const okRows = (results || []).filter(r => r.ttCookie)
  if (!okRows.length) return { error: 'Không có cookie TikTok nào để xuất' }

  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất cookie TikTok',
    defaultPath: `TIKTOK_COOKIES_${Date.now()}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })
  if (r.canceled) return { canceled: true }

  const content = okRows.map(item => `${item.uid || ''}|${item.ttCookie}`).join('\n')
  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    shell.showItemInFolder(r.filePath)
    return { success: true, count: okRows.length, path: r.filePath }
  } catch (err) {
    return { error: err.message }
  }
})

// ==================== NUÔI FB (port từ AUTO_BM) ====================
let isNuoiRunning = false
let activeNuoiEngines = []

// ── Hàng chờ NUÔI TỰ ĐỘNG: reg LIVE đẩy sang, mỗi via kèm proxy RIÊNG đã reg (28-10) ──
const NUOI_QUEUE_FILE = path.join(__dirname, 'nuoi_queue.json')
let nuoiQueue = []
let nuoiAutoRunning = false
try { nuoiQueue = JSON.parse(fs.readFileSync(NUOI_QUEUE_FILE, 'utf8')) || [] } catch {}
function saveNuoiQueue() {
  try { fs.writeFileSync(NUOI_QUEUE_FILE, JSON.stringify(nuoiQueue), 'utf8') } catch {}
}
function notifyNuoiQueue() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fbnuoi:queue', nuoiQueue)
  }
}
function enqueueAutoNuoi(acc, sendLog) {
  if (!acc || !acc.uid || !acc.cookie) return
  if (nuoiQueue.some(q => q.uid === acc.uid)) { sendLog(`ℹ VIA ${acc.uid} đã có trong hàng chờ nuôi — bỏ qua`); return }
  nuoiQueue.push({
    uid: acc.uid, email: acc.email || '', pass: acc.pass || '', twofa: acc.twofa || '',
    cookie: acc.cookie, proxyRules: acc.proxyRules || '', proxyDisplay: acc.proxyDisplay || '',
    status: 'CHỜ', note: '', addedAt: Date.now()
  })
  saveNuoiQueue(); notifyNuoiQueue()
  sendLog(`🌱 VIA LIVE ${acc.uid} đã đẩy sang NUÔI FB (kèm proxy riêng) — xem hàng chờ ở menu NUÔI FB`)
}
async function runNuoiAutoQueue() {
  if (nuoiAutoRunning) return
  nuoiAutoRunning = true
  try {
    while (true) {
      if (isNuoiRunning) { await new Promise(r => setTimeout(r, 30000)); continue }
      const item = nuoiQueue.find(q => q.status === 'CHỜ')
      if (!item) break
      item.status = 'ĐANG NUÔI'; item.note = ''
      saveNuoiQueue(); notifyNuoiQueue()
      sendNuoiLog(`🌱 [TỰ ĐỘNG từ reg] Nuôi VIA ${item.uid}${item.proxyDisplay ? ' — proxy riêng: ' + item.proxyDisplay : ' — IP nhà'}`)
      // proxy riêng của via: tĩnh thì parse đăng ký auth; dạng khác dùng nguyên chuỗi
      let rules = String(item.proxyRules || '').trim()
      if (rules) {
        const pl = parseProxyLine(rules)
        if (pl && pl.auth) proxyCredentials.set(`${pl.auth.host}:${pl.auth.port}`, { user: pl.auth.user, pass: pl.auth.pass })
      }
      const eng = new FBNuoiEngine({
        proxy: rules, showBrowser: true, slot: 4, minutes: 15,
        onLog: sendNuoiLog
      })
      activeNuoiEngines.push(eng)
      isNuoiRunning = true
      let res = null
      try { res = await eng.run({ uid: item.uid, email: item.email, pass: item.pass, twofa: item.twofa, cookie: item.cookie }) }
      catch (e) { res = { success: false, status: 'ERROR', uid: item.uid, error: e && e.message } }
      const eIdx = activeNuoiEngines.indexOf(eng)
      if (eIdx > -1) activeNuoiEngines.splice(eIdx, 1)
      isNuoiRunning = false
      item.status = (res && res.status) || 'ERROR'
      item.note = (res && (res.note || res.error)) || ''
      if (res && res.cookie) item.cookie = res.cookie
      saveNuoiQueue()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fbnuoi:queue', nuoiQueue)
        mainWindow.webContents.send('fbnuoi:result', {
          uid: item.uid, status: item.status, note: item.note, like: (res && res.stats && res.stats.like) || 0,
          friend: (res && res.stats && res.stats.friend) || 0, group: (res && res.stats && res.stats.group) || 0,
          cookie: item.cookie, pass: item.pass, twofa: item.twofa, proxy: item.proxyDisplay, live: !!(res && res.success)
        })
      }
      sendNuoiLog(`🏁 [tự động] VIA ${item.uid} → ${item.status}${item.note ? ' - ' + item.note : ''}`)
      await new Promise(r => setTimeout(r, 5000))
    }
  } finally { nuoiAutoRunning = false }
}

ipcMain.handle('fbnuoi:queueGet', () => nuoiQueue)
ipcMain.handle('fbnuoi:queueRemove', (event, uid) => {
  nuoiQueue = nuoiQueue.filter(q => q.uid !== uid)
  saveNuoiQueue(); notifyNuoiQueue()
  return { success: true }
})
ipcMain.handle('fbnuoi:queueClear', (event, filterStatus) => {
  if (filterStatus) nuoiQueue = nuoiQueue.filter(q => q.status !== filterStatus)
  else nuoiQueue = []
  saveNuoiQueue(); notifyNuoiQueue()
  return { success: true }
})
ipcMain.handle('fbnuoi:queueStart', () => { runNuoiAutoQueue().catch(() => {}); return { success: true } })

function sendNuoiLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fbnuoi:log', msg)
  }
}

ipcMain.handle('fbnuoi:start', async (event, opts) => {
  if (isNuoiRunning) return { error: 'Đang có tiến trình Nuôi FB chạy!' }
  const { entries = [], proxyText = '', concurrency = 1, minutes = 15, showBrowser = true } = opts || {}
  const accounts = (Array.isArray(entries) ? entries : [])
    .map(e => (e ? parseAccountLine(e.raw || '') || parseAccountLine(e.cookie || '') : null))
    .filter(Boolean)
  if (!accounts.length) {
    return { error: 'Chưa nạp cookie nào hợp lệ — nạp bằng menu bên trái (Chọn thư mục / file / Dán cookie trực tiếp)' }
  }

  // Proxy: link API (mỗi nick tự lấy) + proxy tĩnh (pre-check như Auto Reg)
  const rawProxyLines = String(proxyText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const apiProxyLines = rawProxyLines.filter(l => /^https?:\/\/[^/]+\/\S/.test(l))
  const parsedProxies = rawProxyLines.filter(l => !/^https?:\/\/[^/]+\/\S/.test(l)).map(parseProxyLine).filter(Boolean)
  if (rawProxyLines.length && !apiProxyLines.length && !parsedProxies.length) {
    return { error: 'Dòng proxy không đọc được (định dạng lạ).' }
  }

  isNuoiRunning = true
  sendNuoiLog(`🌱 Bắt đầu nuôi ${accounts.length} tài khoản | ${concurrency} Chrome song song | ~${minutes} phút/nick | Browser: ${showBrowser ? 'Hiện' : 'Ẩn'}`)

  ;(async () => {
    let aliveProxies = []
    if (parsedProxies.length) {
      sendNuoiLog(`🌐 Kiểm tra ${parsedProxies.length} proxy tĩnh (tải IP + thử Facebook, tối đa 25s)...`)
      for (const p of parsedProxies) {
        if (p.auth) proxyCredentials.set(`${p.auth.host}:${p.auth.port}`, { user: p.auth.user, pass: p.auth.pass })
      }
      const checks = await Promise.all(parsedProxies.map(p => checkProxy(p)))
      aliveProxies = parsedProxies.filter((p, i) => checks[i])
      sendNuoiLog(`✓ ${aliveProxies.length}/${parsedProxies.length} proxy sống`)
    }

    const results = []
    let nextIdx = 0
    let staticOffset = 0
    let apiOffset = 0
    // TMProxy 1 key = 1 proxy: các nick/luồng dùng chung proxy tốt gần nhất,
    // chỉ gọi get-new-proxy khi proxy cũ đã chết
    const lastApiGood = new Map()

    const acquireProxy = async () => {
      if (apiProxyLines.length) {
        for (let t = 0; t < 3; t++) {
          const apiUrl = apiProxyLines[apiOffset % apiProxyLines.length]
          const cached = lastApiGood.get(apiUrl)
          if (cached && Date.now() - cached.okAt < 10 * 60 * 1000) return cached.proxy
          const fetched = await fetchProxyFromApi(apiUrl)
          if (fetched) {
            if (fetched.auth) proxyCredentials.set(`${fetched.auth.host}:${fetched.auth.port}`, { user: fetched.auth.user, pass: fetched.auth.pass })
            const chk = await checkProxy(fetched)
            if (chk) {
              lastApiGood.set(apiUrl, { proxy: fetched, okAt: Date.now() })
              return fetched
            }
            sendNuoiLog(`   ✗ Proxy API ${fetched.display} chết/chặn Facebook - thử lại (${t + 2}/3)`)
            lastApiGood.delete(apiUrl)
          } else {
            sendNuoiLog(`   ✗ Link API không trả được proxy - thử lại (${t + 2}/3)`)
          }
          await new Promise(r => setTimeout(r, 5000))
        }
        return null
      }
      if (aliveProxies.length) {
        const p = aliveProxies[staticOffset % aliveProxies.length]
        staticOffset++
        return p
      }
      return null
    }

    const worker = async (w) => {
      while (isNuoiRunning) {
        const i = nextIdx++
        if (i >= accounts.length) break
        const acc = accounts[i]
        sendNuoiLog(`── [${i + 1}/${accounts.length}] UID ${acc.uid || '(cookie trần)'} ──`)
        let res = null
        let pick = null
        for (let pTry = 0; pTry < 2; pTry++) {
          pick = await acquireProxy()
          if (!pick && (apiProxyLines.length || aliveProxies.length)) {
            sendNuoiLog(`❌ Không lấy được proxy cho ${acc.uid || 'cookie này'} - bỏ nick, KHÔNG nuôi bằng IP máy thật`)
            res = { success: false, status: 'ERROR', uid: acc.uid, error: 'Không lấy được proxy' }
            break
          }
          if (pick) {
            const g = pick.geo
            const geoTxt = g && g.country && g.country !== 'N/A' ? ` [${flagOf(g.countryCode)} ${g.country}]` : ''
            sendNuoiLog(`🌍 Dùng Proxy: ${pick.display} (IP ra: ${pick.ip})${geoTxt}`)
          } else {
            sendNuoiLog('⚠ Chưa dán proxy - chạy bằng IP nhà (nuôi cẩn thận checkpoint)')
          }
          const eng = new FBNuoiEngine({
            proxy: pick ? pick.rules : '',
            showBrowser, slot: w, minutes,
            onLog: sendNuoiLog
          })
          activeNuoiEngines.push(eng)
          try { res = await eng.run(acc) } catch (e) { res = { success: false, status: 'ERROR', uid: acc.uid, error: e && e.message } }
          const eIdx = activeNuoiEngines.indexOf(eng)
          if (eIdx > -1) activeNuoiEngines.splice(eIdx, 1)
          if (res && res.proxyFail) {
            for (const [u, v] of lastApiGood) { if (v.proxy === pick) lastApiGood.delete(u) }
          }
          if (res && res.proxyFail && pTry === 0 && (apiProxyLines.length || aliveProxies.length > 1)) {
            sendNuoiLog(`🔄 Proxy không tải được Facebook - thử proxy khác cho ${acc.uid || 'cookie này'}...`)
            if (pick && aliveProxies.includes(pick)) {
              pick.fails = (pick.fails || 0) + 1
              if (pick.fails >= 2) {
                aliveProxies.splice(aliveProxies.indexOf(pick), 1)
                sendNuoiLog(`🗑 Bỏ Proxy ${pick.display} khỏi vòng xoay (hỏng 2 lần)`)
              }
            }
            continue
          }
          break
        }
        const row = {
          uid: (res && res.uid) || acc.uid || '',
          status: (res && res.status) || 'ERROR',
          note: (res && res.error) || '',
          like: (res && res.stats && res.stats.like) || 0,
          friend: (res && res.stats && res.stats.friend) || 0,
          group: (res && res.stats && res.stats.group) || 0,
          cookie: (res && res.cookie) || acc.cookie || '',
          pass: acc.pass || '',
          twofa: acc.twofa || '',
          // 27-10: gắn proxy đã dùng vào VIA (xem được cột proxy + xuất kèm file)
          proxy: pick ? (pick.display || pick.rules || '') : '',
          live: !!(res && res.success)
        }
        if (row.proxy && row.live) row.note = (row.note ? row.note + ' | ' : '') + `proxy: ${row.proxy}`
        results.push(row)
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fbnuoi:result', row)
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    const nWorkers = Math.max(parseInt(concurrency, 10) || 1, 1)
    await Promise.all(Array.from({ length: nWorkers }, (_, w) => worker(w)))
    isNuoiRunning = false
    activeNuoiEngines = []
    const live = results.filter(r => r.live).length
    sendNuoiLog(`🏁 Hoàn tất nuôi: ${live}/${results.length} nick LIVE.`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fbnuoi:done', { finished: results.length, live })
    }
  })()

  return { success: true, total: accounts.length }
})

ipcMain.handle('fbnuoi:stop', async () => {
  isNuoiRunning = false
  for (const eng of activeNuoiEngines) { try { eng.abort() } catch {} }
  activeNuoiEngines = []
  return { success: true }
})

ipcMain.handle('fbnuoi:export', async (event, rows) => {
  const liveRows = (rows || []).filter(r => r.live && r.cookie)
  if (!liveRows.length) return { error: 'Không có nick Live nào để xuất' }
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất nick Nuôi FB Live',
    defaultPath: `NUOI_FB_LIVE_${Date.now()}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })
  if (r.canceled) return { canceled: true }
  const content = liveRows.map(x => `${x.uid || ''}|${x.pass || ''}|${x.twofa || ''}|${x.cookie}${x.proxy ? '|' + x.proxy : ''}`).join('\n')
  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    shell.showItemInFolder(r.filePath)
    return { success: true, count: liveRows.length, path: r.filePath }
  } catch (err) {
    return { error: err.message }
  }
})

// ==================== THÊM THÔNG TIN PROFILE (avatar + current city + home town) ====================
const { FBProfileEngine } = require('./fbprofile.js')
let isProfileRunning = false
let activeProfileEngines = []

// ── Hàng chờ TỰ ĐỘNG thêm Avatar cho VIA LIVE do reg đẩy sang (28-10) ──
// Chạy nền tuần tự: mở Chrome, dán/đăng ảnh như menu THÊM AVATAR, SOLVED thì xóa
// ảnh đã dùng. Batch avatar tay đang chạy thì chờ xong mới chạy tiếp.
let avatarAutoQueue = []
let avatarAutoRunning = false
function enqueueAutoAvatar(res, sendLog) {
  if (!res || res.status !== 'LIVE') return
  const acc = {
    uid: res.uid || '', email: res.email || '', pass: res.password || '',
    twofa: String(res.twoFaKey || (res.contactFlow && res.contactFlow.twoFaKey) || '').replace(/[\s-]/g, ''),
    cookie: res.cookieStr || res.cookie || ''
  }
  if (!String(acc.cookie).includes('c_user=')) return
  if (!profilePhotoDir) {
    sendLog(`ℹ VIA ${acc.uid} LIVE nhưng chưa chọn thư mục ảnh ở menu THÊM AVATAR — bỏ qua tự thêm avatar`)
    return
  }
  avatarAutoQueue.push(acc)
  sendLog(`🖼 VIA LIVE ${acc.uid} đã xếp vào hàng chờ TỰ ĐỘNG thêm Avatar (theo dõi ở menu THÊM AVATAR)`)
  runAvatarAutoQueue().catch(() => {})
}
async function runAvatarAutoQueue() {
  if (avatarAutoRunning) return
  avatarAutoRunning = true
  try {
    while (avatarAutoQueue.length) {
      if (isProfileRunning) { await new Promise(r => setTimeout(r, 30000)); continue }
      const acc = avatarAutoQueue.shift()
      // ảnh: lấy ảnh ĐẦU TIÊN theo thứ tự tên (ảnh đã dùng bị xóa sau SOLVED nên không lặp)
      let myPhoto = ''
      try {
        const files = fs.readdirSync(profilePhotoDir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort()
        if (files.length) myPhoto = path.join(profilePhotoDir, files[0])
      } catch {}
      if (!myPhoto) {
        sendProfileLog(`⚠ Hết ảnh trong thư mục — VIA ${acc.uid} chưa thêm được avatar (nạp thêm ảnh rồi reg nick mới)`)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fbprofile:accountResult', { uid: acc.uid, status: 'ERROR', note: 'Hết ảnh trong thư mục ảnh', email: acc.email, cookie: acc.cookie })
        }
        continue
      }
      sendProfileLog(`🖼 [TỰ ĐỘNG từ reg] VIA ${acc.uid} — thêm avatar bằng ảnh ${path.basename(myPhoto)}`)
      const eng = new FBProfileEngine({
        proxy: '', showBrowser: true, slot: 3,
        photoPath: myPhoto, photoDir: '',
        onLog: sendProfileLog
      })
      activeProfileEngines.push(eng)
      let r = null
      try { r = await eng.run(acc) } catch (e) { r = { success: false, status: 'ERROR', uid: acc.uid, error: e && e.message } }
      const eIdx = activeProfileEngines.indexOf(eng)
      if (eIdx > -1) activeProfileEngines.splice(eIdx, 1)
      if (r && r.status === 'SOLVED') {
        try { fs.unlinkSync(myPhoto); sendProfileLog(`🗑 Đã xóa ảnh đã dùng: ${path.basename(myPhoto)}`) } catch {}
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fbprofile:accountResult', {
          uid: acc.uid || '', status: (r && r.status) || 'ERROR',
          note: (((r && (r.note || r.error)) || '') + ' (tự động từ reg)').trim(),
          email: acc.email || '', cookie: (r && r.cookie) || acc.cookie || ''
        })
      }
      sendProfileLog(`🏁 [tự động] VIA ${acc.uid} → ${(r && r.status) || 'ERROR'}`)
      await new Promise(rr => setTimeout(rr, 3000))
    }
  } finally { avatarAutoRunning = false }
}

function sendProfileLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fbprofile:log', msg)
  }
}

// 28-10: LƯU VĨNH VIỄN thư mục ảnh (trước đây reset mỗi lần mở app -> tự thêm avatar
// bị bỏ qua âm thầm sau khi restart). Load ngay khi khởi động + lưu mỗi lần chọn.
const AVATAR_DIR_FILE = path.join(__dirname, 'avatar_photodir.json')
let profilePhotoDir = ''
try { profilePhotoDir = (JSON.parse(fs.readFileSync(AVATAR_DIR_FILE, 'utf8')) || {}).dir || '' } catch {}

ipcMain.handle('fbprofile:pickPhotoDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn thư mục ảnh đại diện (jpg/png — engine chọn random 1 ảnh/nick)',
    defaultPath: profilePhotoDir || undefined,
    properties: ['openDirectory']
  })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
  profilePhotoDir = r.filePaths[0]
  try { fs.writeFileSync(AVATAR_DIR_FILE, JSON.stringify({ dir: profilePhotoDir }), 'utf8') } catch {}
  let count = 0
  try { count = fs.readdirSync(profilePhotoDir).filter(f => /\.(jpe?g|png)$/i.test(f)).length } catch {}
  return { path: profilePhotoDir, count }
})

ipcMain.handle('fbprofile:start', async (event, opts) => {
  if (isProfileRunning) return { error: 'Đang có tiến trình Thêm Profile chạy!' }
  const { entries = [], proxyText = '', concurrency = 1, showBrowser = true, photoDir = '' } = opts || {}
  const accounts = (Array.isArray(entries) ? entries : [])
    .map(e => (e ? parseAccountLine(e.raw || '') || parseAccountLine(e.cookie || '') : null))
    .filter(Boolean)
  if (!accounts.length) {
    return { error: 'Chưa nạp cookie nào hợp lệ — nạp bằng menu bên trái (dòng uid|email|pass|2FA|cookie)' }
  }
  isProfileRunning = true
  activeProfileEngines = []
  if (photoDir) profilePhotoDir = photoDir
  const numWorkers = Math.max(parseInt(concurrency, 10) || 1, 1)
  let taskIdx = 0

  // 28-10: hàng đợi ảnh — mỗi VIA lấy 1 ảnh RIÊNG theo thứ tự (hết cảnh đa luồng
  // chọn trùng ảnh), via nào xong thì XÓA ảnh đó khỏi thư mục
  let photoQueue = []
  if (profilePhotoDir) {
    try {
      photoQueue = fs.readdirSync(profilePhotoDir)
        .filter(f => /\.(jpe?g|png)$/i.test(f))
        .sort()
        .map(f => path.join(profilePhotoDir, f))
    } catch {}
  }
  let photoIdx = 0
  sendProfileLog(`🖼 Hàng đợi ảnh: ${photoQueue.length} ảnh — mỗi VIA lấy 1 ảnh theo thứ tự, làm xong xóa ảnh`)

  // Proxy: parse danh sách như menu Giải Checkpoint (API TMProxy hoặc IP tĩnh)
  const rawProxyLines = String(proxyText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const apiProxyLines = rawProxyLines.filter(l => /^https?:\/\//i.test(l))
  const staticProxyLines = rawProxyLines.filter(l => !/^https?:\/\//i.test(l))
  const aliveProxies = staticProxyLines.map(p => ({ rules: p, display: p, fails: 0 }))
  let apiIdx = 0
  const acquireProxy = async () => {
    if (apiProxyLines.length) {
      const apiUrl = apiProxyLines[apiIdx % apiProxyLines.length]
      try {
        const fetched = await fetchProxyFromApi(apiUrl, (m) => sendProfileLog(m))
        if (fetched && fetched.proxy) {
          sendProfileLog(`🌍 Proxy API: ${fetched.display}${fetched.geo ? ` [${flagOf(fetched.geo.countryCode || '')}]` : ''}`)
          return fetched
        }
      } catch {}
      apiIdx++
      return null
    }
    if (aliveProxies.length) {
      const pick = aliveProxies[Math.floor(Math.random() * aliveProxies.length)]
      return { proxy: pick.rules, display: pick.display, rules: pick.rules }
    }
    return null
  }

  sendProfileLog(`🚀 Bắt đầu thêm Avatar cho ${accounts.length} nick (${numWorkers} luồng)...`)

  ;(async () => {
    const worker = async (w) => {
      while (taskIdx < accounts.length && isProfileRunning) {
        const i = taskIdx++
        const acc = accounts[i]
        sendProfileLog(`── [${i + 1}/${accounts.length}] UID ${acc.uid || '(cookie trần)'} ──`)
        // 28-10: mỗi VIA lấy 1 ảnh RIÊNG từ hàng đợi (theo thứ tự) — hết ảnh thì bỏ nick
        let myPhoto = null
        if (photoQueue.length) {
          if (photoIdx >= photoQueue.length) {
            sendProfileLog(`⚠ Hết ảnh trong thư mục (${photoQueue.length} ảnh đã dùng) — bỏ nick ${acc.uid || '?'}`)
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('fbprofile:accountResult', { uid: acc.uid || '', status: 'ERROR', note: 'Hết ảnh trong thư mục ảnh', email: acc.email || '', cookie: acc.cookie || '' })
            }
            continue
          }
          myPhoto = photoQueue[photoIdx++]
          sendProfileLog(`🖼 VIA này dùng ảnh: ${path.basename(myPhoto)} (còn ${photoQueue.length - photoIdx} ảnh)`)
        }
        const pick = await acquireProxy()
        if (!pick && (apiProxyLines.length || aliveProxies.length)) {
          // 28-10: đăng bài avatar chạy IP nhà được — không bỏ nick nữa
          sendProfileLog(`⚠ Không lấy được proxy cho ${acc.uid || 'cookie này'} (key API chết/hết hạn?) — chạy bằng IP nhà`)
        }
        const eng = new FBProfileEngine({
          proxy: pick ? (pick.rules || pick.proxy || '') : '',
          showBrowser, slot: w,
          photoDir: myPhoto ? '' : (profilePhotoDir || ''),
          photoPath: myPhoto || '',
          onLog: sendProfileLog
        })
        activeProfileEngines.push(eng)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fbprofile:running', { uid: acc.uid || '' })
        }
        let res = null
        try { res = await eng.run(acc) } catch (e) { res = { success: false, status: 'ERROR', uid: acc.uid, error: e && e.message } }
        const eIdx = activeProfileEngines.indexOf(eng)
        if (eIdx > -1) activeProfileEngines.splice(eIdx, 1)
        // 28-10: via làm XONG (SOLVED) -> XÓA LUÔN ảnh đã dùng khỏi thư mục
        if (myPhoto && res && res.status === 'SOLVED') {
          try {
            fs.unlinkSync(myPhoto)
            sendProfileLog(`🗑 Đã xóa ảnh đã dùng: ${path.basename(myPhoto)}`)
          } catch (delErr) {
            sendProfileLog(`⚠ Không xóa được ảnh ${path.basename(myPhoto)}: ${delErr.message}`)
          }
        }
        const row = {
          uid: (res && res.uid) || acc.uid || '',
          status: (res && res.status) || 'ERROR',
          note: (res && (res.note || res.error)) || '',
          email: acc.email || '',
          cookie: (res && res.cookie) || acc.cookie || ''
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fbprofile:accountResult', row)
        }
        sendProfileLog(`🏁 [${row.uid || '?'}] Kết quả: ${row.status}${row.note ? ' - ' + row.note : ''}`)
      }
    }
    await Promise.all(Array.from({ length: numWorkers }, (_, w) => worker(w)))
    isProfileRunning = false
    activeProfileEngines = []
    sendProfileLog('🏁 Hoàn tất phiên Thêm Avatar!')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fbprofile:done', {})
    }
  })()

  return { success: true }
})

ipcMain.handle('fbprofile:stop', async () => {
  isProfileRunning = false
  for (const eng of activeProfileEngines) { try { eng.abort() } catch {} }
  activeProfileEngines = []
  return { success: true }
})

// ==================== THÊM THÔNG TIN PROFILE (hết) ====================

// ==================== GIẢI CHECKPOINT (nạp cookie -> mở theo luồng -> tự giải) ====================
// ==================== VIETSEEDING: tự gửi VIA LIVE sang hệ thống seeding ====================
// Reg ra LIVE -> POST JSON sang api.vietseeding.com (202 = đã vào hàng đợi nuôi).
// Config lưu vietseeding_config.json cạnh app { enabled, baseUrl, apiKey } — đổi key /
// tắt gửi không cần sửa code. Gọi fire-and-forget: KHÔNG chặn luồng reg khi API chậm.
const VIETSEEDING_CONFIG_FILE = path.join(__dirname, 'vietseeding_config.json')
try {
  if (!fs.existsSync(VIETSEEDING_CONFIG_FILE)) {
    fs.writeFileSync(VIETSEEDING_CONFIG_FILE, JSON.stringify({
      enabled: true,
      baseUrl: 'https://api.vietseeding.com',
      apiKey: 'vsk_vcJ_-r_qCEs383PuxZmFapkHtpQOuYYogJ-aStM9pww',
      _ghiChu: 'Tự gửi VIA LIVE sang VietSeeding sau khi reg. enabled:false = tắt gửi. Đổi apiKey tại đây.'
    }, null, 2), 'utf8')
  }
} catch {}
async function sendViaToVietSeeding(res, sendLog, proxyStr) {
  let cfg = null
  try { cfg = JSON.parse(fs.readFileSync(VIETSEEDING_CONFIG_FILE, 'utf8')) } catch {}
  if (!cfg || cfg.enabled === false || !cfg.apiKey) return
  const uid = String((res && res.uid) || '').trim()
  const cookie = String((res && (res.cookieStr || res.cookie)) || '').trim()
  if (!uid || !cookie) return
  const twoFa = String((res && (res.twoFaKey || (res.contactFlow && res.contactFlow.twoFaKey))) || '').replace(/[\s-]/g, '')
  // 30-10 (doc mới mục 3.1): JSON object đơn KHÔNG nhận trường proxy (bị invalid) —
  // cách đúng: gộp 1 request { accounts: [via], proxies: [proxy] } — seeding kiểm tra
  // proxy sống, nạp pool của khách và cấp cho via trong request (summary.batch_proxies)
  const viaObj = {
    status: 'LIVE',
    uid,
    email: String((res && res.email) || ''),
    password: String((res && res.password) || ''),
    two_factor_secret: twoFa,
    cookie
  }
  const proxyLine = String(proxyStr || (res && res.proxyFull) || '').trim()
  const body = proxyLine && proxyLine !== 'IP nhà'
    ? { accounts: [viaObj], proxies: [proxyLine] }
    : { accounts: [viaObj] }
  const base = cfg.baseUrl || 'https://api.vietseeding.com'
  const doSend = (idemKey) => fetch(`${base}/api/webhooks/v1/facebook-accounts`, {
    method: 'POST',
    headers: { 'X-API-Key': cfg.apiKey, 'Idempotency-Key': idemKey, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  })
  // 28-10: audit ra file riêng (log console dễ bị trôi) + retry 3 lần + hàng đợi pending
  const AUDIT_FILE = path.join(__dirname, 'vietseeding_send.log')
  const PENDING_FILE = path.join(__dirname, 'vietseeding_pending.json')
  const audit = (m) => {
    try { fs.appendFileSync(AUDIT_FILE, `[${new Date().toLocaleString('vi-VN', { hour12: false })}] ${m}\n`, 'utf8') } catch {}
  }
  const queuePending = () => {
    try {
      let arr = []
      try { arr = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) || [] } catch {}
      arr.push(body)
      fs.writeFileSync(PENDING_FILE, JSON.stringify(arr), 'utf8')
      audit(`ĐỆM: uid ${uid} vào hàng chờ (tổng ${arr.length})`)
    } catch {}
  }
  let sent = false
  const idemKey = `via-${Date.now()}-${uid}`
  let lastNote = ''
  for (let t = 1; t <= 3 && !sent; t++) {
    try {
      audit(`GỬI lần ${t}/3 uid ${uid}`)
      let r = await doSend(idemKey)
      if (r.status >= 500) { await new Promise(rs => setTimeout(rs, 6000)); r = await doSend(idemKey) }
      const j = await r.json().catch(() => ({}))
      if (r.status === 202 || r.status === 200) {
        const s = (j && j.summary) || {}
        const bp = (j && (j.batch_proxies || s.batch_proxies)) || null
        if ((s.accepted || 0) >= 1) {
          sent = true
          audit('KẾT: PASS — ' + JSON.stringify(s).substring(0, 100) + (bp ? ' | batch_proxies: ' + JSON.stringify(bp).substring(0, 140) : ''))
          const chuaProxy = s.waiting_proxy || 0
          const bpTxt = bp ? ` | proxy nạp: ${bp.accepted || 0} sống/${bp.received || 0}${(bp.dead || 0) ? ` (DEAD: ${bp.dead} — ${JSON.stringify(j.batch_proxy_dead || []).substring(0, 80)})` : ''}` : ''
          const msg = `🌱 VietSeeding: VIA ${uid} đã gửi — batch ${(j.batch_id || '?').substring(0, 18)}… | nhận vào: ${s.accepted || 0} (kèm proxy: ${s.with_proxy || 0}${chuaProxy ? `, chờ proxy: ${chuaProxy}` : ''})${bpTxt}, trùng: ${s.duplicate || 0}, sai: ${s.invalid || 0}`
          sendLog(msg); audit(msg)
        } else {
          audit('LỖI line invalid — ' + JSON.stringify((j.items || []).slice(0, 2)).substring(0, 220))
          sendLog(`⚠️ VietSeeding: VIA ${uid} bị đánh INVALID — ${JSON.stringify((j.items || []).slice(0, 1)).substring(0, 220)}`)
          break
        }
      } else if (r.status === 401) {
        lastNote = 'API key sai/hết hạn'
        audit('LỖI 401 key sai'); sendLog('❌ VietSeeding: API key sai/hết hạn — sửa vietseeding_config.json (cạnh app)'); break
      } else {
        lastNote = 'HTTP ' + r.status
        audit(`LỖI HTTP ${r.status} — ${JSON.stringify(j).substring(0, 120)}`)
        sendLog(`⚠️ VietSeeding: HTTP ${r.status} — ${JSON.stringify(j).substring(0, 160)}`)
      }
    } catch (e) {
      lastNote = 'lỗi mạng: ' + e.message
      audit(`LỖI mạng lần ${t}: ${e.message}`)
    }
    if (!sent && t < 3) await new Promise(rs => setTimeout(rs, 8000))
  }
  if (!sent) {
    audit('KẾT: DEAD — ' + lastNote)
    queuePending()
    sendLog(`⚠️ VietSeeding: VIA ${uid} chưa gửi được (${lastNote}) — đã lưu hàng chờ, lần gửi thành công sau sẽ tự bù`)
    audit('KẾT: thất bại — đã đệm pending')
  }
  return sent ? 'PASS' : 'DEAD'
}

// Gửi lại các VIA đang nằm trong hàng đợi pending (gọi sau mỗi lần gửi thành công)
async function retryPendingVietSeeding(sendLog) {
  const PENDING_FILE = path.join(__dirname, 'vietseeding_pending.json')
  try {
    const arr = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) || []
    if (!arr.length) return
    const cfg = (() => { try { return JSON.parse(fs.readFileSync(VIETSEEDING_CONFIG_FILE, 'utf8')) } catch { return null } })()
    if (!cfg || !cfg.apiKey) return
    const conLai = []
    for (const body of arr) {
      try {
        const idemKey = 'via-pending-' + (body.uid || '') + '-' + Date.now()
        const r = await fetch(`${cfg.baseUrl || 'https://api.vietseeding.com'}/api/webhooks/v1/facebook-accounts`, {
          method: 'POST',
          headers: { 'X-API-Key': cfg.apiKey, 'Idempotency-Key': idemKey, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body)
        })
        const j = await r.json().catch(() => ({}))
        const ok = r.status === 202 || r.status === 200
        if (ok && j.summary && j.summary.invalid) { sendLog(`⚠️ VietSeeding: VIA pending ${body.uid} bị từ chối (sai định dạng) — bỏ`); audit(`PENDING bỏ uid ${body.uid}: invalid`) }
        else if (ok) { sendLog(`🌱 VietSeeding: gửi LẠI VIA ${body.uid} thành công (từ hàng chờ)`); audit(`PENDING gửi lại uid ${body.uid} OK`) }
        else conLai.push(body)
      } catch { conLai.push(body) }
      await new Promise(rs => setTimeout(rs, 3000))
    }
    fs.writeFileSync(PENDING_FILE, JSON.stringify(conLai), 'utf8')
    if (conLai.length) sendLog(`⚠️ VietSeeding: còn ${conLai.length} VIA pending chưa gửi được — sẽ thử lại lần sau`)
  } catch {}
}

const { FBCkptEngine, setCkptStopAll, loadAiConfig, getAiUsageSummary } = require('./fbckpt.js')
let isCkptRunning = false
let activeCkptEngines = []

function sendCkptLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fbckpt:log', msg)
  }
}

ipcMain.handle('fbckpt:start', async (event, opts) => {
  if (isCkptRunning) return { error: 'Đang có tiến trình Giải Checkpoint chạy!' }
  setCkptStopAll(false)
  const { entries = [], proxyText = '', concurrency = 1, showBrowser = true, photoDir = '' } = opts || {}
  const accounts = (Array.isArray(entries) ? entries : [])
    .map(e => (e ? parseAccountLine(e.raw || '') || parseAccountLine(e.cookie || '') : null))
    .filter(Boolean)
  if (!accounts.length) {
    return { error: 'Chưa nạp cookie nào hợp lệ — nạp bằng menu bên trái (uid|pass|2FA|cookie có email mới giải được qua OTP)' }
  }

  // Proxy: link API (mỗi nick tự lấy) + proxy tĩnh (pre-check như Nuôi)
  const rawProxyLines = String(proxyText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const apiProxyLines = rawProxyLines.filter(l => /^https?:\/\/[^/]+\/\S/.test(l))
  const parsedProxies = rawProxyLines.filter(l => !/^https?:\/\/[^/]+\/\S/.test(l)).map(parseProxyLine).filter(Boolean)
  if (rawProxyLines.length && !apiProxyLines.length && !parsedProxies.length) {
    return { error: 'Dòng proxy không đọc được (định dạng lạ).' }
  }

  isCkptRunning = true
  sendCkptLog(`🔓 Bắt đầu Giải Checkpoint ${accounts.length} nick | ${concurrency} Chrome song song | Browser: ${showBrowser ? 'Hiện' : 'Ẩn'}`)

  let aliveProxies = []
  if (parsedProxies.length) {
    sendCkptLog(`🌐 Kiểm tra ${parsedProxies.length} proxy tĩnh...`)
    const checks = await Promise.all(parsedProxies.map(p => checkProxy(p)))
    parsedProxies.forEach((p, idx) => {
      const c = checks[idx]
      if (c) {
        p.ip = c.ip; p.geo = c.geo; p.pingMs = c.pingMs
        aliveProxies.push(p)
        sendCkptLog(`   ✓ Proxy #${idx + 1} ${p.display} sống (IP ra: ${c.ip})`)
      } else sendCkptLog(`   ✗ Proxy #${idx + 1} ${p.display} CHẾT - bỏ`)
    })
    for (const p of aliveProxies) {
      if (p.auth) proxyCredentials.set(`${p.auth.host}:${p.auth.port}`, { user: p.auth.user, pass: p.auth.pass })
    }
  }

  ;(async () => {
    const numWorkers = Math.min(Math.max(concurrency, 1), accounts.length)
    let nextIdx = 0
    let staticOffset = 0
    let apiOffset = 0
    const lastApiGood = new Map()

    const acquireProxy = async () => {
      if (apiProxyLines.length) {
        for (let t = 0; t < 3; t++) {
          const apiUrl = apiProxyLines[apiOffset % apiProxyLines.length]
          apiOffset++
          const cached = lastApiGood.get(apiUrl)
          if (cached && Date.now() - cached.okAt < 10 * 60 * 1000) return cached.proxy
          const fetched = await fetchProxyFromApi(apiUrl)
          if (fetched) {
            if (fetched.auth) proxyCredentials.set(`${fetched.auth.host}:${fetched.auth.port}`, { user: fetched.auth.user, pass: fetched.auth.pass })
            const chk = await checkProxy(fetched)
            if (chk) {
              fetched.ip = chk.ip; fetched.geo = chk.geo
              lastApiGood.set(apiUrl, { proxy: fetched, okAt: Date.now() })
              return fetched
            }
            sendCkptLog(`   ✗ Proxy API ${fetched.display} chết - thử lại (${t + 2}/3)`)
          } else {
            sendCkptLog('   ✗ Link API không trả proxy - thử lại...')
          }
          await new Promise(r => setTimeout(r, 5000))
        }
        return null
      }
      if (aliveProxies.length) {
        const p = aliveProxies[staticOffset % aliveProxies.length]
        staticOffset++
        return p
      }
      return null
    }

    const worker = async (w) => {
      while (isCkptRunning) {
        const i = nextIdx++
        if (i >= accounts.length) break
        const acc = accounts[i]
        sendCkptLog(`── [${i + 1}/${accounts.length}] UID ${acc.uid || '(cookie trần)'} ──`)
        let res = null
        let pick = null
        for (let pTry = 0; pTry < 2; pTry++) {
          pick = await acquireProxy()
          if (!pick && (apiProxyLines.length || aliveProxies.length)) {
            sendCkptLog(`❌ Không lấy được proxy cho ${acc.uid || 'cookie này'} - bỏ nick, KHÔNG giải bằng IP máy thật`)
            res = { success: false, status: 'ERROR', uid: acc.uid, error: 'Không lấy được proxy' }
            break
          }
          if (pick) {
            const g = pick.geo
            const geoTxt = g && g.country && g.country !== 'N/A' ? ` [${flagOf(g.countryCode)} ${g.country}]` : ''
            sendCkptLog(`🌍 Dùng Proxy: ${pick.display}${pick.ip ? ' (IP ra: ' + pick.ip + ')' : ''}${geoTxt}`)
          } else {
            sendCkptLog('⚠ Chưa dán proxy - giải bằng IP nhà')
          }
          const eng = new FBCkptEngine({
            proxy: pick ? pick.rules : '',
            showBrowser, slot: w,
            photoDir: photoDir || '',
            onLog: sendCkptLog
          })
          activeCkptEngines.push(eng)
          try { res = await eng.run(acc) } catch (e) { res = { success: false, status: 'ERROR', uid: acc.uid, error: e && e.message } }
          const eIdx = activeCkptEngines.indexOf(eng)
          if (eIdx > -1) activeCkptEngines.splice(eIdx, 1)
          if (res && res.proxyFail && pTry === 0 && (apiProxyLines.length || aliveProxies.length > 1)) {
            sendCkptLog(`🔄 Proxy không tải được Facebook - thử proxy khác cho ${acc.uid || 'cookie này'}...`)
            continue
          }
          break
        }
        const row = {
          uid: (res && res.uid) || acc.uid || '',
          status: (res && res.status) || 'ERROR',
          note: (res && res.error) || '',
          pass: acc.pass || '',
          twofa: acc.twofa || '',
          email: acc.email || '',
          cookie: (res && res.cookie) || acc.cookie || ''
        }
        // Nick đã gửi ảnh xác minh -> hẹn ĐÚNG 2 tiếng sau tự mở check lại
        // (feed = đã giải, còn checkpoint = die) — yêu cầu user 25-10
        if (res && res.status === 'PENDING_REVIEW' && res.recheckAt) {
          scheduleCkptRecheck({
            uid: row.uid, email: row.email, pass: row.pass, twofa: row.twofa,
            cookie: res.cookie || acc.cookie || '', proxy: pick ? pick.rules : ''
          }, res.recheckAt)
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fbckpt:accountResult', row)
        }
        sendCkptLog(`🏁 [${row.uid || '?'}] Kết quả: ${row.status}${row.note ? ' - ' + row.note : ''}`)
      }
    }

    await Promise.all(Array.from({ length: numWorkers }, (_, w) => worker(w)))

    isCkptRunning = false
    activeCkptEngines = []
    sendCkptLog('🏁 Hoàn tất phiên Giải Checkpoint!')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fbckpt:done', {})
    }
  })()

  return { success: true }
})

ipcMain.handle('fbckpt:stop', async () => {
  isCkptRunning = false
  setCkptStopAll(true)   // hủy cả các lần gọi AI captcha đang chờ
  for (const eng of activeCkptEngines) { try { eng.abort() } catch {} }
  activeCkptEngines = []
  return { success: true }
})

// ── Cấu hình AI đọc captcha (captcha_ai.json) + xem usage key/token ──
ipcMain.handle('fbckpt:getAiConfig', () => {
  return loadAiConfig() || {}
})

ipcMain.handle('fbckpt:saveAiConfig', (event, cfg) => {
  try {
    const next = {
      enabled: !!(cfg && cfg.enabled),
      key: String((cfg && cfg.key) || '').trim(),
      model: String((cfg && cfg.model) || '').trim() || 'nvidia/nemotron-3.5-super-vl:free'
    }
    if (!next.key) return { error: 'Chưa nhập API key' }
    fs.writeFileSync(path.join(__dirname, 'captcha_ai.json'), JSON.stringify({
      ...next,
      _ghiChu: 'AI đọc captcha qua OpenRouter. enabled:false -> chỉ dùng tesseract.'
    }, null, 2), 'utf8')
    return { success: true }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('fbckpt:aiUsage', async () => {
  const cfg = loadAiConfig() || {}
  let remote = null
  if (cfg.key) {
    try {
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), 15000)
      const r = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { 'Authorization': `Bearer ${cfg.key}` }, signal: ctrl.signal
      })
      clearTimeout(to)
      const j = await r.json().catch(() => ({}))
      remote = (j && j.data) ? j.data : { error: (j && j.error && j.error.message) || `HTTP ${r.status}` }
    } catch (e) { remote = { error: e.message } }
  }
  return { remote, local: getAiUsageSummary() }
})

// ── Recheck sau 2h: nick đã gửi ảnh xác minh chờ FB duyệt. Đúng giờ hẹn tự mở phiên
// m.facebook check: vào feed = ĐÃ GIẢI, còn checkpoint = die. Danh sách persist ra
// ckpt_rechecks.json để tắt/mở app không mất lịch hẹn ──
const CKPT_RECHECK_FILE = path.join(__dirname, 'ckpt_rechecks.json')
let ckptRechecks = []
try { ckptRechecks = JSON.parse(fs.readFileSync(CKPT_RECHECK_FILE, 'utf8')) || [] } catch { ckptRechecks = [] }
const ckptRecheckTimers = new Map()

function persistCkptRechecks() {
  try { fs.writeFileSync(CKPT_RECHECK_FILE, JSON.stringify(ckptRechecks), 'utf8') } catch {}
}

function sendCkptRecheckResult(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fbckpt:recheckResult', payload)
  }
}

function armCkptRecheck(item, fireAt) {
  const delay = Math.max(1000, fireAt - Date.now())
  const t = setTimeout(async () => {
    ckptRecheckTimers.delete(item.uid)
    sendCkptLog(`⏰ Đến giờ recheck 2h — mở lại ${item.uid || 'nick'} xem FB duyệt chưa...`)
    const eng = new FBCkptEngine({ showBrowser: false, slot: 0, proxy: item.proxy || '', onLog: sendCkptLog })
    let res = null
    try { res = await eng.quickCheck(item) } catch (e) { res = { status: 'ERROR', error: e && e.message } }
    // Vẫn checkpoint nhưng đang ở màn chờ duyệt tiếp (PHOTO_UPLOAD) -> hẹn thêm 2h nữa
    if (res && res.status === 'STILL_CHECKPOINT' && /xem xét|review/i.test(String(res.error || '') + '') === false && res.error === 'Vẫn checkpoint sau thời gian chờ') {
      // giữ trạng thái chờ duyệt thêm 1 vòng nữa (tối đa 2 vòng để không treo vĩnh viễn)
      if (!item.recheckCount) item.recheckCount = 0
      item.recheckCount++
      if (item.recheckCount < 2) {
        sendCkptLog(`⏳ ${item.uid || ''} FB vẫn đang xem xét — hẹn thêm 2 tiếng nữa (vòng ${item.recheckCount}/2)`)
        scheduleCkptRecheck(item, Date.now() + 2 * 60 * 60 * 1000)
        return
      }
    }
    ckptRechecks = ckptRechecks.filter(x => x.uid !== item.uid)
    persistCkptRechecks()
    const st = (res && res.status) || 'ERROR'
    const note = (res && res.error) || (st === 'SOLVED' ? 'FB đã duyệt — nick vào được feed' : 'Vẫn checkpoint sau 2h')
    sendCkptLog(`🔔 Recheck ${item.uid || ''}: ${st === 'SOLVED' ? '✅ ĐÃ GIẢI (vào feed)' : st === 'DIE' ? '❌ DIE' : '⚠ ' + note}`)
    sendCkptRecheckResult({ uid: item.uid, status: st, note, cookie: (res && res.cookie) || item.cookie, email: item.email, pass: item.pass, twofa: item.twofa })
  }, delay)
  ckptRecheckTimers.set(item.uid, t)
}

function scheduleCkptRecheck(acc, fireAt) {
  // 1 uid chỉ giữ 1 lịch hẹn
  const old = ckptRecheckTimers.get(acc.uid)
  if (old) { clearTimeout(old); ckptRecheckTimers.delete(acc.uid) }
  const item = { ...acc, fireAt }
  ckptRechecks = ckptRechecks.filter(x => x.uid !== acc.uid)
  ckptRechecks.push(item)
  persistCkptRechecks()
  const mins = Math.round((fireAt - Date.now()) / 60000)
  sendCkptLog(`⏰ Hẹn recheck ${acc.uid || ''} sau ${mins} phút (${new Date(fireAt).toLocaleTimeString('vi-VN')})`)
  armCkptRecheck(item, fireAt)
}

// Khôi phục lịch hẹn khi mở app (quá giờ thì check ngay sau 30s)
function restoreCkptRechecks() {
  for (const item of ckptRechecks) {
    armCkptRecheck(item, Math.max(item.fireAt || 0, 0))
  }
  if (ckptRechecks.length) {
    console.log(`[Giải Checkpoint] Khôi phục ${ckptRechecks.length} lịch recheck`)
  }
}

ipcMain.handle('fbckpt:pickPhotoFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn thư mục ảnh xác minh (jpg/png — engine sẽ chọn random 1 ảnh/nick)',
    properties: ['openDirectory']
  })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true }
  const dir = r.filePaths[0]
  let count = 0
  try { count = fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f)).length } catch {}
  return { path: dir, count }
})

ipcMain.handle('fbckpt:export', async (event, rows) => {
  const solved = (rows || []).filter(r => (r.status === 'SOLVED' || r.status === 'NO_CKPT') && r.cookie)
  if (!solved.length) return { error: 'Không có nick nào giải được để xuất' }
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất nick đã giải checkpoint',
    defaultPath: `CKPT_SOLVED_${Date.now()}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })
  if (r.canceled) return { canceled: true }
  // uid|email|password|2FA|cookie — cookie mới nhất sau khi giải
  const content = solved.map(x =>
    `${x.uid || ''}|${x.email || ''}|${x.pass || ''}|${String(x.twofa || '').replace(/[\s-]/g, '')}|${x.cookie}`
  ).join('\n')
  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    shell.showItemInFolder(r.filePath)
    return { success: true, count: solved.length, path: r.filePath }
  } catch (err) {
    return { error: err.message }
  }
})

// ==================== AUTHENTICATION (nạp cookie -> đổi thông tin) ====================
// Nạp cookie từ khối IMPORT menu trái -> mở phiên -> thêm email temp + OTP + xóa SĐT cũ (postRegContactFlow)
const { FBAuthEngine } = require('./fbauth.js')
let isAuthRunning = false
let activeAuthEngines = []

function sendAuthLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:log', msg)
  }
}

ipcMain.handle('auth:start', async (event, opts) => {
  if (isAuthRunning) return { error: 'Đang có tiến trình Authentication chạy!' }
  const { entries = [], proxyText = '', concurrency = 1, showBrowser = true, emailProvider = 'tempmailapi' } = opts || {}
  const accounts = (Array.isArray(entries) ? entries : [])
    .map(e => (e ? parseAccountLine(e.raw || '') || parseAccountLine(e.cookie || '') : null))
    .filter(Boolean)
  if (!accounts.length) {
    return { error: 'Chưa nạp cookie nào hợp lệ — nạp bằng menu bên trái (Chọn thư mục / file / Dán cookie trực tiếp)' }
  }

  const rawProxyLines = String(proxyText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const apiProxyLines = rawProxyLines.filter(l => /^https?:\/\/[^/]+\/\S/.test(l))
  const parsedProxies = rawProxyLines.filter(l => !/^https?:\/\/[^/]+\/\S/.test(l)).map(parseProxyLine).filter(Boolean)
  if (rawProxyLines.length && !apiProxyLines.length && !parsedProxies.length) {
    return { error: 'Dòng proxy không đọc được (định dạng lạ).' }
  }

  isAuthRunning = true
  sendAuthLog(`🔑 Authentication: ${accounts.length} tài khoản | ${concurrency} luồng song song | email: ${emailProvider} | Browser: ${showBrowser ? 'Hiện' : 'Ẩn'}`)

  ;(async () => {
    let aliveProxies = []
    if (parsedProxies.length) {
      sendAuthLog(`🌐 Kiểm tra ${parsedProxies.length} proxy tĩnh (tối đa 25s)...`)
      for (const p of parsedProxies) {
        if (p.auth) proxyCredentials.set(`${p.auth.host}:${p.auth.port}`, { user: p.auth.user, pass: p.auth.pass })
      }
      const checks = await Promise.all(parsedProxies.map(p => checkProxy(p)))
      aliveProxies = parsedProxies.filter((p, i) => checks[i])
      sendAuthLog(`✓ ${aliveProxies.length}/${parsedProxies.length} proxy sống`)
    }

    const results = []
    let nextIdx = 0
    let staticOffset = 0
    let apiOffset = 0
    const lastApiGood = new Map()

    const acquireProxy = async () => {
      if (apiProxyLines.length) {
        for (let t = 0; t < 3; t++) {
          const apiUrl = apiProxyLines[apiOffset % apiProxyLines.length]
          const cached = lastApiGood.get(apiUrl)
          if (cached && Date.now() - cached.okAt < 10 * 60 * 1000) return cached.proxy
          const fetched = await fetchProxyFromApi(apiUrl)
          if (fetched) {
            if (fetched.auth) proxyCredentials.set(`${fetched.auth.host}:${fetched.auth.port}`, { user: fetched.auth.user, pass: fetched.auth.pass })
            const chk = await checkProxy(fetched)
            if (chk) {
              lastApiGood.set(apiUrl, { proxy: fetched, okAt: Date.now() })
              return fetched
            }
            sendAuthLog(`   ✗ Proxy API ${fetched.display} chết/chặn Facebook - thử lại (${t + 2}/3)`)
            lastApiGood.delete(apiUrl)
          } else {
            sendAuthLog(`   ✗ Link API không trả được proxy - thử lại (${t + 2}/3)`)
          }
          await new Promise(r => setTimeout(r, 5000))
        }
        return null
      }
      if (aliveProxies.length) {
        const p = aliveProxies[staticOffset % aliveProxies.length]
        staticOffset++
        return p
      }
      return null
    }

    const worker = async (w) => {
      while (isAuthRunning) {
        const i = nextIdx++
        if (i >= accounts.length) break
        const acc = accounts[i]
        sendAuthLog(`── [${i + 1}/${accounts.length}] UID ${acc.uid || '(cookie trần)'} ──`)
        let res = null
        let pick = null
        for (let pTry = 0; pTry < 2; pTry++) {
          pick = await acquireProxy()
          if (!pick && (apiProxyLines.length || aliveProxies.length)) {
            sendAuthLog(`❌ Không lấy được proxy cho ${acc.uid || 'cookie này'} - bỏ nick, KHÔNG chạy bằng IP máy thật`)
            res = { success: false, status: 'ERROR', uid: acc.uid, error: 'Không lấy được proxy' }
            break
          }
          if (pick) {
            const g = pick.geo
            const geoTxt = g && g.country && g.country !== 'N/A' ? ` [${flagOf(g.countryCode)} ${g.country}]` : ''
            sendAuthLog(`🌍 Dùng Proxy: ${pick.display} (IP ra: ${pick.ip})${geoTxt}`)
          } else {
            sendAuthLog('⚠ Chưa dán proxy - chạy bằng IP nhà (cẩn thận checkpoint)')
          }
          const eng = new FBAuthEngine({
            proxy: pick ? pick.rules : '',
            showBrowser, slot: w, emailProvider,
            onLog: sendAuthLog
          })
          activeAuthEngines.push(eng)
          try { res = await eng.run(acc) } catch (e) { res = { success: false, status: 'ERROR', uid: acc.uid, error: e && e.message } }
          const eIdx = activeAuthEngines.indexOf(eng)
          if (eIdx > -1) activeAuthEngines.splice(eIdx, 1)
          if (res && res.proxyFail && pTry === 0 && (apiProxyLines.length || aliveProxies.length > 1)) {
            sendAuthLog(`🔄 Proxy không tải được Facebook - thử proxy khác cho ${acc.uid || 'cookie này'}...`)
            if (pick && aliveProxies.includes(pick)) {
              pick.fails = (pick.fails || 0) + 1
              if (pick.fails >= 2) {
                aliveProxies.splice(aliveProxies.indexOf(pick), 1)
                sendAuthLog(`🗑 Bỏ Proxy ${pick.display} khỏi vòng xoay (hỏng 2 lần)`)
              }
            }
            continue
          }
          break
        }
        const row = {
          uid: (res && res.uid) || acc.uid || '',
          status: (res && res.status) || 'ERROR',
          note: (res && res.error) || ((res && res.newEmail) ? `Email mới: ${res.newEmail}${res.deletedOld ? ' + đã xóa SĐT cũ' : ''}${res.twoFaOk ? ' + 2FA ON' : ' + chưa bật 2FA'}` : ''),
          newEmail: (res && res.newEmail) || '',
          deletedOld: !!(res && res.deletedOld),
          cookie: (res && res.cookie) || acc.cookie || '',
          pass: acc.pass || '',
          twofa: (res && res.twofa) || acc.twofa || '',
          email: acc.email || '',
          emailProvider: (res && res.emailProvider) || emailProvider,
          emailToken: (res && res.emailToken) || '',
          live: !!(res && res.success)
        }
        results.push(row)
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:result', row)
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    const nWorkers = Math.max(parseInt(concurrency, 10) || 1, 1)
    await Promise.all(Array.from({ length: nWorkers }, (_, w) => worker(w)))
    isAuthRunning = false
    activeAuthEngines = []
    const done = results.filter(r => r.live).length
    sendAuthLog(`🏁 Hoàn tất Authentication: ${done}/${results.length} nick đổi thông tin thành công.`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:done', { finished: results.length, changed: done })
    }
  })()

  return { success: true, total: accounts.length }
})

ipcMain.handle('auth:stop', async () => {
  isAuthRunning = false
  for (const eng of activeAuthEngines) { try { eng.abort() } catch {} }
  activeAuthEngines = []
  return { success: true }
})

// ── IMPORTED COOKIES: lưu/nạp cookie đã import (restart app vẫn còn) ──
const IMPORTED_FILE = path.join(__dirname, 'imported_cookies.json')
ipcMain.handle('imported:save', async (event, entries) => {
  try {
    fs.writeFileSync(IMPORTED_FILE, JSON.stringify(entries || []), 'utf8')
    return { success: true }
  } catch (err) { return { error: err.message } }
})
ipcMain.handle('imported:get', async () => {
  try { return JSON.parse(fs.readFileSync(IMPORTED_FILE, 'utf8')) } catch { return [] }
})

ipcMain.handle('regv2:export', async (event, rows) => {
  // Reg v2: xuất nick LIVE — id|email(mới)|password|cookie
  const liveRows = (rows || []).filter(r => r.status === 'LIVE' && (r.cookieStr || r.cookie))
  if (!liveRows.length) return { error: 'Không có nick LIVE nào để xuất' }
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất Nick Live Reg v2 (Gmail)',
    defaultPath: `FB_REGV2_LIVE_${Date.now()}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })
  if (r.canceled) return { canceled: true }
  const content = liveRows.map(x =>
    `${x.uid || ''}|${x.email || ''}|${x.password || ''}|${x.twoFaKey || x.twofa || ''}|${x.cookieStr || x.cookie || ''}`
  ).join('\n')
  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    shell.showItemInFolder(r.filePath)
    return { success: true, count: liveRows.length, path: r.filePath }
  } catch (err) { return { error: err.message } }
})

ipcMain.handle('auth:export', async (event, rows) => {
  const liveRows = (rows || []).filter(r => r.live && r.cookie)
  if (!liveRows.length) return { error: 'Không có nick nào đổi thông tin thành công để xuất' }
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Xuất nick Authentication (đã đổi thông tin)',
    defaultPath: `AUTH_DONE_${Date.now()}.txt`,
    filters: [{ name: 'Text File', extensions: ['txt'] }]
  })
  if (r.canceled) return { canceled: true }
  // Format: id|tk|mk|key 2FA|cookie — giữ key + email để sau còn lấy OTP được
  const content = liveRows.map(x =>
    `${x.uid || ''}|${x.newEmail || x.email || ''}|${x.pass || ''}|${x.twofa || ''}|${x.cookie}`
  ).join('\n')
  // File JSON kèm theo: đủ thông tin hòm thư (provider + token) để gọi lại lấy OTP email sau này
  const jsonPath = r.filePath.replace(/\.[^.]+$/, '') + '.json'
  const jsonRows = liveRows.map(x => ({
    uid: x.uid || '',
    email: x.newEmail || x.email || '',
    password: x.pass || '',
    twofa_key: x.twofa || '',
    cookie: x.cookie,
    email_provider: x.emailProvider || '',
    email_token: x.emailToken || ''
  }))
  try {
    fs.writeFileSync(r.filePath, content, 'utf8')
    try { fs.writeFileSync(jsonPath, JSON.stringify(jsonRows, null, 2), 'utf8') } catch {}
    shell.showItemInFolder(r.filePath)
    return { success: true, count: liveRows.length, path: r.filePath }
  } catch (err) {
    return { error: err.message }
  }
})

// ── TEMP MAIL: đọc hòm thư temp theo email/token — dùng đúng key đã lưu của từng nguồn ──
// Trả về danh sách thư mới nhất + OTP trích xuất sẵn. Auto: thử từng provider đến khi một cái đọc được.
ipcMain.handle('tempmail:fetch', async (event, { input, provider } = {}) => {
  const sid = String(input || '').trim()
  if (!sid) return { error: 'Chưa nhập email / token hòm thư' }
  const order = (provider && provider !== 'auto')
    ? [provider]
    : ['mailown', 'tempmailapi', 'mailtd', 'mailtm', 'tempmailid', 'tempmailg']
  const clients = {
    tempmailapi: () => new TempMailMMO(),
    tempmailv2: () => new (require('./tempmailv2.js'))(),
    mailown: () => new (require('./tempmailown.js'))(),
    mailtd: () => new MailTd(),
    mailtm: () => new MailTm(),
    tempmailid: () => new TempMailId(),
    tempmailg: () => new TempMailG()
  }
  const errors = []
  for (const p of order) {
    const make = clients[p]
    if (!make) continue
    try {
      const c = make()
      const list = await c.getEmailList(sid, 10)
      const emails = []
      for (const m of (list || []).slice(0, 8)) {
        try {
          const d = await c.fetchEmail(sid, m.mail_id)
          const subject = (d && d.mail_subject) || m.mail_subject || ''
          const body = (d && d.mail_body) || ''
          const otp = (c.extractOtp && (c.extractOtp(subject, body, 6) || c.extractOtp(subject, body, 5))) || ''
          emails.push({
            id: m.mail_id, from: m.mail_from || '', subject,
            otp,
            preview: String(body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
          })
        } catch (e) {
          emails.push({ id: m.mail_id, from: m.mail_from || '', subject: m.mail_subject || '', otp: '', preview: '(không đọc được nội dung: ' + e.message + ')' })
        }
      }
      return { success: true, provider: p, count: emails.length, emails }
    } catch (e) { errors.push(`${p}: ${e.message}`) }
  }
  return { error: 'Không đọc được hòm thư — ' + errors.join(' | ') }
})

// ==================== REG PAGE (tạo Page từ cookie) ====================
const { FBPageEngine } = require('./fbpage.js')
let isPageRunning = false
let activePageEngines = []

function sendPageLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('page:log', msg)
  }
}

ipcMain.handle('page:pickNamesFile', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn file tên Page (.txt) — mỗi dòng 1 tên',
    filters: [{ name: 'Text', extensions: ['txt', 'text'] }],
    properties: ['openFile']
  })
  if (r.canceled || !r.filePaths.length) return { canceled: true }
  try {
    const raw = fs.readFileSync(r.filePaths[0], 'utf8')
    const names = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    return { success: true, count: names.length, names }
  } catch (e) { return { error: 'Không đọc được file: ' + e.message } }
})

ipcMain.handle('page:start', async (event, opts) => {
  if (isPageRunning) return { error: 'Đang có tiến trình REG PAGE chạy!' }
  const { entries = [], names = [], manualName = '', concurrency = 1, showBrowser = true, proxyText = '' } = opts || {}
  const accounts = (Array.isArray(entries) ? entries : [])
    .map(e => (e ? parseAccountLine(e.raw || '') || parseAccountLine(e.cookie || '') : null))
    .filter(Boolean)
  if (!accounts.length) {
    return { error: 'Chưa nạp cookie nào hợp lệ — nạp bằng menu bên trái (Chọn thư mục / file / Dán cookie trực tiếp)' }
  }

  // Proxy tĩnh (mỗi dòng 1 proxy) — xoay vòng cho từng nick; không bắt buộc
  const proxyLines = String(proxyText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const staticProxies = proxyLines.filter(l => !/^https?:\/\//.test(l)).map(parseProxyLine).filter(Boolean)
  for (const p of staticProxies) {
    if (p.auth) proxyCredentials.set(`${p.auth.host}:${p.auth.port}`, { user: p.auth.user, pass: p.auth.pass })
  }

  isPageRunning = true
  sendPageLog(`📄 REG PAGE: ${accounts.length} cookie | ${concurrency} luồng | tên: ${names.length ? names.length + ' tên từ file' : (manualName ? 'tên nhập tay' : 'tự sinh')}`)

  ;(async () => {
    const results = []
    let nextIdx = 0
    let staticOffset = 0

    const worker = async (w) => {
      while (isPageRunning) {
        const i = nextIdx++
        if (i >= accounts.length) break
        const acc = accounts[i]
        // Tên page: thứ tự cookie -> tên thứ tự trong file; hết tên -> tên nhập tay; không có -> tự sinh
        const pageName = (names[i] && String(names[i]).trim()) ||
                         (manualName && manualName.trim() ? (manualName.trim() + (accounts.length > 1 ? ` ${i + 1}` : '')) : `Fan Page ${i + 1}`)
        sendPageLog(`── [${i + 1}/${accounts.length}] UID ${acc.uid || '(cookie trần)'} — tên: "${pageName}" ──`)

        const pick = staticProxies.length ? staticProxies[staticOffset++ % staticProxies.length] : null
        if (pick) sendPageLog(`🌍 Dùng Proxy: ${pick.display || `${pick.host}:${pick.port}`}`)
        else sendPageLog('⚠ Chưa dán proxy - chạy bằng IP nhà')

        const eng = new FBPageEngine({
          proxy: pick ? pick.rules : '',
          showBrowser, slot: w,
          onLog: sendPageLog
        })
        activePageEngines.push(eng)
        let res = null
        try { res = await eng.run(acc, pageName) } catch (e) { res = { success: false, status: 'ERROR', uid: acc.uid, pageName, error: e && e.message } }
        const eIdx = activePageEngines.indexOf(eng)
        if (eIdx > -1) activePageEngines.splice(eIdx, 1)

        const row = {
          uid: (res && res.uid) || acc.uid || '',
          status: (res && res.status) || 'ERROR',
          pageName: (res && res.pageName) || pageName,
          pageUrl: (res && res.pageUrl) || '',
          note: (res && res.error) || 'OK',
          live: !!(res && res.success)
        }
        results.push(row)
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('page:result', row)
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    const nWorkers = Math.max(parseInt(concurrency, 10) || 1, 1)
    await Promise.all(Array.from({ length: nWorkers }, (_, w) => worker(w)))
    isPageRunning = false
    activePageEngines = []
    const done = results.filter(r => r.live).length
    sendPageLog(`🏁 Hoàn tất REG PAGE: ${done}/${results.length} page tạo thành công.`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('page:done', { finished: results.length, created: done })
    }
  })()

  return { success: true, total: accounts.length }
})

ipcMain.handle('page:stop', async () => {
  isPageRunning = false
  for (const eng of activePageEngines) { try { eng.abort() } catch {} }
  activePageEngines = []
  return { success: true }
})

// Window controls
ipcMain.on('win:min', () => mainWindow.minimize())
ipcMain.on('win:max', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize())
ipcMain.on('win:close', () => mainWindow.close())

