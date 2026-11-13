// ==========================================
// chrome_cdp.js — Chạy Chrome THẬT (chrome.exe) qua CDP WebSocket thay Electron BrowserWindow
// Port từ AUTO_BM (main.py): launch chrome.exe --remote-debugging-port, điều khiển qua
// WebSocket CDP → navigator.webdriver = false tự nhiên, UA không dính chữ "Electron".
// Cung cấp fake win/webContents/session GIỐNG SHAPE Electron để fbreg.js chạy nguyên flow
// (gõ người thật, DOM-first fill, OTP, phân loại LIVE) không phải sửa gì.
// SAU MỖI LẦN REG: kill Chrome + XÓA sạch profile dir (tránh đầy ổ).
// ==========================================
const { spawn, execSync, execFile } = require('child_process')
const { screen } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const net = require('net')
let WebSocket
try { WebSocket = require('ws') } catch { WebSocket = null }

const PROFILE_ROOT = path.join(os.tmpdir(), 'fbreg_chrome')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Dọn profile cũ sót lại (app chết đột ngột) — chỉ xóa dir già hơn 3 tiếng, tránh đụng phiên đang chạy
function sweepOldProfiles() {
  try {
    if (!fs.existsSync(PROFILE_ROOT)) return
    for (const d of fs.readdirSync(PROFILE_ROOT)) {
      const full = path.join(PROFILE_ROOT, d)
      try {
        const age = Date.now() - fs.statSync(full).mtimeMs
        if (age > 3 * 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true })
      } catch {}
    }
  } catch {}
}
sweepOldProfiles()

// ── Tìm chrome.exe: registry (App Paths) + đường dẫn chuẩn ──
function findChromePath() {
  const candidates = []
  try {
    for (const hive of ['HKLM', 'HKCU']) {
      try {
        const out = execSync(`reg query "${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve`, { encoding: 'utf8', timeout: 4000 })
        const m = String(out).match(/REG_SZ\s+(.+chrome\.exe)/i)
        if (m) candidates.push(m[1].trim())
      } catch {}
    }
  } catch {}
  candidates.push(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  )
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch {}
  }
  return null
}

// ── Tunnel proxy local: Chrome không nhận user:pass trong --proxy-server →
// nghe 127.0.0.1:port, nhận CONNECT từ Chrome, forward lên proxy kèm Proxy-Authorization
class LocalProxyTunnel {
  constructor(auth, log = null) {
    this.auth = auth // { host, port, user, pass }
    this.log = log
    this.server = null
    this.port = null
    this.sockets = new Set()
  }
  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(sock => {
        this.sockets.add(sock)
        sock.on('close', () => this.sockets.delete(sock))
        sock.on('error', () => {})
        let buf = ''
        sock.on('data', chunk => {
          buf += chunk.toString('latin1')
          if (!buf.includes('\r\n\r\n')) return
          const req = buf
          buf = ''
          const m = req.match(/^CONNECT\s+([^\s:]+):(\d+)/i)
          if (!m) { sock.destroy(); return }
          // Kết nối tới PROXY (auth.host:auth.port) — KHÔNG phải đích CONNECT
          const upstream = net.connect(parseInt(this.auth.port, 10), this.auth.host)
          upstream.on('error', () => { try { sock.destroy() } catch {} })
          upstream.once('connect', () => {
            const cred = Buffer.from(`${this.auth.user}:${this.auth.pass}`).toString('base64')
            upstream.write(`CONNECT ${m[1]}:${m[2]} HTTP/1.1\r\nHost: ${m[1]}:${m[2]}\r\nProxy-Authorization: Basic ${cred}\r\n\r\n`)
          })
          let header = ''
          const onData = c => {
            header += c.toString('latin1')
            if (!header.includes('\r\n\r\n')) return
            upstream.removeListener('data', onData)
            const ok = /^HTTP\/1\.[01] 200/i.test(header)
            if (this.log) this.log(`🔗 Tunnel → proxy ${this.auth.host}:${this.auth.port} CONNECT ${m[1]}:${m[2]} → ${String(header).split('\r\n')[0]}`)
            sock.write(ok ? 'HTTP/1.1 200 Connection established\r\n\r\n' : 'HTTP/1.1 502 Bad Gateway\r\n\r\n')
            if (ok) {
              const leftover = header.slice(header.indexOf('\r\n\r\n') + 4)
              if (leftover) sock.write(leftover)
              sock.pipe(upstream)
              upstream.pipe(sock)
            } else {
              sock.destroy(); upstream.destroy()
            }
          }
          upstream.on('data', onData)
        })
      })
      this.server.on('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve(this.port)
      })
    })
  }
  stop() {
    try { for (const s of this.sockets) s.destroy() } catch {}
    try { this.server && this.server.close() } catch {}
  }
}

