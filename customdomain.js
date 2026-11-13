// ==========================================
// CustomDomain Email Client
// Dung domain rieng de tao dia chi email random va nhan OTP tu Facebook
//
// Kien truc:
//   FB gui OTP -> email@yourdomain.com -> Cloudflare Email Worker
//   -> POST den webhook server (chay local hoac VPS) -> tool nay doc
//
// Interface tuong thich voi mailtm.js / tempmail.js:
//   createEmail() -> { email, sidToken }
//   pollForOtp(sidToken, seen, max, interval, log) -> { otp, subject, mailId }
// ==========================================

const http = require('http')
const https = require('https')

// -- CAU HINH - SUA O DAY HOAC DUNG BIEN MOI TRUONG -----------------------
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || 'genblackmmoonline.online'
const WEBHOOK_BASE_URL = process.env.CUSTOM_DOMAIN_WEBHOOK || 'http://103.252.117.95:2052'
const WEBHOOK_SECRET = process.env.CUSTOM_DOMAIN_SECRET || 'fbregSecret2026'
// -------------------------------------------------------------------------

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms) }) }

function randLocal(n) {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const all = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = letters[Math.floor(Math.random() * letters.length)]
  for (let i = 1; i < (n || 12); i++) s += all[Math.floor(Math.random() * all.length)]
  return s
}

// ── Email store in-memory (chi dung khi chay --server) ─────────────────────
const emailStore = {}
const STORE_TTL_MS = 30 * 60 * 1000

function cleanupStore() {
  const now = Date.now()
  for (const addr of Object.keys(emailStore)) {
    emailStore[addr] = (emailStore[addr] || []).filter(function(m) { return now - m.receivedAt < STORE_TTL_MS })
    if (emailStore[addr].length === 0) delete emailStore[addr]
  }
}

// ── Webhook HTTP Server ─────────────────────────────────────────────────────
// Chay: node customdomain.js --server
// Cloudflare Email Worker se POST email vao day
function startWebhookServer(port) {
  port = port || 2525
  const server = http.createServer(function(req, res) {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200); res.end('OK'); return
    }

    // Nhan email tu Cloudflare Worker
    if (req.method === 'POST' && req.url === '/incoming') {
      let body = ''
      req.on('data', function(chunk) { body += chunk })
      req.on('end', function() {
        try {
          const secret = req.headers['x-webhook-secret'] || ''
          if (secret !== WEBHOOK_SECRET) {
            res.writeHead(401); res.end('Unauthorized'); return
          }
          const data = JSON.parse(body)
          const to = String(data.to || '').toLowerCase().trim()
          if (!to) { res.writeHead(400); res.end('No to'); return }
          if (!emailStore[to]) emailStore[to] = []
          emailStore[to].push({
            id: data.messageId || (Date.now() + '-' + Math.random().toString(36).slice(2)),
            from: data.from || '',
            subject: data.subject || '',
            body: data.html || data.text || '',
            receivedAt: Date.now()
          })
          console.log('[CustomDomain] Email den: ' + to + ' | Subject: ' + (data.subject || '(trong)'))
          res.writeHead(200); res.end('OK')
        } catch (e) {
          console.error('[CustomDomain] Parse loi:', e.message)
          res.writeHead(400); res.end('Bad JSON')
        }
      })
      return
    }

    // Doc danh sach email
    if (req.method === 'GET' && req.url.startsWith('/messages')) {
      const u = new URL(req.url, 'http://localhost')
      const addr = (u.searchParams.get('email') || '').toLowerCase().trim()
      cleanupStore()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(emailStore[addr] || []))
      return
    }

    res.writeHead(404); res.end('Not found')
  })

  server.listen(port, '0.0.0.0', function() {
    console.log('[CustomDomain] Webhook server dang chay tai port ' + port)
    console.log('[CustomDomain] Domain nhan: @' + CUSTOM_DOMAIN)
    console.log('[CustomDomain] Cloudflare Worker POST ve: ' + WEBHOOK_BASE_URL + '/incoming')
    console.log('[CustomDomain] Secret: ' + WEBHOOK_SECRET)
  })
  return server
}

// ── HTTP GET helper ─────────────────────────────────────────────────────────
function httpGet(url, timeoutMs) {
  timeoutMs = timeoutMs || 10000
  return new Promise(function(resolve, reject) {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: timeoutMs }, function(res) {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', function(c) { raw += c })
      res.on('end', function() {
        try { resolve(JSON.parse(raw)) } catch (e) { resolve(raw) }
      })
    })
    req.on('timeout', function() { req.destroy(new Error('Timeout')) })
    req.on('error', reject)
  })
}

