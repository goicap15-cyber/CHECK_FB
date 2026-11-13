// LDPlayer reg engine (Facebook Lite trên giả lập Android) - thuần Node,
// điều khiển ldconsole.exe + adb.exe, đọc UI qua `uiautomator dump`.
// Không cần Python/uiautomator2 -> build nén đi máy khác vẫn chạy được.
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const SMSPVA = require('./sms')

const FBLITE_PKG = 'com.facebook.lite'

const POPULAR_DEVICES = [
  ['samsung', 'SM-S918B'],
  ['samsung', 'SM-S908B'],
  ['samsung', 'SM-G998B'],
  ['samsung', 'SM-A546B'],
  ['xiaomi', '2312DRA50G'],
  ['oppo', 'CPH2451'],
  ['vivo', 'V2254A'],
  ['google', 'Pixel 8 Pro']
]

const FIRST_NAMES = ['Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Huynh', 'Vo', 'Dang', 'Bui', 'Do']
const LAST_NAMES = ['An', 'Binh', 'Cuong', 'Dung', 'Giang', 'Hai', 'Hung', 'Linh', 'Minh', 'Nam', 'Phong', 'Son', 'Vinh']

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1))

function generateRandomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return `Fb@${s}!`
}

function fileLog(msg) {
  try {
    fs.appendFileSync(path.join(__dirname, 'reg_debug_log.txt'),
      `[${new Date().toLocaleString('vi-VN', { hour12: false })}] ${msg}\n`, 'utf8')
  } catch {}
}

// ── Tự tìm bộ cài LDPlayer trên máy (để build đem đi máy khác vẫn chạy) ──
function _exec(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve(String((stdout || '') + (stderr || '')))
      })
    } catch {
      resolve('')
    }
  })
}

async function _exists(p) {
  try { await fs.promises.access(p); return true } catch { return false }
}

async function detectLdPlayerInstall(explicitDir = null) {
  const candidates = []
  if (explicitDir) candidates.push(explicitDir)

  // 1. Override lưu cạnh app (ldplayer_path.txt ghi bởi Settings)
  try {
    const ov = fs.readFileSync(path.join(__dirname, 'ldplayer_path.txt'), 'utf8').trim()
    if (ov && !candidates.includes(ov)) candidates.push(ov)
  } catch {}

  // 2. Registry của LDPlayer (XUANYUAN/Leidian)
  for (const key of ['HKCU\\Software\\Leidian', 'HKLM\\SOFTWARE\\WOW6432Node\\Leidian', 'HKLM\\SOFTWARE\\Leidian']) {
    const out = await _exec('reg', ['query', key, '/s', '/f', 'InstallDir'], 8000)
    const re = /([A-Za-z]:\\[^\r\n"']*LDPlayer[^\r\n"']*)/g
    let m
    while ((m = re.exec(out))) candidates.push(m[1].trim())
  }

  // 3. Đường dẫn phổ biến trên các ổ đĩa thường gặp
  for (const drv of ['C', 'D', 'E', 'F']) {
    for (const sub of [
      'LDPlayer\\LDPlayer14', 'LDPlayer\\LDPlayer9', 'LDPlayer\\LDPlayer8', 'LDPlayer\\LDPlayer5',
      'LDPlayer\\LDPlayer64', 'LDPlayer14', 'LDPlayer9',
      'Program Files\\LDPlayer\\LDPlayer14', 'Program Files\\LDPlayer\\LDPlayer9',
      'Program Files (x86)\\LDPlayer\\LDPlayer14', 'Program Files (x86)\\LDPlayer\\LDPlayer9'
    ]) candidates.push(`${drv}:\\${sub}`)
  }
  // Quét 1 cấp thư mục LDPlayer* ở gốc ổ (một số bản cài tên LDPlayer4.x, LDPlayer-Adbl...)
  for (const drv of ['C', 'D', 'E', 'F']) {
    try {
      const root = `${drv}:\\`
      const entries = await fs.promises.readdir(root, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory() || !/^LDPlayer/i.test(e.name)) continue
        try {
          const subs = await fs.promises.readdir(path.join(root, e.name), { withFileTypes: true })
          for (const s of subs) {
            if (s.isDirectory()) candidates.push(path.join(root, e.name, s.name))
          }
          candidates.push(path.join(root, e.name))
        } catch {}
      }
    } catch {}
  }

  for (const dir of candidates) {
    const lc = path.join(dir, 'ldconsole.exe')
    if (await _exists(lc)) {
      const adb = path.join(dir, 'adb.exe')
      return {
        dir,
        ldconsolePath: lc,
        adbPath: (await _exists(adb)) ? adb : path.join(dir, 'adb.exe')
      }
    }
  }
  return null
}

// Parse 1 node XML của uiautomator dump
function _parseNodes(xml) {
  const nodes = []
  const nodeRe = /<node\b[^>]*>/g
  const attr = (s, name) => {
    const m = s.match(new RegExp(`${name}="((?:[^"\\\\]|\\\\.)*)"`))
    return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''
  }
  let m
  while ((m = nodeRe.exec(xml))) {
    const s = m[0]
    const b = s.match(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/)
    if (!b) continue
    nodes.push({
      text: attr(s, 'text'),
      desc: attr(s, 'content-desc'),
      cls: attr(s, 'class'),
      res: attr(s, 'resource-id'),
      clickable: attr(s, 'clickable') === 'true',
      x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4]
    })
  }
  return nodes
}

