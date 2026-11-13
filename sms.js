// ==========================================
// SMSPVA Client for Node.js (Activation API v2)
// Base API: https://api.smspva.com
// Header: apikey
// Endpoints:
//   GET /activation/balance            -> {statusCode, data:{balance}}
//   GET /activation/number/{CNT}/{SRV} -> {statusCode, data:{orderId, phoneNumber, countryCode}}
//   GET /activation/sms/{orderId}      -> 200 {data:{sms:{text|code}}} | 202 chờ | 410 đóng
//   PUT /activation/cancelorder/{id}   -> refund số chưa nhận SMS
//   PUT /activation/blocknumber/{id}   -> báo số hỏng
// Rate limit: poll >= 4-5s, nghỉ 5s giữa các lần thử nhà mạng
// ==========================================

const https = require('https')
const fs = require('fs')
const path = require('path')

const KEY_FILE = path.join(__dirname, 'sms_key.txt')
const DEFAULT_API_KEY = 'Kycf32f1FaL2T2OmnWgOaEN7GQJtrP'
let API_KEY = DEFAULT_API_KEY
try {
  const saved = fs.readFileSync(KEY_FILE, 'utf8').trim()
  if (saved) API_KEY = saved
} catch {}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class SMSPVA {
  constructor(baseUrl = 'https://api.smspva.com', timeoutMs = 15000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.pollInterval = 5000   // SMSPVA bắt buộc nghỉ 4-5s giữa 2 lần poll
    this.maxWaitMs = 580 * 1000
  }

  _request(method, pathStr) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + pathStr)
      const req = https.request(url, {
        method,
        headers: {
          'apikey': API_KEY,
          'Accept': 'application/json'
        },
        timeout: this.timeoutMs
      }, (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { raw += chunk })
        res.on('end', () => {
          let body = null
          try { body = JSON.parse(raw) } catch {}
          resolve({ status: res.statusCode, body, raw })
        })
      })
      req.on('timeout', () => {
        req.destroy(new Error(`Timeout sau ${this.timeoutMs}ms kết nối api.smspva.com`))
      })
      req.on('error', err => reject(err))
      req.end()
    })
  }

  async getBalance() {
    const res = await this._request('GET', '/activation/balance')
    if (res.status === 200 && res.body && res.body.statusCode === 200) {
      const balance = res.body.data && res.body.data.balance
      return balance != null ? parseFloat(balance) : null
    }
    throw new Error('Lỗi kiểm tra số dư SMSPVA (HTTP ' + res.status + '): ' + (res.raw || '').substring(0, 150))
  }

  /**
   * Bảng giá số theo nhà mạng cho 1 dịch vụ.
   * /activation/serviceprice/{CNT}/{SRV} -> data:{price, priceByOperators:{DonorSigma_VN: "0.25", ...}}
   * Trả về { defaultPrice, operators: [{operator, price}] đã sort tăng dần }.
   */
  async getPrices(country = 'VN', service = 'opt2') {
    const cnt = String(country).toUpperCase()
    const res = await this._request('GET', `/activation/serviceprice/${cnt}/${service}`)
    const body = res.body
    if (res.status === 200 && body && body.statusCode === 200 && body.data) {
      const byOp = body.data.priceByOperators || {}
      const operators = Object.entries(byOp)
        .map(([operator, price]) => ({ operator, price: parseFloat(price) }))
        .filter(o => Number.isFinite(o.price) && o.price > 0)
        .sort((a, b) => a.price - b.price)
      return { defaultPrice: parseFloat(body.data.price) || null, operators }
    }
    throw new Error('Lỗi lấy bảng giá SMSPVA (HTTP ' + res.status + '): ' + (res.raw || '').substring(0, 120))
  }

  /**
   * Thuê 1 số VN cho Facebook (service opt2).
   * Chế độ auto: CHỈ thuê nhà mạng giá <= maxPrice (lấy bảng giá động từ API).
   * TUYỆT ĐỐI không fallback mù sang số "mặc định" - SMSPVA có thể giao operator
   * đắt nhất (Quebec $1.65) và trừ tiền mà người dùng không hay biết.
   * Trả về { orderId, phoneNumber, displayPhone, localPhone, countryCode, operator } hoặc throw.
   */
  async requestNumber({ country = 'VN', service = 'opt2', operator = null, maxRetries = 5, maxPrice = 0.5, log = () => {} } = {}) {
    const cnt = String(country).toUpperCase()
    const srv = String(service)

    let candidates
    if (operator && operator !== 'auto') {
      candidates = [operator]
    } else {
      try {
        const { operators } = await this.getPrices(country, service)
        candidates = operators.filter(o => o.price <= maxPrice).map(o => o.operator)
      } catch {}
      if (!candidates || !candidates.length) {
        // Fallback tĩnh nếu API bảng giá lỗi: toàn bộ operator $0.25 đã biết
        candidates = ['DonorSigma_VN', 'DonorXray_VN', 'DonorTango_VN', 'DonorLima_VN', 'DonorIntel_VN',
          'DonorZulu_VN', 'DonorHTMobile_VN', 'DonorVina_VN', 'DonorYankee_VN', 'DonorVietnamMobile2_VN', 'DonorViettelMobile_VN']
      }
      log(`📞 Chỉ thuê số giá <= $${maxPrice} (${candidates.length} nhà mạng: ${candidates.map(o => String(o).replace('Donor', '').replace('_VN', '')).join(', ')})`)
    }

    // Auto ladder: 2 vòng là đủ (hết số rẻ thì nghỉ, đừng đốt tiền số đắt).
    // Operator chọn tay: giữ nguyên maxRetries.
    const rounds = (operator && operator !== 'auto') ? maxRetries : 2

    let lastErr = 'Không rõ'
    for (let attempt = 1; attempt <= rounds; attempt++) {
      for (const op of candidates) {
        const opName = String(op).replace('Donor', '').replace('_VN', '')
        const qs = `?operator=${encodeURIComponent(op)}`
        try {
          const res = await this._request('GET', `/activation/number/${cnt}/${srv}${qs}`)

          if (res.status === 502 || res.status === 503) {
            lastErr = `Server quá tải (HTTP ${res.status})`
            await sleep(5000)
            continue
          }

          const body = res.body
          if (res.status === 200 && body && body.statusCode === 200) {
            const d = body.data || {}
            const rawPhone = String(d.phoneNumber || '').replace('+', '').trim()
            if (!rawPhone || !d.orderId) {
              lastErr = 'Phản hồi thiếu orderId/phoneNumber: ' + (res.raw || '').substring(0, 120)
              continue
            }
            // phoneNumber là số nội địa (VD: 989348562), mã quốc gia nằm riêng ở countryCode (+84)
            // -> ghép thành E.164 đầy đủ để FB nhận đúng, tránh double-prefix nếu số đã có đầu 84
            const cc = String(d.countryCode || '').replace(/\D/g, '')
            const fullPhone = cc && !rawPhone.startsWith(cc) ? cc + rawPhone : rawPhone
            // Dạng nội địa 0... để hiển thị/xuất nick (VD: 0338801491)
            const localPhone = rawPhone.startsWith('0') ? rawPhone : '0' + rawPhone
            return {
              orderId: String(d.orderId),
              phoneNumber: rawPhone,
              displayPhone: '+' + fullPhone,
              localPhone,
              countryCode: d.countryCode || cnt,
              operator: opName
            }
          }
          if (body && body.statusCode === 407) {
            throw new Error('Số dư SMSPVA không đủ (statusCode 407) - nạp thêm tiền!')
          }
          if (body && [405, 501, 502].includes(body.statusCode)) {
            lastErr = `Nhà mạng ${opName} tạm hết số`
            log(`✗ ${opName} tạm hết số`)
          } else {
            lastErr = `Lỗi nhà mạng ${opName} (HTTP ${res.status}${body && body.statusCode ? ' code ' + body.statusCode : ''})`
            log(`✗ ${lastErr}`)
          }
        } catch (err) {
          if (err.message && err.message.includes('Số dư')) throw err
          lastErr = `Lỗi kết nối SMSPVA (${opName}): ${err.message}`
          log(`✗ ${lastErr}`)
        }
        await sleep(5000) // rate limit 5s giữa các lần thử
      }
    }
    throw new Error(`Không lấy được số giá <= $${maxPrice} sau ${rounds} vòng thử (${lastErr}). Các nhà mạng rẻ đã hết số - thử lại sau hoặc chọn tay operator trong ô "Giá số thuê" (số đắt sẽ tốn tiền nhiều hơn).`)
  }

  /**
   * Doc 1 lan SMS hien tai cua don (khong poll loop).
   * Dung ngay sau khi thue so de lay ma SMS CU dang nam san tren so lam moc -
   * so duoc tai su dung nen co the con SMS cua nguoi thue truoc; poll OTP that
   * phai BO QUA cac ma nay (SMS tra ve ngay sau Submit la SMS cu, fill vao la FB bao sai ma).
   */
  async peekOtp(orderId, { log = () => {} } = {}) {
    try {
      const res = await this._request('GET', `/activation/sms/${orderId}`)
      const body = res.body
      if (res.status === 200 && body && body.statusCode === 200) {
        const smsData = (body.data && body.data.sms) || {}
        let smsText = ''
        if (typeof smsData === 'string') smsText = smsData
        else smsText = smsData.text || smsData.code || smsData.message || ''
        if (smsText && smsText !== '{}' && smsText !== '[object Object]') {
          const otp = this.extractOtp(smsText)
          if (otp) {
            log(`Số này đang có SMS sẵn: "${smsText.substring(0, 60)}"`)
            return otp
          }
        }
      }
    } catch (err) {
      log(`Không đọc được SMS sẵn trên số: ${err.message}`)
    }
    return null
  }

  /**
   * Poll tin nhắn SMS OTP cho order. Trả về chuỗi OTP hoặc null (timeout/đóng).
   * checkRunning(): trả false khi bot bị dừng -> tự hủy đơn để refund.
   * ignoreCodes: Set mã OTP cũ cần bỏ qua (SMS cũ nằm sẵn trên số thuê).
   */
  async waitForOtp(orderId, { maxWaitMs = null, log = () => {}, checkRunning = null, ignoreCodes = null } = {}) {
    const timeout = maxWaitMs || this.maxWaitMs
    const started = Date.now()
    let lastStatusLog = 0
    const skippedLogged = new Set()

    while (Date.now() - started < timeout) {
      if (checkRunning && !checkRunning()) {
        log(`🛑 Bot đã dừng - hủy đơn SMSPVA ${orderId} để hoàn tiền...`)
        await this.cancelOrder(orderId)
        return null
      }

      try {
        const res = await this._request('GET', `/activation/sms/${orderId}`)
        const body = res.body

        if (res.status === 200 && body && body.statusCode === 200) {
          const smsData = (body.data && body.data.sms) || {}
          let smsText = ''
          if (typeof smsData === 'string') smsText = smsData
          else smsText = smsData.text || smsData.code || smsData.message || ''
          if (smsText && smsText !== '{}' && smsText !== '[object Object]') {
            const otp = this.extractOtp(smsText)
            if (otp) {
              if (ignoreCodes && typeof ignoreCodes.has === 'function' && ignoreCodes.has(otp)) {
                if (!skippedLogged.has(otp)) {
                  log(`⏭ Bỏ qua SMS cũ trên số (mã ${otp}) - chỉ nhận SMS mới FB gửi sau Submit...`)
                  skippedLogged.add(otp)
                }
              } else {
                log(`✓ Nhận SMS: "${smsText.substring(0, 200)}" -> OTP = ${otp}`)
                return otp
              }
            } else {
              log(`⚠ Nhận SMS nhưng chưa tách được OTP: "${smsText.substring(0, 200)}"`)
            }
          }
        } else if (body && body.statusCode === 410) {
          log('✗ Đơn hàng SMSPVA đã bị đóng hoặc hết hạn!')
          return null
        }
        // statusCode 202 / HTTP khác = vẫn đang chờ SMS
      } catch (err) {
        log(`⚠ Lỗi kết nối polling SMS (thử lại tiếp): ${err.message}`)
      }

      const elapsed = Math.round((Date.now() - started) / 1000)
      if (Date.now() - lastStatusLog > 30000) {
        log(`⏳ Đang đợi SMS OTP cho số đã thuê... (${elapsed}s/${Math.round(timeout / 1000)}s)`)
        lastStatusLog = Date.now()
      }
      await sleep(this.pollInterval)
    }
    return null
  }

  async cancelOrder(orderId) {
    try {
      const res = await this._request('PUT', `/activation/cancelorder/${orderId}`)
      return res.status === 200
    } catch {
      return false
    }
  }

  async blockNumber(orderId) {
    try {
      const res = await this._request('PUT', `/activation/blocknumber/${orderId}`)
      return res.status === 200
    } catch {
      return false
    }
  }

  /**
   * Tách mã OTP từ nội dung SMS: chuỗi toàn số 4-8 chữ, hoặc dãy 5-6 số đứng riêng.
   */
  extractOtp(text) {
    if (!text) return null
    const cleaned = String(text).replace(/-/g, '').replace(/\s+/g, '').trim()
    if (/^\d{4,8}$/.test(cleaned)) return cleaned
    const matches = cleaned.match(/\b\d{5,6}\b/)
    if (matches) return matches[0]
    const split = String(text).match(/(\d{3})[- ]?(\d{2,3})/)
    if (split) return split[1] + split[2]
    return null
  }
}

module.exports = SMSPVA
module.exports.getApiKey = () => API_KEY
module.exports.setApiKey = (k) => {
  API_KEY = String(k || '').trim()
  try {
    if (API_KEY) fs.writeFileSync(KEY_FILE, API_KEY, 'utf8')
  } catch {}
}