// ── CustomDomainEmail Client ────────────────────────────────────────────────
function CustomDomainEmail(opts) {
  opts = opts || {}
  this.domain = opts.domain || CUSTOM_DOMAIN
  this.webhookBase = (opts.webhookBase || WEBHOOK_BASE_URL).replace(/\/+$/, '')
}

/**
 * Tao dia chi email random tren domain cua may
 * Cloudflare Email Routing catch-all -> moi dia chi @domain deu nhan duoc
 * Returns { email, sidToken }  (sidToken = email, de poll OTP sau)
 */
CustomDomainEmail.prototype.createEmail = async function(prefixLength) {
  prefixLength = prefixLength || 12
  // Kiem tra webhook server dang chay
  try {
    await httpGet(this.webhookBase + '/health', 5000)
  } catch (e) {
    throw new Error(
      'CustomDomain: Webhook server KHONG phan hoi tai ' + this.webhookBase + '\n' +
      '-> Hay chay: node customdomain.js --server\n' +
      '   hoac dat bien moi truong CUSTOM_DOMAIN_WEBHOOK'
    )
  }
  const local = randLocal(prefixLength)
  const email = local + '@' + this.domain
  return { email: email, sidToken: email }
}

/**
 * Lay danh sach email da nhan cua dia chi nay (tu webhook server)
 */
CustomDomainEmail.prototype.getEmailList = async function(email) {
  const msgs = await httpGet(
    this.webhookBase + '/messages?email=' + encodeURIComponent(email.toLowerCase()),
    10000
  )
  return Array.isArray(msgs) ? msgs : []
}

/**
 * Trich xuat OTP tu subject/body
 * Facebook OTP: 5-8 chu so
 */
