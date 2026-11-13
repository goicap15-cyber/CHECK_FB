// Sanity test pipeline OCR: vẽ ảnh BMP số 7-segment -> tesseract digits-only -> đọc lại
const fs = require('fs')
const path = require('path')

// 7-segment cho 0-9: từng thanh [trên, trên-trái, trên-phải, giữa, dưới-trái, dưới-phải, dưới]
const SEG = {
  0: [1,1,1,0,1,1,1], 1: [0,0,1,0,0,1,0], 2: [1,0,1,1,1,0,1], 3: [1,0,1,1,0,1,1],
  4: [0,1,1,1,0,1,0], 5: [1,1,0,1,0,1,1], 6: [1,1,0,1,1,1,1], 7: [1,0,1,0,0,1,0],
  8: [1,1,1,1,1,1,1], 9: [1,1,1,1,0,1,1]
}
function makePng(digitsStr) {
  const zlib = require('zlib')
  const W = 32, H = 56, S = 5, GAP = 12
  const width = digitsStr.length * (W + GAP), height = H
  // raw grayscale scanlines (mỗi dòng: 1 byte filter=0 + width byte)
  const raw = Buffer.alloc(height * (width + 1), 255)
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0
  const drawRect = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) raw[y * (width + 1) + 1 + x] = 0 }
  digitsStr.split('').forEach((ch, i) => {
    const ox = i * (W + GAP), s = SEG[ch]
    if (s[0]) drawRect(ox, 0, W, S)
    if (s[1]) drawRect(ox, 0, S, H / 2)
    if (s[2]) drawRect(ox + W - S, 0, S, H / 2)
    if (s[3]) drawRect(ox, H / 2 - S / 2, W, S)
    if (s[4]) drawRect(ox, H / 2, S, H / 2)
    if (s[5]) drawRect(ox + W - S, H / 2, S, H / 2)
    if (s[6]) drawRect(ox, H - S, W, S)
  })
  const crc32 = (buf) => {
    let c, table = crc32.table
    if (!table) { table = crc32.table = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 } }
    c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32LE(data.length) // BE đúng chuẩn: ghi đè
    len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 0 // 8-bit grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

;(async () => {
  const target = '4732'
  fs.writeFileSync('test_ocr_input.png', makePng(target))
  const { createWorker } = require('tesseract.js')
  const w = await createWorker('eng', 1, { langPath: path.join(__dirname, 'tessdata'), gzip: false })
  await w.setParameters({ tessedit_char_whitelist: '0123456789' })
  const { data } = await w.recognize(fs.readFileSync('test_ocr_input.png'))
  const digits = String(data.text || '').replace(/\D/g, '')
  console.log(`Kỳ vọng: ${target} | OCR đọc: "${digits}" (conf ${Math.round(data.confidence || 0)}%)`)
  console.log(digits === target ? 'OCR_PIPELINE_OK ✓' : 'OCR lệch — pipeline chạy nhưng độ chính xác phụ thuộc ảnh thật')
  await w.terminate()
  process.exit(0)
})().catch(e => { console.error('LOI:', e.message); process.exit(1) })
