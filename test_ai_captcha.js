// Test đọc captcha bằng AI vision qua OpenRouter
const fs = require('fs')
const path = require('path')

const API_KEY = process.env.OPENROUTER_API_KEY || ''
const MODEL = process.env.AI_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free'

async function aiRead(b64, mime) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'This is a Facebook captcha image containing exactly 6 digits in bold black font, with thin black curved noise lines crossing over them. Read the 6 digits strictly from left to right. Respond with ONLY the 6 digits and nothing else.' },
          { type: 'image_url', image_url: { url: `data:${mime || 'image/png'};base64,${b64}` } }
        ]
      }]
    })
  })
  const j = await r.json().catch(() => ({}))
  if (j.error) return { err: JSON.stringify(j.error).substring(0, 200) }
  const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
  return { text: String(txt).trim(), digits: String(txt).replace(/\D/g, '') }
}

;(async () => {
  // ping text trước
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 20, messages: [{ role: 'user', content: 'Say OK' }] })
    })
    const j = await r.json().catch(() => ({}))
    if (j.error) console.log('PING LỖI:', JSON.stringify(j.error).substring(0, 200))
    else console.log('PING OK:', (j.choices && j.choices[0].message.content || '').trim().substring(0, 40))
  } catch (e) { console.log('PING EXC:', e.message) }

  const files = ['captcha_raw_1.png', 'captcha_raw_2.png', 'captcha_raw_3.png', 'view_r8_1.png', 'view_goc_1.png']
  for (const f of files) {
    const p = path.join(__dirname, f)
    if (!fs.existsSync(p)) { console.log(f, 'KHÔNG TỒN TẠI'); continue }
    const b64 = fs.readFileSync(p).toString('base64')
    const reads = []
    for (let k = 0; k < 2; k++) {
      const r = await aiRead(b64)
      reads.push(r.err ? ('ERR:' + r.err) : r.digits)
      await new Promise(res => setTimeout(res, 1500))
    }
    console.log(`${f} => đọc lần 1: "${reads[0]}" | lần 2: "${reads[1]}" ${reads[0] === reads[1] && /^\d{6}$/.test(reads[0]) ? '✅ NHẤT QUÁN' : '⚠️'}`)
  }
})().catch(e => { console.error('EXC:', e.message); process.exit(1) })