// ── CDP WebSocket client ──
class CdpBrowser {
  constructor(ws) {
    this.ws = ws
    this.msgId = 1
    this.pending = new Map() // id -> {resolve, reject}
    this.listeners = new Map() // method -> Set(fn)
    ws.on('message', raw => {
      let m
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) p.reject(new Error(m.error.message || 'CDP error'))
        else p.resolve(m.result)
        return
      }
      if (m.method && this.listeners.has(m.method)) {
        for (const fn of this.listeners.get(m.method)) {
          try { fn(m.params, m.sessionId) } catch {}
        }
      }
    })
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(fn)
    return () => this.listeners.get(method)?.delete(fn)
  }
  send(method, params = {}, sessionId = null) {
    const id = this.msgId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== 0 && this.ws.readyState !== 1) {
        reject(new Error('CDP đã đóng'))
        return
      }
      this.pending.set(id, { resolve, reject })
      try { this.ws.send(JSON.stringify(payload)) } catch (e) { this.pending.delete(id); reject(e) }
    })
  }
  close() { try { this.ws.close() } catch {} }
}

async function connectBrowser(port) {
  const wsUrl = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 8000 }, res => {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => {
        try { resolve(JSON.parse(d).webSocketDebuggerUrl) } catch (e) { reject(new Error('Không đọc được /json/version: ' + d.slice(0, 100))) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout /json/version')) })
  })
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return new CdpBrowser(ws)
}