class LDPlayerEngine {
  constructor({ instanceIndex = 0, install = null, log = () => {} } = {}) {
    this.instanceIndex = instanceIndex
    this.serial = `127.0.0.1:${5555 + instanceIndex * 2}`
    this.install = install
    this.isAborted = false
    this._baseLog = log
    this.sms = new SMSPVA()
  }

  abort() { this.isAborted = true }

  log(msg) {
    this._baseLog(msg)
    fileLog(msg)
  }

  _checkAbort() {
    if (this.isAborted) {
      const e = new Error('ABORTED')
      e.aborted = true
      throw e
    }
  }

  async sleep(ms) {
    const step = 250
    let waited = 0
    while (waited < ms) {
      this._checkAbort()
      await new Promise(r => setTimeout(r, Math.min(step, ms - waited)))
      waited += step
    }
  }

  async ld(args, timeout = 20000) {
    if (!this.install) return ''
    return _exec(this.install.ldconsolePath, args, timeout)
  }

  async adb(args, timeout = 15000) {
    if (!this.install) return ''
    return _exec(this.install.adbPath, ['-s', this.serial, ...args], timeout)
  }

  async listInstances() {
    const out = await this.ld(['list2'])
    const idxs = []
    for (const line of out.split(/\r?\n/)) {
      const p = line.split(',')
      if (p.length >= 6 && /^\d+$/.test(p[0].trim())) idxs.push(+p[0].trim())
    }
    return idxs
  }

  _vmsDir() {
    return path.join(path.dirname(this.install.ldconsolePath), 'vms')
  }

