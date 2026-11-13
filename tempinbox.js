// TempInboxEngine: driver cho tempinbox.dev (không có API) qua chrome_cdp.js
// Giới hạn 3 email/version Chrome — sau đó destroy Chrome + spawn phiên mới
// Flow: generate() → getEmail() → pollForOtp(email) → { code | timeout }
const FBRegisterCdp = require("./chrome_cdp")

const MAX_EMAILS_PER_SESSION = 3
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 600000 // 10 phút

class TempInboxSession {
  constructor(showBrowser = true) {
    this.showBrowser = showBrowser
    this.chromeSession = null
    this.email = null
    this.usedCount = 0
    this.destroyed = false
  }

  async start() {
    const browser = await FBRegisterCdp.createRealChromeSession({
      showBrowser: this.showBrowser,
      slot: "tempinbox"
    })
    if (!browser || !browser.ws || !browser.wc) throw new Error("Không tạo được chrome để vào tempinbox")
    this.chromeSession = browser

    const url = "https://tempinbox.dev/"
    await browser.loadURL(url)
    await new Promise(r => setTimeout(r, 4000))

    await this.generateEmail()
    return this.getEmail()
  }

  async generateEmail() {
    if (this.destroyed) return
    const js = `
      (function() {
        var btn = document.querySelector('[data-testid="generate-email-btn"]');
        if (!btn) return 'NO_BTN';
        var rc = btn.getBoundingClientRect();
        if (!(rc.width > 0 && rc.height > 0)) return 'HIDDEN';
        btn.scrollIntoView({block:'center'});
        return JSON.stringify({x: Math.round(rc.left + rc.width/2), y: Math.round(rc.top + rc.height/2)});
      })();
    `
    const raw = await this.chromeSession.wc.executeJavaScript(js).catch(() => null)
    if (!raw || raw === 'NO_BTN' || raw === 'HIDDEN') {
      throw new Error("Không thấy nút Generate New Email trên trang")
    }
    const pos = JSON.parse(raw)
    this.chromeSession.wc.sendInputEvent({type:"mouseDown", x:Math.round(pos.x),y:Math.round(pos.y),button:"left",clickCount:1})
    await new Promise(r => setTimeout(r,80))
    this.chromeSession.wc.sendInputEvent({type:"mouseUp",   x:Math.round(pos.x),y:Math.round(pos.y),button:"left",clickCount:1})
    await new Promise(r => setTimeout(r, 2500))
    this.usedCount++
  }

  async getEmail() {
    if (this.destroyed) return null
    const raw = await this.chromeSession.wc.executeJavaScript(`
      (function(){
        var el = document.querySelector('[data-testid="current-address"]');
        if (!el) return 'KO_O';
        var rc = el.getBoundingClientRect();
        if (!(rc.width > 0 && rc.height > 0)) return 'HIDDEN';
        return (el.textContent || '').trim();
      })();
    `).catch(() => null)
    if (!raw || raw === 'KO_O' || raw === 'HIDDEN') return null
    this.email = raw
    return this.email
  }

  async getInboxHtml() {
    if (this.destroyed) return null
    try {
      return await this.chromeSession.wc.executeJavaScript(`
        (function(){return document.documentElement.innerHTML;})()
      `).catch(() => null)
    } catch { return null }
  }

  async parseFacebookOtp(html) {
    // Tìm dòng sender = Facebook <registration@facebookmail.com>
    // Subject chứa mã số 5-6 chữ số
    if (!html) return null
    const fbMatch = html.match(/registration@facebookmail\.com[\'\"]?/i)
    if (!fbMatch) return null
    // Lấy subject email
    const subjectMatch = html.match(/email-subject[^>]*>([^<]*)</i)
    if (!subjectMatch) return null
    const subject = subjectMatch[1]
    // Tìm mã số trong subject hoặc preview
    const codeMatch = subject.match(/(\d{5,6})/)
    if (codeMatch) return {code: codeMatch[1], subject, email: this.email}
    // Fallback search trong preview
    const previewMatch = html.match(/email-preview[^>]*>([\s\S]*?)<\/div>/i)
    if (previewMatch) {
      const previewCode = previewMatch[1].match(/(\d{5,6})/)
      if (previewCode) return {code: previewCode[1], subject, email: this.email}
    }
    return null
  }

  async pollForOtp(email, targetSender = "Facebook") {
    const t0 = Date.now()
    while (Date.now() - t0 < POLL_TIMEOUT_MS) {
      if (this.destroyed) return {status: 'cancelled'}
      const html = await this.getInboxHtml()
      if (!html) { await sleep(POLL_INTERVAL_MS); continue }
      const fb = await this.parseFacebookOtp(html)
      if (fb) {
        // Verify email match
        if (fb.email !== email) { await sleep(POLL_INTERVAL_MS); continue }
        return {status: 'found', ...fb}
      }
      await sleep(POLL_INTERVAL_MS)
    }
    return {status: 'timeout', email}
  }

  isAtLimit() {
    return this.usedCount >= MAX_EMAILS_PER_SESSION
  }

  async destroy() {
    if (this.destroyed) return
    this.destroyed = true
    try { await this.chromeSession.close() } catch {}
    this.chromeSession = null
  }
}

async function createTempInbox(showBrowser = true) {
  const session = new TempInboxSession(showBrowser)
  await session.start()
  return session
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { TempInboxSession, createTempInbox }