// Virtual key code cho phím đặc biệt (ký tự thường dùng charCode)
function vkcOf(keyCode) {
  const k = String(keyCode || '')
  if (/^[a-z]$/i.test(k)) return k.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0)
  const map = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }
  if (map[k]) return map[k]
  const punct = { '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 48, ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188, '-': 189, '_': 189, '.': 190, '>': 190, '/': 191, '?': 191, '`': 192, '[': 219, '{': 219, '\\': 220, ']': 221, '}': 221, "'": 222, '"': 222 }
  if (punct[k] !== undefined) return punct[k]
  return 0
}

// ── Win32 điều khiển cửa sổ Chrome từ ngoài: CDP chỉ minimize được (minimize vẫn còn
// nút trên taskbar — user complained). ShowWindow(SW_HIDE) ẩn HẲN khỏi taskbar như
// win.hide() của Electron cũ. Chạy powershell async (KHÔNG execSync — sẽ block main thread).
const WIN32_TYPE_CS = [
  'using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;',
  'public class CW {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  public static List<IntPtr> FindByPid(uint target) {',
  '    var r = new List<IntPtr>();',
  '    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == target) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); if (sb.ToString() == "Chrome_WidgetWin_1") r.Add(h); } return true; }, IntPtr.Zero);',
  '    return r;',
  '  }',
  '}',
].join('\n')

const psB64 = script => Buffer.from(script, 'utf16le').toString('base64')

// SW_HIDE=0 ẩn hẳn; SW_RESTORE=9 hiện lại (kèm un-minimize). Trả false nếu không tìm thấy cửa sổ.
async function win32ShowWindow(pid, swCmd) {
  const script = `$ErrorActionPreference = 'Stop'\n$cs = '${WIN32_TYPE_CS}'\nAdd-Type -TypeDefinition $cs\n$ws = [CW]::FindByPid(${pid})\nif ($ws.Count -gt 0) { [void][CW]::ShowWindow($ws[0], ${swCmd}); exit 0 } else { exit 1 }`
  return await new Promise(resolve => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', psB64(script)], { timeout: 15000, windowsHide: true }, err => resolve(!err))
    } catch { resolve(false) }
  })
}

// '1' = đang hiện trên desktop; '0' = SW_HIDE rồi; 'NOWIN' = không có cửa sổ; 'ERR' = lỗi powershell
async function win32WindowVisible(pid) {
  const script = `$ErrorActionPreference = 'Stop'\n$cs = '${WIN32_TYPE_CS}'\nAdd-Type -TypeDefinition $cs\n$ws = [CW]::FindByPid(${pid})\nif ($ws.Count -eq 0) { Write-Output NOWIN } else { Write-Output $([int][CW]::IsWindowVisible($ws[0])) }`
  return await new Promise(resolve => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', psB64(script)], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => resolve(err ? 'ERR' : String(stdout).trim()))
    } catch { resolve('ERR') }
  })
}

// ── Fake Electron objects quanh 1 CDP target ──
async function createRealChromeSession(opts) {
  const { showBrowser, slot = 0, proxy = null, proxyAuth = null, userAgent, lang = 'en-US,en;q=0.9', log = () => {} } = opts
  const chromePath = findChromePath()
  if (!chromePath) throw new Error('Không tìm thấy chrome.exe trên máy!')
  if (!WebSocket) throw new Error('Thiếu thư viện ws (node_modules/ws) — chưa copy sang build?')

  // Profile trắng tinh mỗi lần reg — xóa ngay sau khi Chrome chết
  const profileDir = path.join(PROFILE_ROOT, `reg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(profileDir, { recursive: true })

  // Proxy có user/pass → tunnel local; không auth → dùng thẳng
  let tunnel = null
  let proxyArg = null
  if (proxy && String(proxy).trim()) {
    if (proxyAuth && proxyAuth.user) {
      tunnel = new LocalProxyTunnel(proxyAuth, log)
      const tport = await tunnel.start()
      proxyArg = `http://127.0.0.1:${tport}`
      log(`🔗 Proxy có user/pass → tunnel local 127.0.0.1:${tport} → ${proxyAuth.host}:${proxyAuth.port}`)
    } else {
      proxyArg = String(proxy).trim()
    }
  }

  // Vị trí cửa sổ: xếp lưới theo slot. ẢN CHẾ ĐỘ = đẩy OFF-SCREEN (ngoài phải màn hình)
  // thay vì SW_HIDE/minimize — Chrome ẩn/minimize bị Windows throttled -> "mù" không
  // điền được (bug 25-10); off-screen thì render/focus đầy đủ mà user không thấy.
  const showIt = showBrowser !== false
  const gridX = 60 + (slot % 4) * 445
  const gridY = 40 + Math.floor(slot / 4) * 850
  let posX = gridX
  let posY = gridY
  if (!showIt) {
    try {
      const wa = screen.getPrimaryDisplay().workArea
      posX = wa.x + wa.width + 60 + (slot % 4) * 40
      posY = wa.y + 40
    } catch {}
  }

  const args = [
    `--remote-debugging-port=0`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
    '--remote-allow-origins=*',
    `--window-position=${posX},${posY}`,
    '--window-size=430,830',
    '--disable-notifications', '--disable-geolocation',
    '--disable-blink-features=AutomationControlled',
    '--mute-audio',
    `--lang=${lang.split(',')[0]}`,
    '--new-window',
    'about:blank',
  ]
  if (proxyArg) args.unshift(`--proxy-server=${proxyArg}`)

  const chromeProc = spawn(chromePath, args, { detached: false, stdio: 'ignore' })
  let killed = false

  // Chờ DevToolsActivePort (port 0 → Chrome tự chọn và ghi ra file trong profile)
  const devFile = path.join(profileDir, 'DevToolsActivePort')
  let dbgPort = null
  for (let i = 0; i < 80; i++) {
    if (killed) throw new Error('Chrome đã tắt trước khi kết nối được')
    try {
      const txt = fs.readFileSync(devFile, 'utf8')
      dbgPort = parseInt(txt.split('\n')[0].trim(), 10)
      if (dbgPort) break
    } catch {}
    await sleep(250)
  }
  if (!dbgPort) {
    try { chromeProc.kill() } catch {}
    throw new Error('Chrome mở nhưng không bật được cổng CDP (DevToolsActivePort không xuất hiện)')
  }

  const browser = await connectBrowser(dbgPort)
  // Gắn vào tab SẴN CÓ (launch arg 'about:blank') — không createTarget thêm để khỏi sinh tab trắng thừa
  let targetId = null
  try {
    const { targetInfos } = await browser.send('Target.getTargets')
    const page = (targetInfos || []).find(t => t.type === 'page')
    if (page) targetId = page.targetId
  } catch {}
  if (!targetId) {
    ;({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }))
  }
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Page.enable', {}, sessionId).catch(() => {})
  await browser.send('Runtime.enable', {}, sessionId).catch(() => {})
  await browser.send('Network.enable', {}, sessionId).catch(() => {})
  await browser.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {})

  // Mobile reg: device emulation mobile thật — chỉ UA mobile chưa đủ, FB vẫn trả form desktop
  if (opts.mobile) {
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 430, height: 830, deviceScaleFactor: 3, mobile: true,
      screenWidth: 430, screenHeight: 830
    }, sessionId).catch(() => {})
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId).catch(() => {})
    await browser.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }, sessionId).catch(() => {})
    log('📱 CDP Device Emulation MOBILE (Chrome thật): 430x830 mobile=true, touch 5 điểm')
  }

  if (userAgent) {
    await browser.send('Network.setUserAgentOverride', { userAgent }, sessionId).catch(() => {})
    log(`🕵️ User-Agent: ${String(userAgent).slice(0, 80)}...`)
  }

  // Ẩn/hiện cửa sổ thật qua Browser domain
  let windowId = null
  const getWindowId = async () => {
    if (windowId) return windowId
    try { const r = await browser.send('Browser.getWindowForTarget', { targetId }); windowId = r.windowId } catch {}
    return windowId
  }
  // Trạng thái ẩn/hiện LIVE — toggle giữa chừng (setShowBrowser) phải đọc được
  // trạng thái hiện tại, không phải giá trị lúc launch (bug cũ: isVisible tĩnh
  // → ẩn xong không hiện lại được / hiện xong không ẩn lại được)
  let winHidden = !showBrowser
  const setWindowState = async state => {
    const wid = await getWindowId()
    if (!wid) return
    if (state === 'normal') {
      await browser.send('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: 'normal', left: gridX, top: gridY, width: 430, height: 830 } }).catch(() => {})
    } else {
      await browser.send('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: state } }).catch(() => {})
    }
  }
  if (winHidden) {
    // 25-10: KHÔNG SW_HIDE/minimize nữa (Chrome bị throttle -> điền mù khi ẩn).
    // Cửa sổ đã đặt off-screen ngay từ launch args ở trên — chỉ đánh dấu trạng thái.
    log('🥷 Chế độ ẩn: cửa sổ Chrome đặt ngoài màn hình (off-screen) — vẫn render/điền bình thường')
  }

  let destroyed = false
  let loadWaiters = []
  let currentUrl = 'about:blank'
  const offEvents = []
  offEvents.push(browser.on('Page.loadEventFired', (p, sid) => {
    if (sid === sessionId) { const w = loadWaiters; loadWaiters = []; w.forEach(x => x()) }
  }))
  offEvents.push(browser.on('Page.frameNavigated', (p, sid) => {
    // Chỉ frame chính (không có parentId) — theo dõi URL cho wc.getURL()
    if (sid === sessionId && p && p.frame && !p.frame.parentId && p.frame.url) {
      currentUrl = p.frame.url
    }
  }))

  const cleanupAll = async () => {
    if (destroyed) return
    destroyed = true
    loadWaiters.forEach(x => x()); loadWaiters = []
    for (const off of offEvents) { try { off() } catch {} }
    try { browser.close() } catch {}
    if (!killed) {
      killed = true
      try { execSync(`taskkill /F /T /PID ${chromeProc.pid}`, { timeout: 6000, stdio: 'ignore' }) } catch {}
      try { chromeProc.kill() } catch {}
    }
    if (tunnel) tunnel.stop()
    // Chờ process Chrome chết thật rồi mới xóa profile (Windows còn giữ file lock một lát)
    let procExited = chromeProc.exitCode !== null || chromeProc.signalCode !== null
    if (!procExited) {
      chromeProc.once('exit', () => { procExited = true })
      for (let i = 0; i < 15 && !procExited; i++) await sleep(200)
    }
    let removed = false
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      removed = !fs.existsSync(profileDir)
    } catch {}
    if (removed) {
      log(`🧹 Đã tắt Chrome (pid ${chromeProc.pid}) + xóa profile ${path.basename(profileDir)} — phiên sau là Chrome trắng tinh`)
    } else {
      log(`⚠ Profile ${path.basename(profileDir)} còn bị khóa, hẹn dọn lại sau 5s...`)
      const t = setTimeout(() => {
        try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch {}
      }, 5000)
      try { t.unref() } catch {}
    }
  }

  // process vẫn sống nếu ws chết bất ngờ? Chrome là con của electron → app chết = chrome chết (không detached)

  const doLoadURL = async (url) => {
    currentUrl = url
    await browser.send('Page.navigate', { url }, sessionId)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { loadWaiters = loadWaiters.filter(x => x !== fin); reject(new Error('loadURL timeout 90s')) }, 90000)
      const fin = () => { clearTimeout(t); resolve() }
      loadWaiters.push(fin)
      if (destroyed) { clearTimeout(t); reject(new Error('Chrome đã tắt')) }
    })
  }

  const wc = {
    loadURL: doLoadURL,
    async executeJavaScript(code, _userGesture) {
      const r = await browser.send('Runtime.evaluate', {
        expression: code, returnByValue: true, awaitPromise: true, userGesture: true,
      }, sessionId)
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails
        const msg = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'JS error'
        throw new Error(String(msg).split('\n')[0])
      }
      return r.result && r.result.value
    },
    getURL() { return currentUrl },
    async insertText(text) {
      await browser.send('Input.insertText', { text: String(text) }, sessionId)
    },
    sendInputEvent(ev) {
      const mods = ev.modifiers || []
      const mask = (mods.includes('shift') ? 8 : 0) | (mods.includes('control') ? 2 : 0) | (mods.includes('alt') ? 1 : 0) | (mods.includes('meta') ? 4 : 0)
      if (ev.type === 'mouseDown' || ev.type === 'mouseUp') {
        browser.send('Input.dispatchMouseEvent', {
          type: ev.type === 'mouseDown' ? 'mousePressed' : 'mouseReleased',
          x: ev.x, y: ev.y, button: ev.button || 'left', clickCount: ev.clickCount || 1,
        }, sessionId).catch(() => {})
      } else if (ev.type === 'mouseMove') {
        browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ev.x, y: ev.y }, sessionId).catch(() => {})
      } else if (ev.type === 'keyDown' || ev.type === 'keyUp' || ev.type === 'char') {
        const code = String(ev.keyCode || '')
        const vkc = vkcOf(code)
        const keyName = code === 'Space' ? ' ' : code.length === 1 ? code.toLowerCase() : code
        const base = { modifiers: mask, windowsVirtualKeyCode: vkc, nativeVirtualKeyCode: vkc, key: keyName }
        if (ev.type === 'keyDown') {
          // rawKeyDown: KHÔNG mang text — chữ chỉ được chèn bởi event 'char' (tránh gõ 2 lần)
          browser.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, sessionId).catch(() => {})
        } else if (ev.type === 'keyUp') {
          browser.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId).catch(() => {})
        } else {
          browser.send('Input.dispatchKeyEvent', {
            ...base, type: 'char', text: code === 'Space' ? ' ' : code, unmodifiedText: code === 'Space' ? ' ' : code,
          }, sessionId).catch(() => {})
        }
      }
    },
    on(_evt, _cb) { return () => {} },
    debugger: {
      attach() {},
      async sendCommand(method, params) {
        return browser.send(method, params || {}, sessionId)
      },
    },
  }

  const win = {
    webContents: wc,
    isDestroyed: () => destroyed,
    isVisible: () => !destroyed && !winHidden,
    isMinimized: () => !destroyed && winHidden,
    async show() {
      winHidden = false
      // SW_RESTORE hiện lại cửa sổ (kèm un-minimize); CDP chỉ là phương án dự phòng
      if (!(await win32ShowWindow(chromeProc.pid, 9))) await setWindowState('normal')
    },
    async hide() {
      winHidden = true
      // SW_HIDE: biến mất khỏi taskbar luôn (CDP minimize chỉ núp xuống taskbar)
      if (!(await win32ShowWindow(chromeProc.pid, 0))) await setWindowState('minimized')
    },
    setTitle() {},
    loadURL: doLoadURL,
    getURL() { return currentUrl },
    async destroy() { await cleanupAll() },
    _profileDir: profileDir,
    _chromePid: chromeProc.pid,
    _isRealChrome: true,
  }

  // Session giả: proxy đã áp lúc launch; UA qua override; cookies đọc qua CDP
  const ses = {
    async setProxy() {},
    async setUserAgent(ua) {
      await browser.send('Network.setUserAgentOverride', { userAgent: ua }, sessionId).catch(() => {})
    },
    cookies: {
      async get(filter = {}) {
        const r = await browser.send('Network.getCookies', {
          urls: ['https://www.facebook.com', 'https://facebook.com', 'https://m.facebook.com', 'https://web.facebook.com'],
        }, sessionId).catch(() => ({ cookies: [] }))
        const want = String(filter.domain || '').replace(/^\./, '')
        return (r.cookies || [])
          .filter(c => !want || String(c.domain).includes(want))
          .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, session: c.expires === -1, secure: !!c.secure, httpOnly: !!c.httpOnly }))
      },
    },
    async clearStorageData() {
      await browser.send('Network.clearBrowserCookies', {}, sessionId).catch(() => {})
    },
    async clearCache() {
      await browser.send('Network.clearBrowserCache', {}, sessionId).catch(() => {})
    },
  }

  log(`🪟 Chrome thật: pid ${chromeProc.pid} | CDP :${dbgPort} | profile ${path.basename(profileDir)}${proxyArg ? ` | proxy ${proxyArg}` : ''} | build 2010g-trang`)

  return { win, ses, targetId, sessionId, browser, cleanup: cleanupAll }
}

module.exports = { findChromePath, createRealChromeSession, LocalProxyTunnel, win32ShowWindow, win32WindowVisible }