  // LDPlayer mặc định tắt ADB (config thiếu key basicSettings.adbDebug) → không bao giờ
  // có NAT redirect 5555 → adb connect bị từ chối → bot treo vĩnh viễn ở "Mở giả lập".
  // Phải sửa config lúc VM TẮT; vbox file thì bị dnplayer ghi đè mỗi lần launch nên vô ích.
  async ensureAdbDebug() {
    try {
      const cfgPath = path.join(this._vmsDir(), 'config', `leidian${this.instanceIndex}.config`)
      if (!fs.existsSync(cfgPath)) return
      const raw = fs.readFileSync(cfgPath, 'utf8')
      const cfg = JSON.parse(raw)
      if (cfg['basicSettings.adbDebug'] === 1) return
      cfg['basicSettings.adbDebug'] = 1
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), 'utf8')
      this.log(`🔧 [LD #${this.instanceIndex}] Đã bật ADB trong config giả lập (thiếu basicSettings.adbDebug=1)`)
    } catch (e) {
      this.log(`⚠ [LD #${this.instanceIndex}] Không kiểm tra được config ADB: ${e.message}`)
    }
  }

  async _waitDiskCopyComplete(srcDir, dstDir, timeoutMs = 900000) {
    const deadline = Date.now() + timeoutMs
    let lastTotal = -1
    let stall = 0
    while (Date.now() < deadline) {
      let done = fs.existsSync(path.join(dstDir, 'leidian.vbox'))
      let total = 0
      for (const name of ['data.vdi', 'sdcard.vdi']) {
        const dstF = path.join(dstDir, name)
        const srcF = path.join(srcDir, name)
        if (!fs.existsSync(dstF)) { done = false; break }
        const sz = fs.statSync(dstF).size
        total += sz
        if (!fs.existsSync(srcF) || sz < fs.statSync(srcF).size) { done = false; break }
      }
      if (done) return true
      if (total === lastTotal) {
        if (++stall >= 18) return false   // 90s không tăng -> copier nền chết
      } else {
        stall = 0
        lastTotal = total
        this.log(`⏳ [LD #${this.instanceIndex}] Đang copy đĩa tạo giả lập... ${total.toLocaleString()} bytes`)
      }
      await this.sleep(5000)
    }
    return false
  }

  // Static lock: nhiều luồng copy instance cùng lúc sẽ đè nhau -> xếp hàng
  static _copyQueue = Promise.resolve()

  ensureInstance() {
    return (LDPlayerEngine._copyQueue = LDPlayerEngine._copyQueue.then(async () => {
      try {
        const idxs = await this.listInstances()
        if (idxs.includes(this.instanceIndex)) return true
        this.log(`➕ [LD #${this.instanceIndex}] Giả lập chưa có - copy từ #0 (có thể mất vài phút lần đầu)...`)
        await this.ld(['copy', '--name', `LDPlayer-${this.instanceIndex}`, '--from', '0'], 60000)
        const vms = this._vmsDir()
        const ok = await this._waitDiskCopyComplete(path.join(vms, 'leidian0'), path.join(vms, `leidian${this.instanceIndex}`))
        if (!ok) this.log(`❌ [LD #${this.instanceIndex}] Copy đĩa không hoàn tất!`)
        return ok
      } catch (e) {
        this.log(`❌ [LD #${this.instanceIndex}] Lỗi tạo giả lập: ${e.message}`)
        return false
      }
    }))
  }

  async launchInstance() {
    if (!await this.ensureInstance()) return false
    await this.ensureAdbDebug()
    this.log(`🚀 [LD #${this.instanceIndex}] Mở giả lập...`)
    await this.ld(['launch', '--index', String(this.instanceIndex)], 15000)
    // Chờ Android boot + ADB online (lần đầu sau modify có thể chậm) — log tiến trình
    // liên tục vì khi im lặng user tưởng treo và bấm Dừng => đốt số SMS đã thuê
    const deadline = Date.now() + 240000
    const t0 = Date.now()
    let adbSeen = false
    let lastProg = 0
    while (Date.now() < deadline) {
      this._checkAbort()
      await this._execConnect()
      const state = await this.adb(['get-state'], 8000)
      if (state.includes('device')) {
        if (!adbSeen) {
          adbSeen = true
          this.log(`🔌 [LD #${this.instanceIndex}] ADB đã kết nối - chờ Android boot nốt...`)
        }
        const boot = await this.adb(['shell', 'get-prop', 'sys.boot_completed'], 8000)
        if (boot.trim() === '1') {
          this.log(`✅ [LD #${this.instanceIndex}] Giả lập đã chạy, ADB online (${this.serial})`)
          return true
        }
      }
      if (Date.now() - lastProg > 10000) {
        lastProg = Date.now()
        this.log(`⏳ [LD #${this.instanceIndex}] Đang chờ giả lập khởi động + ADB... (${Math.round((Date.now() - t0) / 1000)}s)`)
      }
      await this.sleep(2500)
    }
    this.log(`❌ [LD #${this.instanceIndex}] ADB không online được sau 4 phút!`)
    return false
  }

  async _execConnect() {
    if (!this.install) return
    try { execFile(this.install.adbPath, ['connect', this.serial], { timeout: 8000, windowsHide: true }, () => {}) } catch {}
  }

  async quitInstance() {
    await this.ld(['quit', '--index', String(this.instanceIndex)], 10000)
  }

  // VM phải tắt HẲN trước khi modify - sleep 2s là chưa đủ: VM còn đang shutdown mà
  // launch lại thì boot rơi vào trạng thái hỏng, adbd không bao giờ lên (ADB chết 4 phút)
  async waitVmOff(timeoutMs = 30000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try {
        const out = await this.ld(['isrunning', '--index', String(this.instanceIndex)], 8000)
        if (!out.toLowerCase().includes('running')) {
          this.log(`✅ [LD #${this.instanceIndex}] Giả lập đã tắt hẳn (chờ ${Math.round((Date.now() - t0) / 1000)}s)`)
          return true
        }
      } catch {}
      await this.sleep(1000)
    }
    this.log(`⚠ [LD #${this.instanceIndex}] Giả lập chưa tắt xong sau 30s - vẫn thử tiếp`)
    return false
  }

  // ── Đổi IMEI + hãng/model máy: NHANH - sleep tối thiểu, poll liên tục ──
  async randomizeDevice() {
    const idx = (this.instanceIndex * 3 + randInt(0, POPULAR_DEVICES.length - 1)) % POPULAR_DEVICES.length
    const [mfg, model] = POPULAR_DEVICES[idx]
    this.log(`🎲 [LD #${this.instanceIndex}] Đổi thiết bị: ${mfg.toUpperCase()} ${model} | IMEI/AndroidID/MAC random...`)
    await this.quitInstance()
    await this.waitVmOff()
    await this.sleep(1000)
    await this.ld([
      'modify', '--index', String(this.instanceIndex),
      '--resolution', '360,640,160',
      '--manufacturer', mfg, '--model', model,
      '--imei', 'auto', '--androidid', 'auto', '--mac', 'auto', '--simserial', 'auto', '--imsi', 'auto'
    ], 20000)
    return this.launchInstance()
  }

  async clearFbData() {
    this.log(`🧹 [LD #${this.instanceIndex}] Xóa dữ liệu Facebook Lite...`)
    await this.adb(['shell', 'pm', 'clear', FBLITE_PKG], 20000)
    await this.sleep(1000)
  }

  async launchFbLite() {
    this.log(`📲 [LD #${this.instanceIndex}] Mở Facebook Lite...`)
    let out = await this.adb(['shell', 'am', 'start', '-n', `${FBLITE_PKG}/com.facebook.lite.MainActivity`], 15000)
    if (!/Starting|Warning|starting/.test(out)) {
      await this.adb(['shell', 'monkey', '-p', FBLITE_PKG, '-c', 'android.intent.category.LAUNCHER', '1'], 15000)
    }
    await this.sleep(4000)
  }

  // ── UI helpers (thay uiautomator2 bằng dump XML) ──
  async dumpUi(retries = 6) {
    for (let i = 0; i < retries; i++) {
      this._checkAbort()
      const out = await this.adb(['shell', 'uiautomator', 'dump', '/sdcard/ui_dump.xml'], 20000)
      if (/dumped|UI hierchary/.test(out)) {
        const xml = await this.adb(['shell', 'cat', '/sdcard/ui_dump.xml'], 15000)
        if (xml && xml.includes('<node')) return _parseNodes(xml)
      }
      await this.sleep(1200)
    }
    return []
  }

  _center(n) { return [Math.round((n.x1 + n.x2) / 2), Math.round((n.y1 + n.y2) / 2)] }

  findNode(nodes, { text, textContains, className, resourceId, desc } = {}) {
    const has = (v, t) => v && t && (t.exact ? v === t.q : v.toLowerCase().includes(t.q.toLowerCase()))
    for (const n of nodes) {
      if (text && n.text !== text) continue
      if (textContains && !n.text.toLowerCase().includes(textContains.toLowerCase())) continue
      if (className && n.cls !== className) continue
      if (resourceId && !n.res.includes(resourceId)) continue
      if (desc && !n.desc.toLowerCase().includes(desc.toLowerCase())) continue
      if (n.x2 > n.x1 && n.y2 > n.y1) return n
    }
    return null
  }

  async waitFor(selector, timeoutMs = 8000, nodesFn = null) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      this._checkAbort()
      const nodes = nodesFn ? await nodesFn() : await this.dumpUi()
      const n = this.findNode(nodes, selector)
      if (n) return n
      await this.sleep(900)
    }
    return null
  }

  async tapNode(selector, timeoutMs = 8000) {
    const n = await this.waitFor(selector, timeoutMs)
    if (!n) return false
    const [x, y] = this._center(n)
    await this.adb(['shell', 'input', 'tap', String(x), String(y)], 10000)
    await this.sleep(600)
    return true
  }

  // Click + gõ text vào EditText thứ k (0-based) - clear bằng DEL trước khi gõ
  async typeIntoEdit(index, value, { clear = true } = {}) {
    const nodes = await this.dumpUi()
    const edits = nodes.filter(n => n.cls === 'android.widget.EditText' && n.x2 > n.x1 && n.y2 > n.y1)
    if (index >= edits.length) return false
    const [x, y] = this._center(edits[index])
    await this.adb(['shell', 'input', 'tap', String(x), String(y)], 10000)
    await this.sleep(700)
    if (clear) {
      for (let i = 0; i < 30; i++) {
        await this.adb(['shell', 'input', 'keyevent', '67'], 6000)
      }
    }
    // Nháy nhanh hơn: gom 1 lệnh shell nhiều keyevent DEL? adb shell chấp nhận chuỗi lệnh nối `;`
    const safe = String(value).replace(/\\/g, '\\\\').replace(/'/g, `'\\''`)
    await this.adb(['shell', `input text '${safe}'`], 20000)
    await this.sleep(500)
    return true
  }

  async tapScreen(xPct, yPct) {
    const x = Math.round(360 * xPct)
    const y = Math.round(640 * yPct)
    await this.adb(['shell', 'input', 'tap', String(x), String(y)], 10000)
    await this.sleep(1200)
  }

  async drag(x1, y1, x2, y2, durMs = 30) {
    await this.adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(durMs)], 15000)
  }

  async pressBack() {
    await this.adb(['shell', 'input', 'keyevent', '4'], 8000)
    await this.sleep(1200)
  }

  async dismissPermissionPopups() {
    for (const sel of [
      { resourceId: 'permission_allow_button' },
      { text: 'ALLOW' }, { text: 'Allow' }, { text: 'Cho phép' },
      { textContains: 'ALLOW' }, { textContains: 'Allow' }
    ]) {
      if (await this.tapNode(sel, 1500)) return true
    }
    return false
  }

  async closeSmartLockPopups() {
    for (let i = 0; i < 2; i++) {
      const nodes = await this.dumpUi()
      const allText = nodes.map(n => n.text).join(' ')
      if (/Choose an account|continue to Lite/i.test(allText)) {
        this.log(`🤖 [LD #${this.instanceIndex}] Đóng popup Google Smart Lock...`)
        await this.pressBack()
      }
    }
  }

  // ── Wizard đăng ký Facebook Lite: từ màn chào mừng tới màn nhập mã OTP ──
  async stepPhone({ firstName, lastName, phoneFormats, genderStr, birthDay, birthMonth, birthYear, password }) {
    await this.closeSmartLockPopups()

    // 1. Create new account
    let clickedCreate = false
    for (let attempt = 0; attempt < 4; attempt++) {
      const nodes = await this.dumpUi()
      if (/Choose an account/i.test(nodes.map(n => n.text).join(' '))) await this.pressBack()
      if (await this.tapNode({ text: 'Create new account' }, 2500)) { clickedCreate = true; break }
      if (await this.tapNode({ textContains: 'Create new' }, 2000)) { clickedCreate = true; break }
      if (await this.tapNode({ text: 'Tạo tài khoản mới' }, 2000)) { clickedCreate = true; break }
    }
    if (!clickedCreate) this.log(`⚠ [LD #${this.instanceIndex}] Không bấm được "Create new account" - có thể đã ở trong wizard`)

    // 2. Get started
    for (const sel of [{ text: 'Get started' }, { text: 'Bắt đầu' }, { textContains: 'Get started' }]) {
      if (await this.tapNode(sel, 3000)) break
    }

    await this.dismissPermissionPopups()

    // 3. Điền Họ + Tên
    await this.typeIntoEdit(0, firstName)
    await this.sleep(800)
    await this.typeIntoEdit(1, lastName)
    await this.sleep(800)
    for (const sel of [{ text: 'Next' }, { text: 'Tiếp tục' }, { textContains: 'Next' }]) {
      if (await this.tapNode(sel, 3000)) break
    }
    await this.dismissPermissionPopups()

    // 4. Ngày sinh: popup Set date + kéo 3 cột (theo FB_AUTO, màn 360x640)
    const nodesB = await this.dumpUi()
    const bTxt = nodesB.map(n => n.text).join(' ').toLowerCase()
    if (/birthday|wrong info|years old/.test(bTxt)) {
      this.log(`🎂 [LD #${this.instanceIndex}] Chọn ngày sinh...`)
      const sw = 360, sh = 640
      const monthX = Math.round(sw * 0.28), dayX = Math.round(sw * 0.50), yearX = Math.round(sw * 0.72)
      const colTop = Math.round(sh * 0.44), colBot = Math.round(sh * 0.58)

      const popupOpen = await this.dumpUi().then(ns =>
        !!this.findNode(ns, { text: 'Set date' }) || !!this.findNode(ns, { text: 'Cancel' }) || !!this.findNode(ns, { resourceId: 'android:id/datePicker' }))
      if (!popupOpen) {
        let opened = false
        for (const sel of [
          { resourceId: 'android:id/datePicker' },
          { className: 'android.widget.EditText' },
          { textContains: 'years old' }, { textContains: 'Birthday' }
        ]) {
          if (await this.tapNode(sel, 1600)) { opened = true; break }
        }
        if (!opened) await this.tapScreen(0.36, 0.38)
        await this.sleep(1500)
      }

      // Kéo Tháng & Ngày lên 2 lần, Kéo Năm từ 2026 về 1990-2002
      for (let i = 0; i < 2; i++) { await this.drag(monthX, colBot, monthX, colTop, 30) }
      for (let i = 0; i < 2; i++) { await this.drag(dayX, colBot, dayX, colTop, 30) }
      const yearDrags = randInt(20, 25)
      for (let i = 0; i < yearDrags; i++) { await this.drag(yearX, colTop, yearX, colBot, 20) }
      await this.sleep(400)

      const nsY = await this.dumpUi()
      let detectedYear = null
      for (const n of nsY) {
        if (/^\d{4}$/.test(n.text) && +n.text <= 2026) { detectedYear = +n.text; break }
      }
      this.log(`🎂 [LD #${this.instanceIndex}] Năm chọn được: ${detectedYear}`)
      if (detectedYear && detectedYear < 1988) {
        for (let i = 0; i < 4; i++) await this.drag(yearX, colBot, yearX, colTop, 20)
      } else if (detectedYear && detectedYear > 2004) {
        for (let i = 0; i < 6; i++) await this.drag(yearX, colTop, yearX, colBot, 20)
      }

      for (const sel of [
        { resourceId: 'android:id/button1' },
        { text: 'Set' }, { text: 'SET' }, { text: 'OK' }, { text: 'Ok' }
      ]) {
        if (await this.tapNode(sel, 2000)) break
      }
      await this.sleep(800)

      for (const sel of [{ text: 'Next' }, { text: 'Tiếp tục' }, { textContains: 'Next' }]) {
        if (await this.tapNode(sel, 2500)) break
      }
    }

    // 5. Giới tính
    const nodesG = await this.dumpUi()
    const gTxt = nodesG.map(n => n.text).join(' ').toLowerCase()
    if (/gender/.test(gTxt) || this.findNode(nodesG, { text: 'Male' }) || this.findNode(nodesG, { text: 'Female' })) {
      this.log(`⚧ [LD #${this.instanceIndex}] Chọn giới tính: ${genderStr}`)
      const gSel = genderStr === 'Female'
        ? [{ text: 'Female' }, { text: 'Nữ' }, { text: 'Male' }]
        : [{ text: 'Male' }, { text: 'Nam' }, { text: 'Female' }]
      for (const sel of gSel) {
        if (await this.tapNode(sel, 2000)) break
      }
      await this.sleep(800)
      for (const sel of [{ text: 'Next' }, { text: 'Tiếp tục' }, { textContains: 'Next' }]) {
        if (await this.tapNode(sel, 2000)) break
      }
    }

    // 6. Số điện thoại: thử lần lượt các định dạng (0..., +84..., raw)
    await this.dismissPermissionPopups()
    let phoneAccepted = false
    for (const pVal of phoneFormats) {
      this.log(`📱 [LD #${this.instanceIndex}] Điền số điện thoại: ${pVal}`)
      await this.typeIntoEdit(0, pVal)
      await this.sleep(800)
      for (const sel of [{ text: 'Next' }, { text: 'Tiếp tục' }, { textContains: 'Next' }]) {
        if (await this.tapNode(sel, 2500)) break
      }
      await this.sleep(2500)
      const ns = await this.dumpUi()
      const t = ns.map(n => n.text).join(' ').toLowerCase()
      const hasErr = /incorrect|full number|wrong info|enter a valid/.test(t)
      if (!hasErr) {
        phoneAccepted = true
        this.log(`✅ [LD #${this.instanceIndex}] SĐT ${pVal} được FB Lite chấp nhận`)
        break
      }
      this.log(`⚠ [LD #${this.instanceIndex}] FB Lite từ chối ${pVal} - thử định dạng khác...`)
    }
    if (!phoneAccepted) throw new Error('FB Lite không chấp nhận số điện thoại ở mọi định dạng')

    // 7. Mật khẩu
    await this.waitFor({ textContains: 'assword' }, 8000)
    await this.typeIntoEdit(0, password)
    await this.sleep(800)
    let signedUp = false
    for (const sel of [{ text: 'Next' }, { text: 'Sign Up' }, { text: 'Đăng ký' }, { text: 'Tiếp' }, { textContains: 'Sign Up' }]) {
      if (await this.tapNode(sel, 3000)) { signedUp = true; break }
    }
    if (!signedUp) this.log(`⚠ [LD #${this.instanceIndex}] Không tìm thấy nút Sign Up/Next sau mật khẩu`)
    await this.sleep(3500)

    // 8. I agree
    let agreed = false
    for (const sel of [
      { text: 'I agree' }, { text: 'I Agree' }, { text: 'I AGREE' },
      { textContains: 'agree' }, { textContains: 'Agree' }, { textContains: 'đồng ý' }
    ]) {
      if (await this.tapNode(sel, 2000)) { agreed = true; break }
    }
    this.log(agreed ? `🤝 [LD #${this.instanceIndex}] Đã bấm I agree` : `⚠ [LD #${this.instanceIndex}] Không thấy nút I agree`)
    await this.sleep(3000)

    // 9. "I didn't get the code" -> Send via SMS (nếu có màn này)
    let noCode = false
    for (const sel of [
      { textContains: "didn't get" }, { textContains: "Didn't get" }, { textContains: 'didnt get' }
    ]) {
      if (await this.tapNode(sel, 3000)) { noCode = true; break }
    }
    if (noCode) {
      this.log(`📩 [LD #${this.instanceIndex}] Bấm "I didn't get the code" -> chọn Send via SMS`)
      for (const sel of [{ textContains: 'Send code via SMS' }, { textContains: 'Send via SMS' }, { textContains: 'SMS' }]) {
        if (await this.tapNode(sel, 3000)) break
      }
      for (const sel of [{ text: 'Continue' }, { text: 'Send' }, { text: 'Tiếp tục' }, { text: 'Gửi' }]) {
        if (await this.tapNode(sel, 3000)) break
      }
      await this.sleep(2000)
    }

    // Chờ màn nhập mã xác nhận xuất hiện (EditText + chữ "code")
    const otpDeadline = Date.now() + 120000
    while (Date.now() < otpDeadline) {
      this._checkAbort()
      const ns = await this.dumpUi()
      const t = ns.map(n => n.text).join(' ').toLowerCase()
      const hasEdit = ns.some(n => n.cls === 'android.widget.EditText')
      if (hasEdit && /code|xác nhận|xac nhan/.test(t)) {
        this.log(`✅ [LD #${this.instanceIndex}] Đã ở màn nhập mã xác nhận FB Lite`)
        return true
      }
      await this.sleep(2000)
    }
    throw new Error('Không thấy màn nhập mã xác nhận của FB Lite sau 120s')
  }

  async stepOtp(otpCode) {
    this.log(`🔢 [LD #${this.instanceIndex}] Dán OTP ${otpCode} vào FB Lite...`)
    const ok = await this.typeIntoEdit(0, otpCode, { clear: false })
    if (!ok) {
      await this.adb(['shell', 'input', 'text', String(otpCode)], 15000)
    }
    await this.sleep(1000)
    let clicked = false
    for (const sel of [{ text: 'Next' }, { text: 'OK' }, { text: 'Confirm' }, { text: 'Xác nhận' }, { desc: 'Next' }]) {
      if (await this.tapNode(sel, 2500)) { clicked = true; break }
    }
    if (!clicked) {
      await this.adb(['shell', 'input', 'keyevent', '66'], 8000)   // ENTER
    }
    await this.sleep(12000)

    const ns = await this.dumpUi()
    const t = ns.map(n => n.text).join(' ').toLowerCase()
    if (/incorrect|has expired|invalid code|wrong code/.test(t)) {
      return { ok: false, screen: t.substring(0, 200) }
    }
    return { ok: true, screen: t.substring(0, 200) }
  }

  // ── Luồng chính: trả cùng shape với FBRegisterEngine.registerSingleAccount ──
  async registerSingleAccount({ smsOperator = null, onLog = () => {} } = {}) {
    this._baseLog = onLog
    const log = (m) => this.log(m)
    let smsOrderId = null
    let displayPhone = null
    let localPhone = null
    const oldSmsCodes = new Set()

    const releaseSms = async (why) => {
      if (smsOrderId) {
        log(`📞 Hủy số đã thuê ${localPhone || displayPhone} (${why}) - yêu cầu hoàn tiền SMSPVA...`)
        try { await this.sms.cancelOrder(smsOrderId) } catch {}
        smsOrderId = null
      }
    }

    const firstName = pick(FIRST_NAMES)
    const lastName = pick(LAST_NAMES)
    const fullName = `${lastName} ${firstName}`
    const password = generateRandomPassword()
    const birthYear = randInt(1992, 2002)
    const birthMonth = randInt(1, 12)
    const birthDay = randInt(1, 28)
    const genderStr = Math.random() > 0.5 ? 'Female' : 'Male'

    let launched = false
    let touched = false   // bot đã từng quit/modify/launch giả lập -> có trách nhiệm tắt nó khi xong
    try {
      if (!this.install) this.install = await detectLdPlayerInstall()
      if (!this.install) {
        const err = 'Không tìm thấy LDPlayer trên máy! Cài LDPlayer hoặc khai báo đường dẫn trong Settings (LDPlayer path).'
        log(`❌ ${err}`)
        return { success: false, status: 'ERROR', email: '', password, name: fullName, error: err }
      }

      // 1. Thuê số SMSPVA (trước khi đụng giả lập - fail nhanh nếu API/key lỗi)
      let lastNumErr = null
      for (let numTry = 1; numTry <= 3 && !smsOrderId; numTry++) {
        try {
          if (numTry > 1) log(`🔁 Thử lấy số điện thoại lại lần ${numTry}/3...`)
          const num = await this.sms.requestNumber({ operator: smsOperator, log })
          smsOrderId = num.orderId
          displayPhone = num.displayPhone
          localPhone = num.localPhone || (String(num.phoneNumber || '').startsWith('0') ? num.phoneNumber : '0' + num.phoneNumber)
          log(`✓ Số điện thoại thuê được: ${localPhone} (dạng quốc tế ${displayPhone}, nhà mạng ${num.operator}, Order ${num.orderId})`)
        } catch (err) {
          lastNumErr = err
          log(`✗ Lỗi lấy số điện thoại (lần ${numTry}/3): ${err.message}`)
          if (numTry < 3) await this.sleep(2000)
        }
      }
      if (!smsOrderId) {
        return { success: false, status: 'ERROR', email: '', password, name: fullName, error: lastNumErr ? lastNumErr.message : 'Không thuê được số từ SMSPVA' }
      }

      // Mốc chặn SMS cũ lần 1: SMS nằm sẵn lúc thuê là của người thuê trước
      const preOtp = await this.sms.peekOtp(smsOrderId, { log }).catch(() => null)
      if (preOtp) {
        oldSmsCodes.add(preOtp)
        log(`ℹ Số này đang có SMS cũ (mã ${preOtp}) - sẽ bỏ qua, chỉ nhận SMS mới`)
      }

      // 2. Đổi IMEI + hãng máy (NHANH) -> mở lại giả lập
      touched = true
      const launchedOk = await this.randomizeDevice()
      if (!launchedOk) {
        await releaseSms('không mở được giả lập')
        return { success: false, status: 'ERROR', email: localPhone, password, name: fullName, error: `LDPlayer #${this.instanceIndex} không khởi động/ADB không online được` }
      }
      launched = true

      // 3. FB Lite sạch + mở app
      await this.clearFbData()
      await this.launchFbLite()

      // 4. Wizard đăng ký tới màn nhập mã
      const clean = displayPhone.replace(/\D/g, '')
      const phoneFormats = []
      if (clean.startsWith('84')) {
        phoneFormats.push('0' + clean.slice(2))
        phoneFormats.push('+' + clean)
        phoneFormats.push(clean)
      } else if (clean.startsWith('0')) {
        phoneFormats.push(clean)
        phoneFormats.push('+84' + clean.slice(1))
      } else {
        phoneFormats.push('+' + clean)
        phoneFormats.push('0' + clean)
        phoneFormats.push(clean)
      }

      try {
        await this.stepPhone({
          firstName, lastName, phoneFormats, genderStr,
          birthDay, birthMonth, birthYear, password
        })
      } catch (e) {
        if (e.aborted) {
          await releaseSms('bot bị dừng')
          return { success: false, status: 'ABORTED', email: localPhone, password, name: fullName, error: 'Đã hủy' }
        }
        await releaseSms('lỗi wizard đăng ký FB Lite')
        log(`❌ ${e.message}`)
        return { success: false, status: 'ERROR', email: localPhone, password, name: fullName, error: e.message }
      }

      // Mốc chặn SMS cũ lần 2: ngay trước khi poll (FB chưa kịp gửi lúc wizard vừa xong)
      try {
        const earlySms = await this.sms.peekOtp(smsOrderId, { log })
        if (earlySms && !oldSmsCodes.has(earlySms)) {
          oldSmsCodes.add(earlySms)
          log(`ℹ SMS cũ về muộn (mã ${earlySms}) - thêm vào danh sách bỏ qua`)
        }
      } catch {}

      // 5. Chờ SMS OTP (chỉ vào đây khi đã ở màn nhập mã)
      log('📱 Đang đợi SMS OTP từ SMSPVA...')
      const otpCode = await this.sms.waitForOtp(smsOrderId, {
        log,
        checkRunning: () => !this.isAborted,
        ignoreCodes: oldSmsCodes
      })
      if (!otpCode) {
        if (!this.isAborted) await releaseSms('không nhận được SMS OTP')
        return { success: false, status: 'ERROR', email: localPhone, password, name: fullName, error: 'Không nhận được mã OTP qua SMS' }
      }
      log(`🔑 Đã nhận OTP: ${otpCode}`)

      // 6. Dán OTP + Next
      const otpRes = await this.stepOtp(otpCode)
      if (!otpRes.ok) {
        await releaseSms('FB Lite báo sai mã OTP')
        log(`❌ FB Lite báo lỗi mã OTP trên màn hình: ${otpRes.screen}`)
        return { success: false, status: 'ERROR', email: localPhone, password, name: fullName, error: 'FB Lite từ chối mã OTP' }
      }
      log(`🎉 ĐĂNG KÝ THÀNH CÔNG qua LDPlayer #${this.instanceIndex}! (${fullName} | ${localPhone})`)
      log(`ℹ Màn hình cuối: ${otpRes.screen}`)

      return {
        success: true,
        status: 'LIVE',
        uid: '',
        email: localPhone,
        phone: displayPhone || undefined,
        password,
        name: fullName,
        cookieStr: '',
        netscapeFormat: '',
        cookies: []
      }
    } catch (err) {
      if (err && err.aborted) {
        await releaseSms('bot bị dừng')
        return { success: false, status: 'ABORTED', email: localPhone, password, name: fullName, error: 'Đã hủy' }
      }
      log(`❌ Lỗi tiến trình LDPlayer: ${err.message}`)
      await releaseSms('lỗi tiến trình')
      return { success: false, status: 'ERROR', email: localPhone, password, name: fullName, error: err.message }
    } finally {
      // Dọn dẹp sau mỗi nick (kể cả lỗi/Dừng): xóa data FB Lite (xóa dấu vết acc vừa reg)
      // rồi tắt giả lập trả RAM - nick sau anyway phải quit để đổi IMEI nên không tốn thêm thời gian
      if (launched) {
        try {
          log(`🧹 [LD #${this.instanceIndex}] Reg xong - xóa data Facebook Lite...`)
          await this.adb(['shell', 'pm', 'clear', FBLITE_PKG], 20000)
        } catch {}
      }
      if (touched) {
        try { await this.quitInstance() } catch {}
        if (launched) log(`✅ [LD #${this.instanceIndex}] Đã dọn xong: FB Lite sạch + giả lập tắt (trả RAM)`)
      }
    }
  }
}

module.exports = { LDPlayerEngine, detectLdPlayerInstall, FBLITE_PKG }