CustomDomainEmail.prototype.extractOtp = function(subject, body, len) {
  subject = subject || ''; body = body || ''; len = len || 5
  const text = (subject + ' ' + body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
  // Tim gan tu khoa xac thuc
  const m1 = text.match(new RegExp('(?:code|m\\u00e3|ma|confirm|verify|facebook|confirmation)[^\\d]{0,40}(\\d{' + len + '})(?!\\d)', 'i'))
  if (m1) return m1[1]
  // Tim trong subject
  const m2 = subject.match(new RegExp('(?<!\\d)(\\d{' + len + '})(?!\\d)'))
  if (m2) return m2[1]
  // Fallback bat ky
  const m3 = text.match(new RegExp('(?<!\\d)(\\d{' + len + '})(?!\\d)'))
  return m3 ? m3[1] : null
}

/**
 * Poll cho OTP - interface giong cac mail client khac
 * @param {string} sidToken - dia chi email
 * @param {Set} seen - set id email da thay de bo qua
 * @param {number} max - so lan thu toi da
 * @param {number} interval - ms giua moi lan poll
 * @param {function} log
 */
CustomDomainEmail.prototype.pollForOtp = async function(sidToken, seen, max, interval, log) {
  const self = this
  seen = seen || new Set()
  max = max || 25
  interval = interval || 6000
  log = log || function() {}
  const email = (sidToken || '').toLowerCase().trim()

  for (let i = 1; i <= max; i++) {
    log('[CustomDomain] Cho OTP lan ' + i + '/' + max + ' cho ' + email + '...')
    try {
      const msgs = await self.getEmailList(email)
      const newMsgs = msgs.filter(function(m) { return !seen.has(m.id) })
      if (newMsgs.length > 0) {
        const msg = newMsgs[0]
        log('[CustomDomain] Email moi tu: ' + msg.from + ' | Subject: ' + msg.subject)
        const otp = self.extractOtp(msg.subject, msg.body, 6)
                 || self.extractOtp(msg.subject, msg.body, 5)
        if (otp) {
          log('[CustomDomain] OTP tim thay: ' + otp)
          return { otp: otp, subject: msg.subject, mailId: msg.id }
        }
        // Co email nhung khong co OTP -> danh dau da doc, cho email khac
        seen.add(msg.id)
        log('[CustomDomain] Email "' + msg.subject + '" khong co ma OTP, tiep tuc cho...')
      }
    } catch (err) {
      log('[CustomDomain] Loi poll: ' + err.message)
    }
    if (i < max) await sleep(interval)
  }
  return null
}

// ── Xuat Cloudflare Worker Script ra console ────────────────────────────────
function printWorkerScript() {
  const webhookUrl = WEBHOOK_BASE_URL + '/incoming'
  const secret = WEBHOOK_SECRET
  console.log('====================================================================')
  console.log('CLOUDFLARE EMAIL WORKER SCRIPT')
  console.log('Copy doan nay: Cloudflare Dashboard -> Workers -> Create Worker')
  console.log('====================================================================')
  console.log('export default {')
  console.log('  async email(message, env, ctx) {')
  console.log('    const rawEmail = await new Response(message.raw).text();')
  console.log('    const lines = rawEmail.split("\\r\\n");')
  console.log('    let subject = ""; let bodyStart = -1;')
  console.log('    for (let i = 0; i < lines.length; i++) {')
  console.log('      if (lines[i].toLowerCase().startsWith("subject:")) {')
  console.log('        subject = lines[i].slice(8).trim();')
  console.log('      }')
  console.log('      if (lines[i] === "" && bodyStart === -1) bodyStart = i + 1;')
  console.log('    }')
  console.log('    const body = bodyStart > 0 ? lines.slice(bodyStart).join("\\n") : rawEmail;')
  console.log('    await fetch("' + webhookUrl + '", {')
  console.log('      method: "POST",')
  console.log('      headers: {')
  console.log('        "Content-Type": "application/json",')
  console.log('        "x-webhook-secret": "' + secret + '"')
  console.log('      },')
  console.log('      body: JSON.stringify({')
  console.log('        to: message.to,')
  console.log('        from: message.from,')
  console.log('        subject: subject,')
  console.log('        text: body,')
  console.log('        html: body,')
  console.log('        messageId: crypto.randomUUID()')
  console.log('      })')
  console.log('    });')
  console.log('  }')
  console.log('};')
  console.log('====================================================================')
  console.log('SETUP CLOUDFLARE (5 buoc):')
  console.log('1. Cloudflare Dashboard -> chon domain -> Email -> Email Routing -> Enable')
  console.log('2. Tab "Routing rules" -> "Catch-all" -> Action: "Send to Worker"')
  console.log('3. Workers & Pages -> Create Worker -> Paste script tren -> Deploy')
  console.log('4. Bind Worker: Workers -> Settings -> Triggers -> Email -> Add binding')
  console.log('5. Test: gui email den test@yourdomain.com')
  console.log('   -> curl http://localhost:2525/messages?email=test@yourdomain.com')
  console.log('')
  console.log('NEU CHAY LOCAL (khong co VPS/domain cong khai):')
  console.log('   Dung ngrok: ngrok http 2525')
  console.log('   Copy URL ngrok -> thay WEBHOOK_BASE_URL trong Worker script')
  console.log('====================================================================')
}

// ── CLI entry point ─────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.indexOf('--server') !== -1) {
    const pi = args.indexOf('--port')
    const port = pi !== -1 ? parseInt(args[pi + 1]) || 2525 : 2525
    startWebhookServer(port)
  } else if (args.indexOf('--worker') !== -1) {
    printWorkerScript()
  } else if (args.indexOf('--test') !== -1) {
    ;(async function() {
      const client = new CustomDomainEmail()
      const result = await client.createEmail()
      console.log('Test email:', result.email)
      console.log('Gui email den dia chi tren de test OTP...')
      const otp = await client.pollForOtp(result.email, new Set(), 10, 6000, console.log)
      console.log('Ket qua:', otp)
    })()
  } else {
    console.log('Lenh:')
    console.log('  node customdomain.js --server          # Khoi dong webhook server port 2525')
    console.log('  node customdomain.js --server --port 3000  # Port khac')
    console.log('  node customdomain.js --worker          # Xuat Cloudflare Worker script')
    console.log('  node customdomain.js --test            # Test tao email + poll OTP')
    console.log('')
    console.log('Bien moi truong:')
    console.log('  CUSTOM_DOMAIN=yourdomain.com')
    console.log('  CUSTOM_DOMAIN_WEBHOOK=http://localhost:2525')
    console.log('  CUSTOM_DOMAIN_SECRET=your_secret')
  }
}

module.exports = CustomDomainEmail
module.exports.startWebhookServer = startWebhookServer
module.exports.printWorkerScript = printWorkerScript
