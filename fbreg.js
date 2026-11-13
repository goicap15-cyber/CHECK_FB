// ==========================================
// Facebook Automated Registration Engine v7
// Cơ chế Tọa độ Chuột Vật lý + Gõ phím thật từng ký tự (AUTO_BM-style)
// Hoàn toàn KHÔNG dùng class CSS - Chuẩn xác 100%
// ==========================================

const { BrowserWindow, session, screen, nativeTheme } = require('electron')
const { createRealChromeSession } = require('./chrome_cdp.js')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// 30-10: các đầu số di động VN thật — SĐT giả cho reg phải đa dạng đầu số,
// kẹt 1 mẫu (097314xxxx) là FB pattern-flag lỗi 'An error occurred during registration'
const VN_PHONE_PREFIXES = ['032','033','034','035','036','037','038','039','086','096','097','098','090','091','092','093','094','099','088','085','084','083','082','081','070','079','078','077','076','058','056']
// 30-10: SĐT theo NƯỚC của proxy — reg bằng proxy nước ngoài thì dùng SĐT nước đó
const PHONE_BY_COUNTRY = {
  VN: { prefixes: VN_PHONE_PREFIXES, len: 10 },
  US: { prefixes: ['347','212','415','305','702','313','917','213','323','646','818','737'], len: 10 },
  GB: { prefixes: ['7400','7411','7432','7477','7557','7700','7788','7911'], len: 10 },
  JP: { prefixes: ['090','080','070'], len: 10 },
  KR: { prefixes: ['010'], len: 10 },
  SG: { prefixes: ['8','9'], len: 8 },
  TH: { prefixes: ['06','08','09'], len: 10 },
  PH: { prefixes: ['905','906','915','916','917','918','919','920','921','926','927','928','939','947','949'], len: 10 },
  ID: { prefixes: ['811','812','813','821','822','851','852','853','838','857','858'], len: 11 },
  MY: { prefixes: ['012','013','014','016','017','018','019'], len: 10 },
  CN: { prefixes: ['130','131','135','137','138','150','155','186','188','189'], len: 11 },
  HK: { prefixes: ['5','6','9'], len: 8 },
  TW: { prefixes: ['902','905','906','908','912','918','919','935','936','937','938','939','958','962','963','965','966','967','968','970','972','975','989'], len: 10 },
  DE: { prefixes: ['151','152','157','160','162','163','170','171','172','173','174','175','176','177','178','179'], len: 11 },
  FR: { prefixes: ['06','07'], len: 10 },
  RU: { prefixes: ['903','905','906','909','910','911','912','915','916','917','919','921','925','926','927','929','936','937','939','951','953','960','961','962','963','964','965','966','967','968','969','977','978','985','987','988','989'], len: 10 },
  IN: { prefixes: ['70','71','72','73','74','75','76','77','78','79','80','81','82','83','84','85','86','87','88','89','90','91','92','93','94','95','96','97','98','99'], len: 10 },
  BR: { prefixes: ['119','118','117','116','115'], len: 11 },
  NG: { prefixes: ['703','705','706','803','806','808','810','811','812','813','814','815','816','817','818','901','902','903','909','912'], len: 10 },
  AU: { prefixes: ['04'], len: 9 },
  CA: { prefixes: ['347','212','415','305','702','313','917','213','323','646','818','737'], len: 10 }
}
function randomPhoneFor(cc) {
  const c = PHONE_BY_COUNTRY[String(cc || 'VN').toUpperCase()] || PHONE_BY_COUNTRY.VN
  const pre = c.prefixes[Math.floor(Math.random() * c.prefixes.length)]
  let rest = ''
  const need = Math.max(0, c.len - pre.length)
  for (let i = 0; i < need; i++) rest += Math.floor(Math.random() * 10)
  return pre + rest
}
function randomVnPhone() {
  const pre = VN_PHONE_PREFIXES[Math.floor(Math.random() * VN_PHONE_PREFIXES.length)]
  let rest = ''
  for (let i = 0; i < 7; i++) rest += Math.floor(Math.random() * 10)
  return pre + rest
}

// Cửa sổ Gmail GIỮ SỐNG qua các lần reg (yêu cầu 25-10): reg xong KHÔNG tắt cửa sổ,
// lần reg sau dùng lại luôn session đang sống — không nạp lại cookie tĩnh nên Google
// không đá. Keyed theo hash bộ cookie; khóa dòng để 2 nick chung Gmail không đá nhau.
const gmailLiveWindows = new Map()   // hash -> { win, ses, baseGmail }
const gmailLocks = new Map()         // hash -> promise chờ tới lượt
const TempMailMMO = require('./tempmail.js')
const TempMailId = require('./tempmailid.js')
const MailTm = require('./mailtm.js')
const TempMailG = require('./tempmailg.js')
const MailTd = require('./mailtd.js')
const TempMailV2 = require('./tempmailv2.js')
const TempMailOwn = require('./tempmailown.js')
const GmailProvider = require('./gmailapi.js')
const makeGmailVariant = require('./gmailapi.js').makeGmailVariant
const SMSPVA = require('./sms.js')
const { createTempInbox } = require('./tempinbox.js')
const CustomDomainEmail = require('./customdomain.js')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Chế độ ẩn danh: đếm cửa sổ reg đang sống để bật/tắt dark title bar ───
let regIncognitoWinCount = 0
function incognitoThemeOn() {
  if (regIncognitoWinCount === 0) { try { nativeTheme.themeSource = 'dark' } catch {} }
  regIncognitoWinCount++
}
function incognitoThemeOff() {
  regIncognitoWinCount = Math.max(0, regIncognitoWinCount - 1)
  if (regIncognitoWinCount === 0) { try { nativeTheme.themeSource = 'system' } catch {} }
}

// ── Tên theo quốc gia proxy ──────────────────────────────────────────────
const NAMES_BY_COUNTRY = {
  VN: {
    // KHÔNG DẤU: FB hay chấm đỏ tên có dấu tiếng Việt ("title or symbol in your name")
    first: ['Anh', 'Binh', 'Chau', 'Dung', 'Duc', 'Giang', 'Ha', 'Hai', 'Hieu', 'Hoang',
            'Huy', 'Hung', 'Khanh', 'Khoi', 'Linh', 'Long', 'Minh', 'Nam', 'Nghia', 'Phong',
            'Phuc', 'Quan', 'Quang', 'Sang', 'Son', 'Tai', 'Tam', 'Thang', 'Thanh', 'Thao',
            'Thinh', 'Tien', 'Toan', 'Trung', 'Tu', 'Tuan', 'Tung', 'Viet', 'Vinh', 'Xuan'],
    last:  ['Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Huynh', 'Phan', 'Vu', 'Vo', 'Dang',
            'Bui', 'Do', 'Ho', 'Ngo', 'Duong', 'Ly', 'Dinh', 'Ta', 'Cao', 'Trinh', 'Luong', 'Luu']
  },
  US: {
    first: ['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Joseph', 'Charles',
            'Thomas', 'Daniel', 'Mary', 'Patricia', 'Jennifer', 'Linda', 'Barbara', 'Susan',
            'Jessica', 'Karen', 'Sarah', 'Emily', 'Chris', 'Kevin', 'Brian', 'George', 'Edward'],
    last:  ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
            'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris',
            'Martin', 'Thompson', 'Young', 'Robinson', 'Clark', 'Lewis', 'Walker', 'Hall']
  },
  GB: {
    first: ['Oliver', 'Jack', 'Harry', 'George', 'Noah', 'Charlie', 'Jacob', 'Alfie',
            'Freddie', 'Oscar', 'Amelia', 'Olivia', 'Emily', 'Isla', 'Ava', 'Mia', 'Isabella',
            'Sophie', 'Lily', 'Grace', 'James', 'William', 'Thomas', 'Samuel', 'Henry'],
    last:  ['Smith', 'Jones', 'Williams', 'Taylor', 'Brown', 'Davies', 'Evans', 'Wilson',
            'Thomas', 'Roberts', 'Johnson', 'Lewis', 'Walker', 'Robinson', 'Wood', 'Thompson',
            'White', 'Watson', 'Jackson', 'Wright', 'Green', 'Harris', 'Cooper', 'King']
  },
  AU: {
    first: ['Oliver', 'William', 'Jack', 'Noah', 'Thomas', 'James', 'Lucas', 'Henry',
            'Ethan', 'Mason', 'Olivia', 'Charlotte', 'Ava', 'Isla', 'Mia', 'Amelia',
            'Grace', 'Emily', 'Ella', 'Sophie', 'Liam', 'Logan', 'Aiden', 'Caleb', 'Ryan'],
    last:  ['Smith', 'Jones', 'Williams', 'Brown', 'Wilson', 'Taylor', 'Johnson', 'White',
            'Martin', 'Anderson', 'Thompson', 'Harris', 'Davis', 'Clark', 'Robinson']
  },
  SG: {
    first: ['Wei', 'Jun', 'Jing', 'Hui', 'Ming', 'Xin', 'Kai', 'Rui', 'Ting', 'Ying',
            'Ryan', 'Ethan', 'Aiden', 'Lucas', 'Nathan', 'Hannah', 'Rachel', 'Sophia', 'Emma', 'Chloe'],
    last:  ['Tan', 'Lim', 'Lee', 'Ng', 'Ong', 'Goh', 'Chua', 'Koh', 'Wong', 'Chen',
            'Teo', 'Chan', 'Yeo', 'Chong', 'Sim', 'Lau', 'Phua', 'Yap', 'Soh', 'Wee']
  },
  PH: {
    first: ['Juan', 'Jose', 'Maria', 'Ana', 'Carlo', 'Nico', 'Miguel', 'Luis', 'Mark', 'John',
            'Angelo', 'Christian', 'Joshua', 'Gabriel', 'Rafael', 'Ella', 'Sophia', 'Isabella', 'Mia', 'Sofia'],
    last:  ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Ocampo', 'Garcia', 'Torres', 'Tomas',
            'Andres', 'Castillo', 'Villanueva', 'Mendoza', 'Ramos', 'Dela Cruz', 'Aquino']
  },
  MY: {
    first: ['Ahmad', 'Muhammad', 'Ali', 'Hassan', 'Ibrahim', 'Nur', 'Nurul', 'Siti', 'Aisyah', 'Fatimah',
            'Wei', 'Jun', 'Ming', 'Hui', 'Kai', 'Ryan', 'Ethan', 'Hannah', 'Rachel', 'Chloe'],
    last:  ['Abdullah', 'Ahmad', 'Ibrahim', 'Mohamed', 'Hassan', 'Ismail', 'Rahman', 'Rahim',
            'Tan', 'Lim', 'Lee', 'Ng', 'Ong', 'Wong', 'Chong', 'Yap', 'Koh', 'Goh']
  },
  TH: {
    first: ['Somchai', 'Somsak', 'Wichai', 'Prasert', 'Nattawut', 'Sunisa', 'Siriporn', 'Malee',
            'Pranee', 'Aom', 'Nat', 'Ploy', 'Pam', 'Fon', 'Film', 'Kwan', 'Nook', 'Pim', 'Bow', 'Gift'],
    last:  ['Srisuk', 'Kaewkla', 'Thongdee', 'Sombut', 'Phomma', 'Chaiyasit', 'Kongkla',
            'Boonma', 'Rattana', 'Suksan', 'Klahan', 'Boonsri', 'Meekhun', 'Wannapha']
  },
  ID: {
    first: ['Budi', 'Andi', 'Rizky', 'Dian', 'Hendra', 'Fajar', 'Wahyu', 'Agus', 'Dewi', 'Sari',
            'Putri', 'Rina', 'Rini', 'Ani', 'Yuni', 'Eko', 'Arif', 'Bagas', 'Dimas', 'Gilang'],
    last:  ['Santoso', 'Suharto', 'Setiawan', 'Kusuma', 'Hidayat', 'Pratama', 'Wibowo',
            'Nugroho', 'Utama', 'Saputra', 'Permana', 'Purnama', 'Ramadhan', 'Wijaya']
  },
  FR: {
    first: ['Thomas', 'Lucas', 'Hugo', 'Théo', 'Louis', 'Tom', 'Ethan', 'Noah', 'Mathis', 'Léo',
            'Emma', 'Léa', 'Manon', 'Camille', 'Ines', 'Julie', 'Lucie', 'Chloé', 'Marine', 'Sarah'],
    last:  ['Martin', 'Bernard', 'Thomas', 'Petit', 'Robert', 'Richard', 'Durand', 'Dubois',
            'Moreau', 'Laurent', 'Simon', 'Michel', 'Lefebvre', 'Leroy', 'Roux', 'David']
  },
  DE: {
    first: ['Lukas', 'Jonas', 'Luca', 'Felix', 'Leon', 'Finn', 'Paul', 'Elias', 'Ben', 'Tim',
            'Emma', 'Mia', 'Hannah', 'Lea', 'Leonie', 'Anna', 'Lena', 'Laura', 'Sophie', 'Clara'],
    last:  ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker',
            'Schulz', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf']
  },
  // Mặc định khi không xác định được quốc gia
  DEFAULT: {
    first: ['Alex', 'Chris', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Blake',
            'Dakota', 'Drew', 'Hayden', 'Jesse', 'Kendall', 'Parker', 'Peyton', 'Quinn', 'Reese', 'Skylar'],
    last:  ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Moore',
            'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin', 'Thompson', 'Young', 'Robinson']
  }
}

// ── Timezone theo quốc gia ────────────────────────────────────────────────
const TIMEZONE_MAP = {
  VN: 'Asia/Ho_Chi_Minh', US: 'America/New_York', GB: 'Europe/London',
  AU: 'Australia/Sydney', SG: 'Asia/Singapore', PH: 'Asia/Manila',
  MY: 'Asia/Kuala_Lumpur', TH: 'Asia/Bangkok', ID: 'Asia/Jakarta',
  FR: 'Europe/Paris', DE: 'Europe/Berlin', JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul', IN: 'Asia/Kolkata', CA: 'America/Toronto',
  NL: 'Europe/Amsterdam', IT: 'Europe/Rome', ES: 'Europe/Madrid',
  BR: 'America/Sao_Paulo', MX: 'America/Mexico_City'
}

// ── Random User-Agent ────────────────────────────────────────────────────
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0',
]

// UA mobile cho reg m.facebook.com (iPhone Safari + Android Chrome)
const UA_MOBILE_LIST = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
]

// ── Script inject chống fingerprint (Canvas noise + WebGL mask + Timezone) ──
function buildFingerprintScript(timezone) {
  return `
(function() {
  // 1. Canvas noise: thêm nhiễu nhỏ không nhìn thấy được vào pixel data
  const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
  const _toBlob = HTMLCanvasElement.prototype.toBlob;
  const _getImageData = CanvasRenderingContext2D.prototype.getImageData;
  function addNoise(imageData) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i]   = Math.min(255, Math.max(0, d[i]   + (Math.random() < 0.03 ? (Math.random() > 0.5 ? 1 : -1) : 0)));
      d[i+1] = Math.min(255, Math.max(0, d[i+1] + (Math.random() < 0.03 ? (Math.random() > 0.5 ? 1 : -1) : 0)));
      d[i+2] = Math.min(255, Math.max(0, d[i+2] + (Math.random() < 0.03 ? (Math.random() > 0.5 ? 1 : -1) : 0)));
    }
    return imageData;
  }
  HTMLCanvasElement.prototype.toDataURL = function() {
    const ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        const imgData = _getImageData.call(ctx, 0, 0, this.width, this.height);
        addNoise(imgData);
        ctx.putImageData(imgData, 0, 0);
      } catch(e) {}
    }
    return _toDataURL.apply(this, arguments);
  };

  // 2. WebGL: mask RENDERER + VENDOR (2 giá trị FB hay lấy để fingerprint)
  const RENDERERS = [
    'Intel(R) HD Graphics 4000', 'Intel(R) UHD Graphics 620',
    'Intel(R) Iris(R) Plus Graphics', 'NVIDIA GeForce GTX 1050',
    'AMD Radeon RX 580', 'Intel(R) HD Graphics 630'
  ];
  const VENDORS = ['Intel Open Source Technology Center', 'Google Inc.', 'NVIDIA Corporation', 'ATI Technologies Inc.'];
  const _renderer = RENDERERS[Math.floor(Math.random() * RENDERERS.length)];
  const _vendor   = VENDORS[Math.floor(Math.random() * VENDORS.length)];
  const _getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return _vendor;   // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return _renderer; // UNMASKED_RENDERER_WEBGL
    return _getParam.call(this, param);
  };
  const _getParam2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return _vendor;
    if (param === 37446) return _renderer;
    return _getParam2.call(this, param);
  };

  // 3. Timezone spoofing khớp với quốc gia proxy
  const _DTF = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function(locale, options) {
    options = options || {};
    if (!options.timeZone) options.timeZone = '${timezone}';
    return new _DTF(locale, options);
  };
  Object.defineProperty(Intl.DateTimeFormat, 'prototype', { value: _DTF.prototype, writable: false });
  Object.defineProperty(Intl.DateTimeFormat, 'supportedLocalesOf', { value: _DTF.supportedLocalesOf });

  // 4. Navigator.language khớp timezone
  try {
    Object.defineProperty(navigator, 'language', { get: () => '${timezone}'.startsWith('Asia/Ho_Chi_Minh') ? 'vi-VN' : 'en-US', configurable: true });
  } catch(e) {}

  // 5. Ẩn dấu hiệu Electron / automation - FB dùng để detect bot
  try {
    // Ẩn navigator.webdriver (Selenium/CDP detection)
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  } catch(e) {}

  // 6. Spoof navigator.plugins - trình duyệt thật có plugins, Electron mặc định rỗng
  try {
    const fakePlugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = fakePlugins.map(p => {
          const plugin = Object.create(Plugin.prototype);
          Object.defineProperty(plugin, 'name', { value: p.name });
          Object.defineProperty(plugin, 'filename', { value: p.filename });
          Object.defineProperty(plugin, 'description', { value: p.description });
          Object.defineProperty(plugin, 'length', { value: 0 });
          return plugin;
        });
        arr.item = (i) => arr[i];
        arr.namedItem = (n) => arr.find(p => p.name === n) || null;
        Object.defineProperty(arr, 'length', { value: fakePlugins.length });
        return arr;
      },
      configurable: true
    });
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => ({ length: 4, item: () => null, namedItem: () => null }),
      configurable: true
    });
  } catch(e) {}

  // 7. Spoof hardwareConcurrency và deviceMemory (Electron thường trả giá trị cố định)
  try {
    const cores = [2, 4, 4, 4, 6, 8, 8][Math.floor(Math.random() * 7)];
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => cores, configurable: true });
  } catch(e) {}
  try {
    const mem = [2, 4, 4, 8, 8][Math.floor(Math.random() * 5)];
    Object.defineProperty(navigator, 'deviceMemory', { get: () => mem, configurable: true });
  } catch(e) {}

  // 8. Ẩn chrome.runtime automation flags
  try {
    if (window.chrome && window.chrome.runtime) {
      const _crt = window.chrome.runtime;
      const spoofed = Object.assign({}, _crt);
      delete spoofed.connect;
      delete spoofed.sendMessage;
      Object.defineProperty(window, 'chrome', {
        get: () => ({ app: { isInstalled: false }, runtime: spoofed }),
        configurable: true
      });
    }
  } catch(e) {}

  // 9. Spoof screen resolution khớp với UA đã chọn (Electron mặc định = màn hình thật, có thể nhỏ bất thường)
  try {
    const W = screen.width || 1366, H = screen.height || 768;
    const avW = W, avH = H - 40;
    Object.defineProperty(screen, 'availWidth',  { get: () => avW, configurable: true });
    Object.defineProperty(screen, 'availHeight', { get: () => avH, configurable: true });
    Object.defineProperty(screen, 'colorDepth',  { get: () => 24,  configurable: true });
    Object.defineProperty(screen, 'pixelDepth',  { get: () => 24,  configurable: true });
  } catch(e) {}

  // 10. Ẩn process object của Node.js (Electron leak process vào window)
  try {
    if (window.process) {
      const _proc = window.process;
      Object.defineProperty(window, 'process', {
        get: () => undefined,
        configurable: true
      });
    }
  } catch(e) {}

  // 11. Ẩn __electronOnly__ và các global Electron khác
  try {
    ['__electronOnly__', '__electron__', 'electronRequire', '_nodeRequire'].forEach(function(k) {
      if (window[k] !== undefined) {
        try { Object.defineProperty(window, k, { get: () => undefined, configurable: true }); } catch(e) {}
      }
    });
  } catch(e) {}

  // 12. Permissions API - trình duyệt thật trả 'prompt', Electron hay trả 'denied'
  try {
    const _query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(params) {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return _query(params);
    };
  } catch(e) {}
})();
`;
}

function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }

function generateRandomPassword() {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower   = 'abcdefghjkmnpqrstuvwxyz'
  const digits  = '23456789'
  const special = '!@#$%&*'
  // Bắt buộc ít nhất 1 mỗi loại
  let parts = [
    upper[Math.floor(Math.random() * upper.length)],
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    digits[Math.floor(Math.random() * digits.length)],
    special[Math.floor(Math.random() * special.length)],
  ]
  const all = upper + lower + digits
  for (let i = 0; i < 5; i++) parts.push(all[Math.floor(Math.random() * all.length)])
  // Shuffle hoàn toàn
  for (let i = parts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));[parts[i], parts[j]] = [parts[j], parts[i]]
  }
  return parts.join('')
}

function getNamesForCountry(countryCode) {
  const cc = String(countryCode || '').toUpperCase()
  return NAMES_BY_COUNTRY[cc] || NAMES_BY_COUNTRY.DEFAULT
}

// ── IP Warm-up: ĐÃ BỎ (21-10, user chốt) ────────────────────────────────
// Trước đây giả lập browse facebook.com trước khi vào r.php để xây trust score,
// nhưng nó hiện trang login ~20s (user tưởng reg hỏng) và FB vẫn từ chối reg
// theo IP reputation như thường. Vào thẳng link reg.

class FBRegisterEngine {
  constructor(opts = {}) {
    this.tempmail = new TempMailMMO()
    this.tempmailId = new TempMailId()
    this.mailTm = new MailTm()
    this.tempmailG = new TempMailG()
    this.mailTd = new MailTd()
    this.tempmailV2 = new TempMailV2()
    this.mailOwn = new TempMailOwn()  // Mail server tự xây: mail.genblackmmoonline.online (catch-all + otp bóc sẵn)
    this.gmail = new GmailProvider(opts.gmailAccounts || [])  // Auto Reg v2: gmail dot/plus + IMAP app password
    this.sms = new SMSPVA()
    this.customDomain = new CustomDomainEmail()  // Domain rieng qua Cloudflare Email Routing
    this.tempInbox = null  // TempInbox session (new)
    this.isAborted = false
    this.activeWindows = []
    this.useRealChrome = !!opts.realChrome
  }

  abort() {
    this.isAborted = true
    for (const win of this.activeWindows) {
      try { if (!win.isDestroyed()) win.destroy() } catch {}
    }
    this.activeWindows = []
  }

  /** Bấm gạch "Hiện cửa sổ trình duyệt" lúc đang chạy: hiện/ẩn ngay các Chrome reg đang mở.
   *  25-10: ẩn bằng win.hide() làm renderer "mù" không điền được -> ẩn = đẩy off-screen,
   *  hiện = kéo về lưới slot. Cửa sổ luôn visible với Chromium nên reg không bị ảnh hưởng. */
  setShowBrowser(show) {
    let changed = 0
    for (const win of this.activeWindows) {
      try {
        if (!win || win.isDestroyed()) continue
        const b = win.getBounds()
        if (show) {
          const wa = screen.getPrimaryDisplay().workArea
          const onGrid = b.x >= wa.x && b.x < wa.x + wa.width
          if (!onGrid) {
            win.setBounds({ x: wa.x + 60 + (changed % 4) * 445, y: wa.y + 40, width: b.width, height: b.height })
            win.focus()
            changed++
          }
        } else {
          const wa = screen.getPrimaryDisplay().workArea
          const onGrid = b.x >= wa.x && b.x < wa.x + wa.width
          if (onGrid) {
            win.setBounds({ x: wa.x + wa.width + 60 + (changed % 4) * 40, y: wa.y + 40, width: b.width, height: b.height })
            changed++
          }
        }
      } catch {}
    }
    return changed
  }

  /**
   * Click chuột vật lý tại tọa độ pixel (x, y)
   */
  async mouseClick(wc, x, y) {
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await sleep(60)
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(120)
  }

  /** Chờ ngẫu nhiên kiểu người thật giữa các hành động (ms) — lấy mốc từ AUTO_BM */
  async humanPause(minMs, maxMs) {
    await sleep(minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs)))
  }

  /**
   * Lấy vị trí (index) các ô input của form đăng ký trong DOM hiện tại
   * Password tìm theo type, email là ô text cuối cùng (trước password)
   */
  async getFormInputIndices(wc) {
    return await wc.executeJavaScript(`
      (function() {
        var all = Array.from(document.querySelectorAll('input')).filter(function(i) {
          return i.offsetWidth > 0 && i.type !== 'hidden';
        });
        var texts = [];
        var passIdx = -1;
        all.forEach(function(i, k) {
          if (i.type === 'password') { if (passIdx === -1) passIdx = k; }
          else texts.push(k);
        });
        return {
          total: all.length,
          first: texts.length > 0 ? texts[0] : -1,
          last: texts.length > 1 ? texts[1] : -1,
          email: texts.length > 0 ? texts[texts.length - 1] : -1,
          pass: passIdx,
          types: all.map(function(i) { return i.type; }).join(',')
        };
      })()
    `).catch(() => null)
  }

  /**
   * Chờ form đăng ký render đủ các ô nhập rồi mới điền.
   * Trang Meta mới hydrate chậm: điền sớm thì giá trị bị React xóa sạch
   * nên combobox (điền sau) lại được mà ô text thì rỗng.
   */
  async waitForRegistrationForm(wc, timeoutMs, log) {
    const started = Date.now()
    let lastWarn = 0
    while (Date.now() - started < timeoutMs) {
      if (this.isAborted) return null
      const idx = await this.getFormInputIndices(wc)
      if (idx && idx.total >= 4 && idx.first !== -1 && idx.last !== -1
          && idx.email !== -1 && idx.pass !== -1) {
        return idx
      }
      if (log && Date.now() - lastWarn > 5000) {
        log(`⏳ Chờ form đăng ký render... (mới thấy ${idx ? idx.total : 0}/${4} ô input)`)
        lastWarn = Date.now()
      }
      await sleep(500)
    }
    return null
  }

  /**
   * Kiểm tra giá trị thật trong ô input sau khi gõ
   */
  async verifyInputValue(wc, inputIdx, expected) {
    return await wc.executeJavaScript(`
      (function() {
        var all = Array.from(document.querySelectorAll('input')).filter(function(i) {
          return i.offsetWidth > 0 && i.type !== 'hidden';
        });
        var el = all[${inputIdx}];
        return !!el && el.value === ${JSON.stringify(String(expected))};
      })()
    `).catch(() => false)
  }

  /**
   * Điền ô input bằng click chuột tọa độ + DÁN cả chuỗi (insertText một phát)
   * 21-10: user chốt dán thay vì gõ người thật — nhanh. insertText thay clipboard thật
   * vì nhiều cửa sổ chạy song song sẽ giành clipboard của nhau.
   * Trả về true CHỈ khi giá trị nằm thật sự trong ô input (đã verify)
   */
  async fillInputByCoord(win, inputIdx, text) {
    const wc = win.webContents
    const coords = await wc.executeJavaScript(`
      (function() {
        var allInp = Array.from(document.querySelectorAll('input')).filter(function(i) {
          return i.offsetWidth > 0 && i.type !== 'hidden';
        });
        var el = allInp[${inputIdx}];
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()
    `).catch(() => null)

    if (!coords) return false

    // Click chuột vào giữa ô input
    await this.mouseClick(wc, coords.x, coords.y)

    // Xóa text cũ nếu có (Ctrl+A rồi Backspace)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await sleep(40)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await sleep(40)

    // Dán cả chuỗi một phát (paste-style)
    await wc.insertText(String(text)).catch(() => {})
    await sleep(200)

    return await this.verifyInputValue(wc, inputIdx, text)
  }

  /**
   * Dự phòng khi click tọa độ không ăn (bị overlay che / focus bị giật mất):
   * Cách 1: focus bằng JS rồi DÁN cả chuỗi (insertText một phát)
   * Cách 2: native setter + dispatch input/change - React onChange bắt được
   */
  async forceFillInput(win, inputIdx, text) {
    const wc = win.webContents
    const val = JSON.stringify(String(text))

    await wc.executeJavaScript(`
      (function() {
        var allInp = Array.from(document.querySelectorAll('input')).filter(function(i) {
          return i.offsetWidth > 0 && i.type !== 'hidden';
        });
        var el = allInp[${inputIdx}];
        if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); if (el.select) el.select(); }
      })()
    `).catch(() => {})
    await sleep(100)
    // Dán cả chuỗi một phát (paste-style)
    await wc.insertText(String(text)).catch(() => {})
    await sleep(300)
    if (await this.verifyInputValue(wc, inputIdx, text)) return true

    return await wc.executeJavaScript(`
      (function() {
        var allInp = Array.from(document.querySelectorAll('input')).filter(function(i) {
          return i.offsetWidth > 0 && i.type !== 'hidden';
        });
        var el = allInp[${inputIdx}];
        if (!el) return false;
        var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, ${val});
        else el.value = ${val};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value === ${val};
      })()
    `).catch(() => false)
  }

  /**
   * Điền 1 ô và xác nhận giá trị GIỮ ĐƯỢC trong ô (không bị framework xóa ngầm).
   * Trang FB thỉnh thoảng xóa giá trị gõ vào nếu chưa hydrate xong, hoặc ăn mất click
   * nên mỗi lần thử kết hợp cả 2 cách: click tọa độ + insertText, rồi JS focus/native setter
   */
  async fillFieldReliably(win, inputIdx, text, label, log) {
    if (inputIdx === undefined || inputIdx === null || inputIdx < 0) {
      log(`✗ ${label}: không tìm thấy ô input trên trang!`)
      return false
    }
    if (win.isDestroyed()) { log(`✗ ${label}: cửa sổ đã bị đóng giữa chừng`); return false }
    const wc = win.webContents
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (this.isAborted) return false
      if (win.isDestroyed()) { log(`✗ ${label}: cửa sổ bị đóng giữa chừng (lần ${attempt})`); return false }

      // Cách 1: điền trực tiếp vào DOM đúng element - không phụ thuộc tọa độ/foreground.
      // Click tọa độ trên VPS/RDP hoặc window ẩn rất hay trượt sang ô khác (điền sai tùm lum)
      let ok = await this.forceFillInput(win, inputIdx, text)
      if (ok) {
        await sleep(1500)
        if (await this.verifyInputValue(wc, inputIdx, text)) {
          log(`✓ ${label} đã điền (giữ giá trị ổn định)${attempt > 1 ? ` - lần thử ${attempt}` : ''}`)
          return true
        }
        log(`⚠ ${label}: giá trị bị xóa ngầm sau khi gõ (trang chưa ổn định)...`)
      }

      // Cách 2 (dự phòng): click tọa độ + insertText. Window ẩn/minimize thì BỆCH không dùng:
      // tọa độ stale + Ctrl+A/Backspace xóa nhầm ô khác
      if (!this.isWindowHidden(win)) {
        ok = await this.fillInputByCoord(win, inputIdx, text)
        if (ok) {
          await sleep(1500)
          if (await this.verifyInputValue(wc, inputIdx, text)) {
            log(`✓ ${label} đã điền (click tọa độ, giữ giá trị ổn định)${attempt > 1 ? ` - lần thử ${attempt}` : ''}`)
            return true
          }
          log(`⚠ ${label}: click tọa độ cũng chưa giữ được giá trị...`)
        }
      }

      log(`⚠ ${label}: lần ${attempt} chưa giữ được giá trị, chờ 1s rồi thử lại...`)
      await sleep(1000)
    }
    log(`✗ ${label}: KHÔNG điền được sau mọi cách!`)
    return false
  }

  /** Cửa sổ ẩn/minimize: sendInputEvent chuột bị rớt, tọa độ stale → phải điền/click qua DOM */
  isWindowHidden(win) {
    try { return !win.isVisible() || win.isMinimized() } catch { return false }
  }

  /**
   * Đọc giá trị đang hiển thị của combobox (so khớp đúng 1 dòng text)
   */
  async verifyComboboxValue(wc, type, expected) {
    return await wc.executeJavaScript(`
      (function() {
        var combos = Array.from(document.querySelectorAll('[role="combobox"]'));
        var targetType = ${JSON.stringify(type)};
        var combo = combos.find(function(c) {
          var t = ((c.getAttribute('aria-label') || '') + ' ' + (c.innerText || '')).toLowerCase();
          return t.includes(targetType);
        });
        if (!combo) return false;
        var target = ${JSON.stringify(String(expected))}.toLowerCase();
        var lines = (combo.innerText || '').split(/\\n/).map(function(s) { return s.trim().toLowerCase(); });
        return lines.indexOf(target) !== -1;
      })()
    `).catch(() => false)
  }

  /**
   * Mở dropdown combobox bằng DOM dispatch (dùng khi cửa sổ ẩn, không click tọa độ được).
   * Option luôn có sẵn 197 cái trong DOM nhưng ẩn - chỉ khi aria-expanded=true mới hiện đúng list.
   * Trả về 'OPENED' | 'ALREADY' (list đang mở sẵn) | 'NOT_OPEN' | 'NO_COMBO'
   */
  async openComboDom(wc, type) {
    const fired = await wc.executeJavaScript(`
      (function() {
        var combos = Array.from(document.querySelectorAll('[role="combobox"]'));
        var targetType = ${JSON.stringify(type)};
        var combo = combos.find(function(c) {
          var t = ((c.getAttribute('aria-label') || '') + ' ' + (c.innerText || '')).toLowerCase();
          return t.includes(targetType);
        });
        if (!combo) return 'NO_COMBO';
        if (combo.getAttribute('aria-expanded') === 'true') return 'ALREADY';
        combo.scrollIntoView({ block: 'center' });
        var r = combo.getBoundingClientRect();
        var cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
        ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function(ev) {
          combo.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
        });
        return 'FIRED';
      })()
    `).catch(() => 'NO_COMBO')
    if (fired !== 'FIRED' && fired !== 'ALREADY') return fired
    await sleep(350)
    return await wc.executeJavaScript(`
      (function() {
        var combos = Array.from(document.querySelectorAll('[role="combobox"]'));
        var targetType = ${JSON.stringify(type)};
        var combo = combos.find(function(c) {
          var t = ((c.getAttribute('aria-label') || '') + ' ' + (c.innerText || '')).toLowerCase();
          return t.includes(targetType);
        });
        if (!combo) return 'NO_COMBO';
        return combo.getAttribute('aria-expanded') === 'true' ? 'OPENED' : 'NOT_OPEN';
      })()
    `).catch(() => 'NO_COMBO')
  }

  /**
   * Click chọn option đang hiển thị bằng DOM dispatch (cửa sổ ẩn).
   * CHỈ đếm option visible (offsetWidth>0) - 197 option ẩn luôn nằm trong DOM, click vào chúng vô ích
   */
  async pickOptionDom(wc, val) {
    return await wc.executeJavaScript(`
      (function() {
        var opts = Array.from(document.querySelectorAll('[role="option"]')).filter(function(o) {
          return o.offsetWidth > 0 && o.offsetHeight > 0;
        });
        var targetVal = ${JSON.stringify(String(val))}.toLowerCase();
        var opt = opts.find(function(o) {
          return (o.innerText || '').trim().toLowerCase() === targetVal;
        });
        if (!opt) return false;
        opt.scrollIntoView({ block: 'nearest' });
        var r = opt.getBoundingClientRect();
        var cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
        ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function(ev) {
          opt.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
        });
        return true;
      })()
    `).catch(() => false)
  }

  /**
   * Bấm nút Submit bằng JS click (cửa sổ ẩn) - cùng từ khóa với findSubmitCoord
   * Trả về text nút nếu bấm được
   */
  async clickSubmitDom(wc) {
    return await wc.executeJavaScript(`
      (function() {
        var btns = Array.from(document.querySelectorAll('[role="button"], button, input[type="submit"]'));
        var words = ['submit', 'sign up', 'register', 'tiếp tục', 'tiếp theo', 'đăng ký'];
        for (var b of btns) {
          var t = (b.innerText || b.textContent || b.value || '').trim().toLowerCase();
          for (var w of words) {
            if (t === w || t.includes(w)) { b.click(); return t; }
          }
        }
        return '';
      })()
    `).catch(() => '')
  }

  /**
   * Chọn dropdown bằng click chuột tọa độ thật (Combobox -> Option)
   * Dropdown FB đôi khi ăn mất click nên chọn xong phải verify giá trị hiển thị, sai thì thử lại
   */
  async selectComboByCoord(win, type, val, log) {
    if (win.isDestroyed()) { if (log) log(`⚠ Cửa sổ đã bị đóng giữa chừng — bỏ chọn ${type}`); return false }
    const wc = win.webContents
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.isAborted) return false
      if (win.isDestroyed()) { if (log) log(`⚠ Cửa sổ bị đóng lúc chọn ${type} (lần ${attempt})`); return false }

      // Cách 1: mở + chọn qua DOM - không phụ thuộc tọa độ/foreground (VPS/RDP click tọa độ hay trượt)
      const st = await this.openComboDom(wc, type)
      if (st === 'OPENED' || st === 'ALREADY') {
        if (st === 'OPENED') await sleep(250)
        const picked = await this.pickOptionDom(wc, val)
        await sleep(250)
        if (picked && (await this.verifyComboboxValue(wc, type, val))) {
          if (log) log(`✓ Đã chọn ${type}: "${val}"${attempt > 1 ? ` - lần thử ${attempt}` : ''}`)
          return true
        }
      }

      // Cách 2 (dự phòng): click tọa độ thật - chỉ khi cửa sổ đang hiện
      if (!this.isWindowHidden(win)) {
        // 1. Lấy tọa độ combobox
        const comboCoords = await wc.executeJavaScript(`
          (function() {
            var combos = Array.from(document.querySelectorAll('[role="combobox"]'));
            var targetType = ${JSON.stringify(type)};
            var combo = combos.find(function(c) {
              var t = ((c.getAttribute('aria-label') || '') + ' ' + (c.innerText || '')).toLowerCase();
              return t.includes(targetType);
            });
            if (!combo) return null;
            combo.scrollIntoView({ block: 'center' });
            var r = combo.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()
        `).catch(() => null)

        if (!comboCoords) {
          if (log) log(`⚠ Không tìm thấy combobox ${type} bằng tọa độ, thử lại...`)
          await sleep(600)
          continue
        }

        // Click mở dropdown
        await this.mouseClick(wc, comboCoords.x, comboCoords.y)
        await sleep(400)

        // 2. Lấy tọa độ option cần chọn - CHỈ option visible (197 option ẩn luôn nằm trong DOM,
        // click vào chúng là nguyên nhân "click xong nhưng giá trị chưa hiển thị")
        const optCoords = await wc.executeJavaScript(`
          (function() {
            var opts = Array.from(document.querySelectorAll('[role="option"]')).filter(function(o) {
              return o.offsetWidth > 0 && o.offsetHeight > 0;
            });
            var targetVal = ${JSON.stringify(String(val))}.toLowerCase();
            var opt = opts.find(function(o) {
              return (o.innerText || '').trim().toLowerCase() === targetVal;
            });
            if (!opt) return null;
            opt.scrollIntoView({ block: 'nearest' });
            var r = opt.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()
        `).catch(() => null)

        if (optCoords) {
          await this.mouseClick(wc, optCoords.x, optCoords.y)
          await sleep(300)
          if (await this.verifyComboboxValue(wc, type, val)) {
            if (log) log(`✓ Đã chọn ${type}: "${val}"${attempt > 1 ? ` - lần thử ${attempt}` : ''}`)
            return true
          }
          if (log) log(`⚠ ${type}: click xong nhưng giá trị chưa hiển thị, thử lại...`)
        } else {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          if (log) log(`⚠ Không tìm thấy option ${type}: "${val}", thử lại...`)
        }
      }

      if (log) log(`⚠ ${type}: chọn dropdown lần ${attempt} chưa ăn, thử lại...`)
      await sleep(600)
    }
    if (log) log(`✗ Không chọn được ${type}: "${val}" sau 3 lần thử`)
    return false
  }

  /**
   * Tìm tọa độ nút Submit trên form đăng ký
   */
  async findSubmitCoord(wc) {
    return await wc.executeJavaScript(`
      (function() {
        var btns = Array.from(document.querySelectorAll('[role="button"], button, input[type="submit"]'));
        var words = ['submit', 'sign up', 'register', 'tiếp tục', 'tiếp theo', 'đăng ký'];

        for (var b of btns) {
          var t = (b.innerText || b.textContent || b.value || '').trim().toLowerCase();
          for (var w of words) {
            if (t === w || t.includes(w)) {
              b.scrollIntoView({ block: 'center' });
              var r = b.getBoundingClientRect();
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t };
            }
          }
        }
        return null;
      })()
    `).catch(() => null)
  }

  /**
   * Đăng ký 1 tài khoản Facebook
   */
  async registerSingleAccount({
    mode = 'tempmail',
    domain = null,
    emailProvider = 'tempmailapi',
    smsOperator = null,
    showBrowser = true,
    proxy = null,
    proxyAuth = null,
    proxyGeo = null,
    slot = 0,
    regVia = 'web',
    gmailVariant = 'plus',
    gmailCookie = '',
    onLog = () => {}
  } = {}) {
    this.isAborted = false
    // regVia: 'web' (www.facebook.com) | 'mobile' (m.facebook.com) | 'both' (ngẫu nhiên mỗi nick)
    const via = regVia === 'mobile' ? 'mobile' : regVia === 'both' ? (Math.random() < 0.5 ? 'web' : 'mobile') : 'web'
    this._regProxyKey = proxy || 'home-ip'  // key xếp hàng tạo email tempemail.cc (rate limit theo IP)
    this._gmailVariant = gmailVariant
    const log = (msg) => {
      const time = new Date().toLocaleTimeString('vi-VN')
      onLog(`[${time}] ${msg}`)
      // Bản sao log ra file để chẩn đoán ngoài app (reg_debug_log.txt cạnh source)
      try {
        fs.appendFileSync(path.join(__dirname, 'reg_debug_log.txt'),
          `[${new Date().toLocaleString('vi-VN', { hour12: false })}] ${msg}\n`, 'utf8')
      } catch {}
    }
    log(`🧭 v2 trace: emailProvider=${emailProvider} | gmailCookie=${gmailCookie ? gmailCookie.length + ' ký tự' : 'TRỐNG'} | gmailVariant=${gmailVariant}`)
    if (regVia === 'both') log(`🔀 Reg "Cả 2": nick này dùng ${via === 'mobile' ? 'MOBILE (m.facebook.com)' : 'WEB (www.facebook.com)'}`)

    let email = null
    let sidToken = null
    let smsOrderId = null
    let displayPhone = null
    let localPhone = null
    let gmailWin = null  // v2: cửa sổ Gmail (cookie từ IMPORT) — đọc OTP trực tiếp từ inbox
    let gmailRelease = null  // nhả khóa Gmail khi reg xong (cửa sổ GIỮ NGUYÊN không tắt)
    let gmailCloseToo = false  // reg ra CHECKPOINT -> tắt CẢ cửa sổ Gmail theo (yêu cầu 25-10)
    let baseGmail = ''   // v2: địa chỉ gmail gốc đọc từ trang (sinh variant)
    const oldSmsCodes = new Set()

    // Hủy số đã thuê (refund) khi đăng ký thất bại trước khi nhận SMS
    const releaseSms = async (why) => {
      if (smsOrderId) {
        log(`📞 Hủy số đã thuê ${localPhone || displayPhone} (${why}) - yêu cầu hoàn tiền SMSPVA...`)
        await this.sms.cancelOrder(smsOrderId)
        smsOrderId = null
      }
    }

    if (mode === 'sms') {
      // 1a. Thuê số điện thoại từ SMSPVA (thử tối đa 3 lần)
      let lastNumErr = null
      for (let numTry = 1; numTry <= 3; numTry++) {
        try {
          if (numTry > 1) log(`🔁 Thử lấy số điện thoại lại lần ${numTry}/3...`)
          const num = await this.sms.requestNumber({ operator: smsOperator, log })
          smsOrderId = num.orderId
          displayPhone = num.displayPhone
          localPhone = num.localPhone || (String(num.phoneNumber || '').startsWith('0') ? num.phoneNumber : '0' + num.phoneNumber)
          log(`✓ Số điện thoại thuê được: ${localPhone} (dạng quốc tế ${displayPhone}, nhà mạng ${num.operator}, Order ${num.orderId})`)
          break
        } catch (err) {
          lastNumErr = err
          log(`✗ Lỗi lấy số điện thoại (lần ${numTry}/3): ${err.message}`)
          if (numTry < 3) await sleep(2000)
        }
      }
      if (!smsOrderId) {
        return { success: false, status: 'ERROR', error: lastNumErr ? lastNumErr.message : 'Không thuê được số từ SMSPVA' }
      }
      email = displayPhone

      // Chặn SMS cũ: đọc 1 lần SMS đang nằm sẵn trên số làm mốc (số bị tái sử dụng
      // có thể còn SMS của người thuê trước -> trả về ngay sau Submit, fill vào là FB báo sai mã)
      const preOtp = await this.sms.peekOtp(smsOrderId, { log }).catch(() => null)
      if (preOtp) {
        oldSmsCodes.add(preOtp)
        log(`ℹ Số này đang có SMS cũ (mã ${preOtp}) - sẽ bỏ qua, chỉ nhận SMS mới FB gửi sau khi Submit`)
      } else {
        log('ℹ Mốc SMS: lúc thuê số chưa đọc được SMS cũ nào (chưa có hoặc lỗi đọc)')
      }
    } else if (emailProvider === 'gmail' && gmailCookie) {
      // ── Reg v2 COOKIE GMAIL: mở cửa sổ Gmail nạp cookie từ IMPORT -> đọc base gmail -> sinh variant
      log('📧 v2: mở Gmail bằng cookie nạp từ IMPORT...')
      const gRes = await this.openGmailSession({ gmailCookie, slot, showBrowser, log })
      if (!gRes.ok) {
        return { success: false, status: 'ERROR', error: gRes.error }
      }
      gmailWin = gRes.win
      gmailRelease = gRes.release || null
      baseGmail = gRes.baseGmail
      email = makeGmailVariant(baseGmail, this._gmailVariant || 'plus', this)
      sidToken = JSON.stringify({ v: email })
      log(`✓ Email (gmail variant từ cookie ${baseGmail}): ${email}`)
    } else {
      // 1b. Tạo Email từ provider đã chọn
      const mailClient = emailProvider === 'tempmailid'    ? this.tempmailId
                       : emailProvider === 'mailtm'        ? this.mailTm
                       : emailProvider === 'mailtd'        ? this.mailTd
                       : emailProvider === 'tempmailv2'    ? this.tempmailV2
    : emailProvider === 'mailown'    ? this.mailOwn
    : emailProvider === 'gmail'    ? this.gmail
    : emailProvider === 'customdomain'  ? this.customDomain
                       : this.tempmail
      const providerName = emailProvider === 'tempmailid'   ? 'tempmail.id.vn'
                         : emailProvider === 'mailtm'       ? 'mail.tm'
                         : emailProvider === 'mailtd'       ? 'mail.td'
                         : emailProvider === 'mailown'       ? 'mail-own (VPS)'
       : emailProvider === 'gmail'       ? 'gmail dot/plus'
                         : emailProvider === 'customdomain' ? ('custom:' + (process.env.CUSTOM_DOMAIN || 'yourdomain.com'))
                         : 'tempmailapi.io.vn'
      let lastMailErr = null
      for (let mailTry = 1; mailTry <= 3; mailTry++) {
        try {
          if (mailTry > 1) log(`🔁 Thử tạo email lại lần ${mailTry}/3...`)
          // tempemail.cc rate limit theo IP: mỗi luồng xếp hàng theo proxy của chính nó
          if (mailClient === this.tempmailV2) mailClient.queueKey = proxy || 'home-ip'
          if (mailClient === this.gmail) mailClient.variantMode = this._gmailVariant || 'plus'
          const emailData = await mailClient.createEmail(domain)
          email = emailData.email
          sidToken = emailData.sidToken
          log(`✓ Email (${providerName}): ${email}`)
          break
        } catch (err) {
          lastMailErr = err
          log(`✗ Lỗi tạo email (lần ${mailTry}/3): ${err.message}`)
          if (mailTry < 3) await sleep(2000)
        }
      }
      if (!email) {
        return { success: false, status: 'ERROR', error: lastMailErr ? lastMailErr.message : `Không tạo được email ${providerName}` }
      }
    }

    // Hiển thị/xuất: SMS mode dùng số nội địa 0... (không dùng +84)
    const contactDisplay = mode === 'sms' ? (localPhone || email) : email
    const contactLabel = mode === 'sms' ? 'Số điện thoại' : 'Email'

    // 2. Tạo thông tin ngẫu nhiên — tên/timezone khớp quốc gia proxy
    const countryCode = (proxyGeo && proxyGeo.countryCode) ? proxyGeo.countryCode.toUpperCase() : 'DEFAULT'
    const timezone    = TIMEZONE_MAP[countryCode] || 'America/New_York'
    const names       = getNamesForCountry(countryCode)
    const firstName = getRandomItem(names.first)
    const lastName  = getRandomItem(names.last)
    const fullName  = `${firstName} ${lastName}`
    const birthYear  = getRandomInt(1978, 2001) // rộng hơn 1992-2002 cũ, tự nhiên hơn
    const birthMonth = getRandomInt(1, 12)
    const birthDay   = getRandomInt(1, 28)
    const gender     = Math.random() > 0.5 ? '2' : '1'
    const genderStr  = gender === '2' ? 'Male' : 'Female'
    const password   = generateRandomPassword()

    const monthNames = ["January","February","March","April","May","June",
      "July","August","September","October","November","December"]
    const mName = monthNames[birthMonth - 1]

    log(`👤 Thông tin: ${fullName} | Ngày sinh: ${birthDay}/${birthMonth}/${birthYear} | Giới tính: ${gender === '2' ? 'Nam' : 'Nữ'} | Quốc gia proxy: ${countryCode} | Timezone: ${timezone}`)
    log(`🔑 Password: ${password}`)

    // 3. Khởi tạo trình duyệt: Chrome THẬT qua CDP (kiểu AUTO_BM) hoặc cửa sổ Electron
    // Random User-Agent mỗi phiên — mobile reg dùng UA mobile khớp m.facebook.com
    const pickedUA = via === 'mobile'
      ? UA_MOBILE_LIST[Math.floor(Math.random() * UA_MOBILE_LIST.length)]
      : UA_LIST[Math.floor(Math.random() * UA_LIST.length)]
    const actualW = 430
    const actualH = 830

    let ses = null
    let win = null
    if (this.useRealChrome) {
      try {
        // 21-10: user chốt reg LUÔN tiếng Anh — selector combobox/submit dựa trên nhãn
        // tiếng Anh (Day/Month/Year/Gender, Submit); trang tiếng Việt làm hỏng toàn bộ matching
        const realLang = 'en-US,en;q=0.9'
        const real = await createRealChromeSession({
          showBrowser, slot, proxy, proxyAuth, userAgent: pickedUA, lang: realLang,
          mobile: via === 'mobile', log
        })
        ses = real.ses
        win = real.win
        log('🕶️ Chrome thật (chrome.exe qua CDP): UA không dính Electron, navigator.webdriver=false tự nhiên')
      } catch (rcErr) {
        log(`⚠ Chrome thật không chạy được (${rcErr.message}) - phiên này dùng cửa sổ Electron, phiên sau thử lại Chrome thật`)
      }
    }
    if (!win) {
      // Partition KHÔNG có prefix persist: -> session chỉ nằm trong RAM, không ghi
      // cookie/localStorage ra đĩa (giống Chrome ẩn danh thật, app chết cũng không còn vết)
      // Partition phải duy nhất tuyệt đối: chạy đa luồng thì 2 engine có thể khởi tạo cùng ms
      const partitionName = `fbreg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      ses = session.fromPartition(partitionName)
      log('🕶️ Phiên ẩn danh: session chỉ nằm trong RAM, không lưu cookie ra ổ đĩa')

      if (proxy && proxy.trim()) {
        try {
          await ses.setProxy({ mode: 'fixed_servers', proxyRules: proxy.trim() })
          log(`🌐 Proxy áp dụng cho phiên này: ${proxy.trim()}`)
        } catch (pe) {
          log(`⚠ Proxy lỗi: ${pe.message}`)
        }
      }

      incognitoThemeOn()
      // AUTO_BM technique: Mobile phone size (430x830) khớp với mobile UA
      // FB ít kiểm gắt với mobile registration hơn desktop r.php
      // 21-10: xếp cửa sổ theo lưới theo slot (giống Chrome thật) — 4 cửa sổ/hàng
      const posX = 60 + (slot % 4) * 445
      const posY = 40 + Math.floor(slot / 4) * 850
      // 25-10 fix "ẩn chrome bị mù": show:false khiến renderer không focus/không nhận
      // input -> DOM điền mù, tự ngắt. Giờ LUÔN show nhưng khi ẩn chế độ thì ĐẨY CỬA SỔ
      // RA NGOÀI MÀN HÌNH (off-screen) — Chromium vẫn render/focus đủ, user không thấy.
      const showIt = Boolean(showBrowser)
      let wx = posX, wy = posY
      if (!showIt) {
        try {
          const wa = screen.getPrimaryDisplay().workArea
          wx = wa.x + wa.width + 60 + (slot % 4) * 40
          wy = wa.y + 40
        } catch {}
      }
      win = new BrowserWindow({
        x: wx,
        y: wy,
        width: 430,
        height: 830,
        show: true,
        skipTaskbar: !showIt,
        backgroundColor: '#202124',
        title: `Auto Reg FB - ${email}`,
        webPreferences: {
          session: ses,
          nodeIntegration: false,
          contextIsolation: false,
          backgroundThrottling: false,
          // AUTO_BM kỹ thuật #1: --disable-blink-features=AutomationControlled
          // Xóa navigator.webdriver flag mà Chrome tự set khi chạy dưới automation
          // Đây là flag QUAN TRỌNG NHẤT - FB check cái này đầu tiên
          additionalArguments: ['--disable-blink-features=AutomationControlled']
        }
      })
    }

    ses.setUserAgent(pickedUA)
    log(`🕵️ User-Agent: ${pickedUA.slice(0, 80)}...`)

    // Inject fingerprint script NGAY KHI bắt đầu load trang (trước khi FB chạy JS)
    // Inject trên NHIỀU sự kiện để đảm bảo chạy trước FB đọc fingerprint kể cả SPA navigation
    const fingerprintScript = buildFingerprintScript(timezone) + (via === 'mobile' ? `
// ── Mobile patch: fake touch + platform (KHÔNG dùng CDP setDeviceMetricsOverride —
//    lệnh đó làm CRASH renderer Electron; UA mobile + touch flags là đủ cho m.facebook.com) ──
;(function(){
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: function() { return 5 } });
    Object.defineProperty(navigator, 'platform', { get: function() { return ${pickedUA && pickedUA.indexOf('iPhone') !== -1 ? "'iPhone'" : "'Linux armv8l'"} } });
    window.ontouchstart = function(){};
    var mq = window.matchMedia('(pointer: coarse)').matches;
    if (!mq) { try { window.matchMedia = function(orig){ return function(q){ var r = orig.call(window, q); if (q && q.indexOf('pointer: coarse') !== -1) r.matches = true; return r; } }(window.matchMedia); } catch (e) {} }
  } catch (e) {}
})();` : '')
    win.webContents.on('did-start-loading', () => {
      win.webContents.executeJavaScript(fingerprintScript).catch(() => {})
    })
    win.webContents.on('dom-ready', () => {
      win.webContents.executeJavaScript(fingerprintScript).catch(() => {})
    })
    win.webContents.on('did-frame-navigate-in-page', () => {
      win.webContents.executeJavaScript(fingerprintScript).catch(() => {})
    })
    // Chẩn đoán 24-10: "(không đọc được DOM)" sau Submit — bắt sự kiện tải fail/renderer
    // chết để phân biệt trang trắng do proxy (did-fail-load) với renderer sập (render-process-gone)
    win.webContents.on('did-fail-load', (ev, code, desc, url, isMain) => {
      if (isMain && code !== -3) log(`⚠ did-fail-load (${code} ${desc}) ${url || ''}`)
    })
    win.webContents.on('render-process-gone', (ev, d) => {
      log(`❌ render-process-gone: reason=${d && d.reason} exitCode=${d && d.exitCode} — mọi executeJavaScript sẽ fail cho tới khi trang mới tải xong`)
    })

    // ── AUTO_BM kỹ thuật #2: CDP Emulation.setTimezoneOverride + setGeolocationOverride ──
    // AUTO_BM inject timezone + lat/lon qua CDP ngay khi CDP sẵn sàng
    // Electron: dùng debugger.attach + sendCommand thay vì WebSocket như Python
    // 21-10: luôn en-US (user chốt tiếng Anh) — Accept-Language vi-VN khiến FB render
    // form tiếng Việt (Ngày/Tháng/Năm/Gửi) và toàn bộ selector nhãn tiếng Anh fail
    const langHeader = 'en-US,en;q=0.9'
    // Lat/lon xấp xỉ theo timezone
    const geoCoords = {
      'Asia/Ho_Chi_Minh': { latitude: 10.762, longitude: 106.660 },
      'Asia/Bangkok':     { latitude: 13.756, longitude: 100.502 },
      'Asia/Singapore':   { latitude: 1.352,  longitude: 103.820 },
      'Asia/Manila':      { latitude: 14.599, longitude: 120.984 },
      'America/New_York': { latitude: 40.713, longitude: -74.006 },
      'Europe/London':    { latitude: 51.507, longitude: -0.128  },
    }
    const geoPos = geoCoords[timezone] || { latitude: 10.762, longitude: 106.660 }

    try {
      win.webContents.debugger.attach('1.3')
      // 25-10: đa luồng Electron hay detach CDP giữa chừng -> không để văng lỗi chết phiên,
      // tự attach lại + phục hồi timezone/lang
      try {
        win.webContents.debugger.on('detach', (ev, reason) => {
          log(`⚠ CDP debugger detach (${reason || 'lý do ?'}) — thử attach lại...`)
          setTimeout(() => {
            try {
              if (!win.isDestroyed() && !win.webContents.debugger.isAttached()) {
                win.webContents.debugger.attach('1.3')
                win.webContents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: timezone }).catch(() => {})
                win.webContents.debugger.sendCommand('Network.enable').catch(() => {})
                win.webContents.debugger.sendCommand('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': langHeader } }).catch(() => {})
                log('✅ Đã attach lại CDP debugger')
              }
            } catch {}
          }, 1000)
        })
      } catch {}
      win.webContents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: timezone }).catch(() => {})
      win.webContents.debugger.sendCommand('Emulation.setGeolocationOverride', {
        latitude: geoPos.latitude, longitude: geoPos.longitude, accuracy: 100
      }).catch(() => {})
      // Mobile reg trên cửa sổ ELECTRON: CHỈ dùng lệnh an toàn. setDeviceMetricsOverride/
      // setEmitTouchEventsForMouse làm crash rendererElectron (đá văng cả app 21-10) —
      // touch/platform đã fake bằng script inject trong fingerprintScript
      if (via === 'mobile') {
        win.webContents.debugger.sendCommand('Network.setUserAgentOverride', {
          userAgent: pickedUA,
          platform: pickedUA && pickedUA.indexOf('iPhone') !== -1 ? 'iPhone' : 'Linux armv8l'
        }).catch(() => {})
        log('📱 Mobile ELECTRON: UA + platform override qua CDP (an toàn), touch fake bằng script — không device metrics (tránh crash)')
      }
      // Fake Accept-Language header khớp với country của proxy (AUTO_BM dùng --lang= arg)
      win.webContents.debugger.sendCommand('Network.enable').catch(() => {})
      win.webContents.debugger.sendCommand('Network.setExtraHTTPHeaders', {
        headers: { 'Accept-Language': langHeader }
      }).catch(() => {})
      // AUTO_BM kỹ thuật #3 (MẠNH NHẤT): Page.addScriptToEvaluateOnNewDocument
      // Script chạy TRƯỚC KHI BẤT KỲ JS NÀO của trang (kể cả FB script đầu tiên)
      // Mạnh hơn executeJavaScript vì không có timing gap để FB detect
      // Guard 21-10: Electron 28 bug — nhiều session song song thì promise này bị drop
      // (không bao giờ resolve) → await treo vĩnh viễn → màn hình đen. Race 10s: hết giờ
      // thì bỏ qua và chạy tiếp (fingerprint vẫn inject qua did-start-loading bên dưới).
      const addScriptRes = await Promise.race([
        win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: fingerprintScript
        }).then(() => 'ok').catch(() => 'err'),
        new Promise((r) => setTimeout(() => r('timeout'), 10000)),
      ])
      if (addScriptRes !== 'ok') {
        log(`⚠ CDP addScriptToEvaluateOnNewDocument ${addScriptRes === 'timeout' ? 'TREO (bug Electron CDP multi-session)' : 'lỗi'} — vẫn chạy tiếp, inject qua executeJavaScript`)
      }
      log(`🌍 CDP Emulation: timezone=${timezone}, lat=${geoPos.latitude}, lon=${geoPos.longitude}, lang=${langHeader.slice(0,10)}`)
      if (addScriptRes === 'ok') {
        log('🛡️ CDP addScriptToEvaluateOnNewDocument: stealth inject TRƯỚC tất cả JS của FB')
      }
    } catch (dbgErr) {
      log(`⚠ Không attach được CDP debugger: ${dbgErr.message} - bỏ qua Emulation override`)
    }

    log(`🔒 Anti-fingerprint inject: timezone=${timezone}, screen=${actualW}x${actualH}, +AutomationControlled disabled, +CDP Emulation`)
    this.activeWindows.push(win)
    const wc = win.webContents

    let cleanupDone = false
    const cleanup = async () => {
      if (cleanupDone) return
      cleanupDone = true
      // destroy() thay close(): trang FB có thể chặn close bằng beforeunload -> renderer không chết
      try { if (!win.isDestroyed()) win.destroy() } catch {}
      // v2: KHÔNG tắt cửa sổ Gmail (yêu cầu 25-10) — giữ session sống cho lần reg sau
      // dùng lại; NHƯNG nếu reg ra CHECKPOINT thì tắt cả Gmail theo Chrome FB
      if (gmailWin && !gmailWin.isDestroyed()) {
        if (gmailCloseToo) {
          try { gmailWin.destroy() } catch {}
          if (this._gmailHash) gmailLiveWindows.delete(this._gmailHash)
        } else {
          try { if (!gmailWin.isVisible()) gmailWin.hide() } catch {}
        }
      }
      if (gmailRelease) { try { gmailRelease() } catch {} }
      gmailWin = null
      gmailRelease = null
      const idx = this.activeWindows.indexOf(win)
      if (idx !== -1) this.activeWindows.splice(idx, 1)
      incognitoThemeOff()
      // Chrome thật: destroy() đã kill Chrome + XÓA SẠCH profile dir — clearStorageData/clearCache
      // qua CDP đã đóng chỉ treo vĩnh viễn (test E2E 20-10 bắt được) → bỏ hẳn với Chrome thật
      if (!win._isRealChrome) {
        // 24-10: clearStorageData/clearCache trên session RAM có thể TREO vĩnh viễn
        // (15:28:38 — bấm Dừng xong app im lặng 2 phút) → race timeout, treo thì bỏ qua
        await Promise.race([ses.clearStorageData(), sleep(8000)]).catch(() => {})
        await Promise.race([ses.clearCache(), sleep(8000)]).catch(() => {})
      }
    }

    try {
      if (!proxy || !proxy.trim()) {
        log('⚠ Phiên này KHÔNG dùng proxy - reg bằng IP máy thật, FB rất hay từ chối ("An error occurred") và số thuê sẽ bị đốt tiền!')
      } else {
        // Kiểm chứng proxy thật sự đi qua Chrome này: nạp trang echo IP và đọc IP ra.
        // setProxy thành công KHÔNG có nghĩa là traffic đã đi qua proxy - phải đo bằng chứng thực.
        const proxyHost = String(proxy.trim()).replace(/^.*@/, '').split(':')[0]
        try {
          await Promise.race([
            win.loadURL('https://api.ipify.org/?format=json'),
            new Promise((_, rej) => setTimeout(() => rej(new Error('quá 20s không phản hồi')), 20000))
          ])
          await sleep(800)
          const raw = await wc.executeJavaScript(`(document.body ? document.body.innerText : '').trim()`).catch(() => '')
          const m = String(raw).match(/(\d{1,3}(?:\.\d{1,3}){3})/)
          const exitIp = m ? m[1] : ''
          if (exitIp && exitIp === proxyHost) {
            log(`✓ Proxy đã kết nối vào Chrome: IP ra ngoài = ${exitIp}`)
          } else if (exitIp) {
            log(`⚠ IP ra ngoài từ Chrome = ${exitIp} KHÁC IP proxy (${proxyHost}) - proxy không áp dụng, FB đang thấy IP khác!`)
          } else {
            log(`⚠ Không đọc được IP ra ngoài qua proxy ${proxyHost} (trang echo không tải được) - proxy có thể chết hoặc chặn trang echo`)
          }
        } catch (e) {
          log(`⚠ Không kiểm tra được IP qua proxy ${proxyHost} (${e.message}) - vẫn tiếp tục reg`)
        }
      }
      // 21-10: user chốt BỎ warm-up — vào thẳng link reg (warm-up hiện trang login ~20s
      // và FB vẫn từ chối reg như thường, vô ích)
      if (this.isAborted) {
        await releaseSms('bot bị dừng')
        await cleanup()
        return { success: false, status: 'ABORTED', error: 'Đã hủy' }
      }

      // ── URL vào thẳng theo yêu cầu user 21-10: web r.php?__mmr=1&_rdr, mobile m.facebook.com ──
      const REG_URLS = via === 'mobile'
        ? [
            { url: 'https://m.facebook.com/reg/?locale=en_US', label: 'm.facebook /reg (mobile UA)' },
            { url: 'https://m.facebook.com/r.php?locale=en_US', label: 'm.facebook r.php (mobile UA)' },
            { url: 'https://mbasic.facebook.com/r.php?locale=en_US', label: 'mbasic r.php (dự phòng)' },
          ]
        : [
            { url: 'https://www.facebook.com/r.php?__mmr=1&_rdr', label: 'www (__mmr=1&_rdr)' },
          ]

      let regUrl = REG_URLS[0].url
      let regLabel = REG_URLS[0].label

      // Thử lần lượt từng endpoint cho đến khi tải được form
      let outcome = 'TIMEOUT'
      for (const endpoint of REG_URLS) {
        if (this.isAborted) break
        log(`🌐 Thử endpoint ${endpoint.label}: ${endpoint.url}`)
        regUrl = endpoint.url
        regLabel = endpoint.label
        const loadP = win.loadURL(endpoint.url)
        loadP.catch(() => {})
        outcome = await Promise.race([
          loadP.then(() => 'LOADED', e => 'ERR:' + (e.message || e.errorDescription || 'không rõ')),
          new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 45000))
        ])
        // Mobile: trang intro "Join Facebook" — bấm Get started bằng CLICK VẬT LÝ
        // (form wbloks của Meta không ăn DOM .click() — phải mouseDown/Up tọa độ)
        // LƯU Ý: match kiểu contains trên aria-label và innerText RIÊNG từng cái —
        // ghép chuỗi rồi so exact sẽ fail ("get started get started" !== "get started")
        if (via === 'mobile' && outcome === 'LOADED') {
          const btnPos = await wc.executeJavaScript(`(function(){
            var els = Array.from(document.querySelectorAll('[role="button"], button, a, input[type="button"], input[type="submit"]'));
            for (var i = 0; i < els.length; i++) {
              var e = els[i];
              var r = e.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) continue;
              var al = (e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().toLowerCase();
              var tx = ((e.innerText || e.textContent || e.value || '') + '').replace(/\\s+/g, ' ').trim().toLowerCase();
              var hit = al.indexOf('get started') !== -1 || tx.indexOf('get started') !== -1
                || tx.indexOf('create new account') !== -1 || tx.indexOf('tạo tài khoản mới') !== -1
                || al.indexOf('create new account') !== -1;
              if (hit) {
                e.scrollIntoView({block: 'center'});
                var r2 = e.getBoundingClientRect();
                return {x: Math.round(r2.left + r2.width/2), y: Math.round(r2.top + r2.height/2), tx: tx.substring(0, 30)};
              }
            }
            return null;
          })()`).catch(() => null)
          if (btnPos) {
            wc.sendInputEvent({ type: 'mouseDown', x: btnPos.x, y: btnPos.y, button: 'left', clickCount: 1 })
            await sleep(70)
            wc.sendInputEvent({ type: 'mouseUp', x: btnPos.x, y: btnPos.y, button: 'left', clickCount: 1 })
            log(`👉 Mobile: bấm "Get started" (click vật lý: ${btnPos.tx})...`)
            await sleep(4000)
          }
        }
        // Kiểm tra form: WEB yêu cầu >=3 input; MOBILE form từng màn (màn đầu chỉ 2 ô tên) —
        // coi là mở khi nút intro biến mất và có input hoặc nút Next/Continue/First name
        // executeJavaScript có thể TREO VĨNH VIỄN nếu trang/proxy treo giữa chừng -> race 15s
        const hasForm = await Promise.race([
          wc.executeJavaScript(via === 'mobile' ? `(function(){
          var intro = Array.from(document.querySelectorAll('[role="button"], button')).find(function(b){
            var t = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
            return t === 'get started' || t === 'create new account' || t === 'tạo tài khoản mới';
          });
          if (intro) return false; // vẫn màn intro — chưa vào form
          var ins = document.querySelectorAll('input').length;
          var next = Array.from(document.querySelectorAll('[role="button"], button')).some(function(b){
            var al = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toLowerCase();
            return al.indexOf('next') !== -1 || al.indexOf('continue') !== -1 || al.indexOf('first name') !== -1;
          });
          return ins >= 1 || next;
        })()` : `document.querySelectorAll('input').length >= 3 && (document.body.innerText||'').length > 50`),
          sleep(15000).then(() => false)
        ]).catch(() => false)
        if (outcome === 'LOADED' && hasForm) {
          // Mobile: FB hay redirect m. -> www (khi đó form là bản web) — phát hiện và thử endpoint sau
          if (via === 'mobile') {
            const host = await wc.executeJavaScript('location.host').catch(() => '')
            if (host && !host.startsWith('m.') && !host.startsWith('mbasic')) {
              log(`⚠ Endpoint ${endpoint.label} bị FB redirect về ${host} (form web) - thử endpoint mobile tiếp theo...`)
              await sleep(800)
              continue
            }
          }
          log(`✓ Endpoint ${endpoint.label} tải được form đăng ký${via === 'mobile' ? ' (MOBILE)' : ''}`)
          break
        }
        log(`⚠ Endpoint ${endpoint.label} không tải được form (outcome=${outcome}, hasForm=${hasForm}) - thử endpoint tiếp theo...`)
        await sleep(800)
      }
      if (this.isAborted) {
        await releaseSms('bot bị dừng')
        await cleanup()
        return { success: false, status: 'ABORTED', error: 'Đã hủy' }
      }

      if (outcome !== 'LOADED') {
        const domOk = await wc.executeJavaScript(`document.querySelectorAll('input').length >= 4 && (document.body.innerText||'').length > 100`).catch(() => false)
        if (!domOk) {
          throw new Error(`Proxy không tải được trang đăng ký Facebook (${outcome === 'TIMEOUT' ? 'quá 60s không phản hồi' : outcome.slice(4)}). Proxy này sống nhưng bị treo/chặn với Facebook - bỏ nó khỏi danh sách hoặc dùng proxy khác.`)
        }
        log('⚠ Trang tải chậm qua proxy nhưng form đã sẵn sàng - tiếp tục...')
      }

      // 21-10: user muốn nhanh — delay tối thiểu cho DOM kịp render, bỏ giả lập người thật
      await sleep(800 + Math.floor(Math.random() * 400))

      // 4→8. Điền form + Submit. FB từ chối ("An error occurred during your
      // registration") = chặn theo IP/reputation — điền lại trong cùng Chrome là vô ích
      // (AUTO_BM cũng không retry form): trả softFail để main đóng Chrome này, mở Chrome MỚI.
      // 4. Chấp nhận cookie banner nếu có
      await wc.executeJavaScript(`
        (function() {
          var btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          for (var b of btns) {
            var t = (b.textContent || '').trim().toLowerCase();
            if (t === 'allow all cookies' || t === 'accept all' || t === 'allow all'
                || t.includes('chấp nhận tất')) {
              b.click(); return t;
            }
          }
          return 'NO_BANNER';
        })()
      `).catch(() => {})
      await sleep(500)

      // ── MOBILE (wbloks): form từng màn — điền bằng vòng thích ứng riêng, KHÔNG dùng nhánh form web ──
      let mobileOtpReady = false
      if (via === 'mobile') {
        log('📱 Mobile wbloks: bắt đầu vòng điền từng màn (Get started -> Tên -> Email -> Pass -> Birthday -> Gender -> OTP)...')
        const mob = await this.runMobileWbloksFlow(win, wc, {
          firstName, lastName, birthDay, birthMonth, birthYear, gender,
          email: contactDisplay, password, log
        })
        if (!mob.ok) {
          const errMsg = 'Mobile reg: ' + (mob.reason || 'kẹt không rõ')
          log(`❌ ${errMsg}`)
          await releaseSms('mobile reg kẹt form')
          await cleanup()
          return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, softFail: true }
        }
        mobileOtpReady = true
      }

      // 5. Chờ form render đủ ô nhập rồi mới điền, mỗi ô đều kiểm chứng sau khi gõ
      // SĐT giả dùng khi reg Gmail (khai báo cấp hàm — dùng cả sau Submit)
      let regPhone = ''
      if (!mobileOtpReady) {
      log('📝 Chờ form đăng ký sẵn sàng...')
      const formIdx = await this.waitForRegistrationForm(wc, 30000, log)
      if (!formIdx) {
        const errMsg = 'Không tìm thấy đủ ô nhập trên trang đăng ký (Facebook trả về trang lạ hoặc mạng quá chậm).'
        log(`❌ ${errMsg}`)
        await releaseSms('không thấy form đăng ký')
        await cleanup()
        return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg }
      }
      log(`📝 Đang điền form bằng tọa độ chuột vật lý (thấy ${formIdx.total} ô: ${formIdx.types})...`)

      // 25-10 (yêu cầu user): reg Gmail điền SĐT giả thay email — FB đòi mã SMS thì bấm
      // "I didn't get the code" → "Change mobile number or email address" → điền lại Gmail
      // → Add → OTP về Gmail như bình thường. Nick có SĐT ⇒ FB tin hơn, giảm checkpoint.
      regPhone = emailProvider === 'gmail'
        ? randomPhoneFor((proxyGeo && proxyGeo.countryCode) || 'VN')
        : ''
      if (regPhone) log(`📱 Điền SĐT ${regPhone} vào form (email ${email} sẽ Add sau qua "Change mobile number or email address")`)

      const filled = []
      filled.push(await this.fillFieldReliably(win, formIdx.first, firstName, 'First name', log))
      await this.humanPause(200, 500)
      filled.push(await this.fillFieldReliably(win, formIdx.last, lastName, 'Last name', log))
      await this.humanPause(200, 500)
      filled.push(await this.fillFieldReliably(win, formIdx.email, regPhone || email, contactLabel, log))
      await this.humanPause(200, 500)
      filled.push(await this.fillFieldReliably(win, formIdx.pass, password, 'Password', log))
      await this.humanPause(300, 700)

      if (filled.some(ok => !ok)) {
        const errMsg = 'Không điền được form đăng ký - Facebook không nhận dữ liệu vào ô Tên/Email/Mật khẩu.'
        log(`❌ ${errMsg}`)
        await releaseSms('không điền được form')
        await cleanup()
        return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg }
      }

      // 6. Điền Ngày sinh bằng click tọa độ
      log(`🎂 Chọn ngày sinh: ${birthDay}/${birthMonth}/${birthYear}...`)
      await this.selectComboByCoord(win, 'day', String(birthDay), log)
      await this.humanPause(250, 500)
      await this.selectComboByCoord(win, 'month', mName, log)
      await this.humanPause(250, 500)
      await this.selectComboByCoord(win, 'year', String(birthYear), log)
      await this.humanPause(250, 500)

      // 7. Chọn Giới tính bằng click tọa độ
      log(`⚧ Chọn giới tính: ${gender === '2' ? 'Nam' : 'Nữ'}...`)
      await this.selectComboByCoord(win, 'gender', genderStr, log)
      await this.humanPause(250, 500)

      // 7a. Kiểm tra chót cả 4 dropdown (day/month/year/gender), thiếu thì chọn lại
      const comboChecks = [
        { type: 'day', val: String(birthDay), label: 'Ngày sinh' },
        { type: 'month', val: mName, label: 'Tháng sinh' },
        { type: 'year', val: String(birthYear), label: 'Năm sinh' },
        { type: 'gender', val: genderStr, label: 'Giới tính' }
      ]
      for (const cc of comboChecks) {
        if (!(await this.verifyComboboxValue(wc, cc.type, cc.val))) {
          log(`⚠ ${cc.label} chưa được chọn - chọn lại...`)
          await this.selectComboByCoord(win, cc.type, cc.val, log)
        }
      }

      // 7b. Kiểm tra chót toàn bộ ô nhập trước khi Submit (chống giá trị bị reset)
      const finalIdx = await this.getFormInputIndices(wc)
      if (finalIdx && finalIdx.first !== -1 && finalIdx.pass !== -1) {
        const checks = [
          { idx: finalIdx.first, val: firstName, label: 'First name' },
          { idx: finalIdx.last, val: lastName, label: 'Last name' },
          { idx: finalIdx.email, val: regPhone || email, label: regPhone ? 'SĐT' : 'Email' },
          { idx: finalIdx.pass, val: password, label: 'Password' }
        ]
        let allOk = true
        for (const c of checks) {
          if (c.idx === undefined || c.idx === null || c.idx < 0) { allOk = false; continue }
          if (await this.verifyInputValue(wc, c.idx, c.val)) continue
          log(`⚠ ${c.label} bị trống/mất trước khi Submit - điền lại...`)
          if (!(await this.fillFieldReliably(win, c.idx, c.val, c.label, log))) allOk = false
        }
        if (!allOk) {
          const errMsg = 'Dữ liệu form không giữ được trước khi Submit (Facebook reset trang giữa chừng).'
          log(`❌ ${errMsg}`)
          await releaseSms('form mất dữ liệu trước khi Submit')
          await cleanup()
          return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, softFail: true }
        }
        log('✓ Kiểm tra chót: đủ Tên/Email/Mật khẩu trong form')
      }

      // 7c. Chấm đỏ tên/password: FB báo lỗi ngay khi điền xong (blur) - Submit cũng vô ích.
      // Thấy đỏ -> hủy phiên, mở Chrome khác thử lại (tên mới + email mới).
      const redField = await wc.executeJavaScript(`
        (function() {
          var text = (document.body ? document.body.innerText : '').toLowerCase();
          if (text.indexOf('in your name') !== -1 || text.indexOf('name policies') !== -1) return 'TEN';
          if (text.indexOf('your password must be') !== -1 || text.indexOf('combination of at least six') !== -1
            || text.indexOf('password is too') !== -1 || text.indexOf('more secure password') !== -1) return 'MATKHAU';
          return '';
        })()
      `).catch(() => '')
      if (redField) {
        const errMsg = `Facebook chấm đỏ ô ${redField === 'TEN' ? 'Tên' : 'Mật khẩu'} (không chấp nhận giá trị) - đóng Chrome này, mở Chrome khác thử lại.`
        log(`❌ ${errMsg}`)
        await releaseSms('FB chấm đỏ ô form')
        await cleanup()
        return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, proxyFail: true, softFail: true }
      }

      // 8. Bấm nút Submit: DOM click là chính (VPS/RDP/window ẩn click tọa độ hay trượt), tọa độ dự phòng
      // 21-10: user muốn nhanh — chờ ngắn 1-2s thay vì 3-7s giả lập người thật
      const preSubmitDelay = 1000 + Math.floor(Math.random() * 1000)
      log(`⏳ Chờ ${Math.round(preSubmitDelay/1000)}s trước khi Submit...`)

      // Di chuột nhẹ trong window
      if (!this.isWindowHidden(win)) {
        try {
          const moves = 2 + Math.floor(Math.random() * 2)
          for (let mi = 0; mi < moves; mi++) {
            const mx = 80 + Math.floor(Math.random() * 280)
            const my = 200 + Math.floor(Math.random() * 400)
            wc.sendInputEvent({ type: 'mouseMove', x: mx, y: my })
            await sleep(150 + Math.floor(Math.random() * 150))
          }
        } catch {}
      }
      await sleep(preSubmitDelay)

      log('🚀 Nhấn nút Submit...')
      const clickedText = await this.clickSubmitDom(wc)
      if (clickedText) {
        log(`✓ Đã bấm Submit (${clickedText})`)
      } else if (!this.isWindowHidden(win)) {
        const submitCoord = await this.findSubmitCoord(wc)
        if (submitCoord) {
          await this.mouseClick(wc, submitCoord.x, submitCoord.y)
          log(`✓ Đã bấm Submit (${submitCoord.text})`)
        } else {
          log('⚠ Không tìm thấy nút Submit')
        }
      } else {
        log('⚠ Không tìm thấy nút Submit')
      }
      } // hết nhánh form WEB (!mobileOtpReady)

      // SMS nằm sẵn trên số ngay sau Submit: FB gửi mã RẤT NHANH sau khi bấm nút,
      // nên mã thấy được lúc này gần như chắc chắn là mã THẬT của phiên này.
      // KHÔNG thêm vào danh sách bỏ qua (bỏ qua làm nuốt mất mã thật - bug 18-10).
      // Chỉ mã có sẵn NGAY LÚC THUÊ số (mốc peek ở trên, trước cả khi FB biết số) mới là SMS cũ.
      if (mode === 'sms') {
        try {
          const earlySms = await this.sms.peekOtp(smsOrderId, { log })
          if (earlySms && !oldSmsCodes.has(earlySms)) {
            log(`ℹ Có SMS sẵn trên số ngay sau Submit (mã ${earlySms}) - tính là mã FB vừa gửi, sẽ điền khi tới trang nhập mã`)
          }
        } catch {}
      }

      await sleep(3000)

      // 27-10 (yêu cầu user): Submit mà VẪN CÒN trang đăng ký (FB nuốt im / SĐT bị chối
      // không hiện lỗi) -> đổi SĐT khác rồi Submit lại, tối đa 3 lần, tới khi rời trang
      if (regPhone && !this.isAborted && win && !win.isDestroyed()) {
        // Probe còn ở form không — CHUẨN: URL trước (r.php/reg), DOM mù (trang trắng qua
        // proxy, executeJavaScript reject) thì reload trang reg đọc lại, không kết luận mù
        const onFormJs = `
          (function() {
            var ins = Array.from(document.querySelectorAll('input')).filter(function(i){
              var r = i.getBoundingClientRect(); return r.width > 20 && r.height > 8; });
            var hasPass = ins.some(function(i){ return i.type === 'password'; });
            var btn = Array.from(document.querySelectorAll('div[role="button"], button')).some(function(b){
              var t = ((b.innerText||'')||'').trim().toLowerCase(); var r = b.getBoundingClientRect();
              return (t === 'submit' || t === 'sign up') && r.width > 40 && r.height > 12;
            });
            return hasPass && btn;
          })()`
        const probeForm = async () => {
          const u = String(wc.getURL() || '').toLowerCase()
          if (!(u.includes('r.php') || u.includes('/reg') || u.includes('signup'))) return false
          for (let k = 0; k < 3; k++) {
            const v = await wc.executeJavaScript(onFormJs).catch(() => null)
            if (v !== null) return v
            await sleep(2000)
          }
          log('⚠ Sau Submit trang reg trắng/không đọc được (proxy hụt) — reload đọc lại...')
          try { await Promise.race([wc.reload(), sleep(15000)]) } catch {}
          await sleep(5000)
          const v2 = await wc.executeJavaScript(onFormJs).catch(() => null)
          return v2 === null ? true : v2   // vẫn mù -> cứ coi như còn form, vòng sau xử lý
        }
        for (let rt = 1; rt <= 3; rt++) {
          await sleep(2000)
          if (this.isAborted || win.isDestroyed()) break
          const onForm = await probeForm()
          if (!onForm) break
          const oldPhone = regPhone
          regPhone = randomPhoneFor((proxyGeo && proxyGeo.countryCode) || 'VN')
          log(`🔄 Submit xong vẫn ở trang đăng ký — đổi SĐT ${oldPhone} -> ${regPhone} rồi Submit lại (${rt}/3)...`)
          const fIdx = await this.getFormInputIndices(wc)
          if (!fIdx || fIdx.email === undefined || fIdx.email < 0) { log('⚠ Không tìm lại ô SĐT trên form — bỏ vòng đổi SĐT'); break }
          await this.fillFieldReliably(win, fIdx.email, regPhone, 'SĐT (đổi mới)', log)
          const st2 = await this.clickSubmitDom(wc)
          if (!st2 && !this.isWindowHidden(win)) {
            const sc = await this.findSubmitCoord(wc)
            if (sc) await this.mouseClick(wc, sc.x, sc.y)
          }
          log(`✓ Đã Submit lại với SĐT ${regPhone}`)
          await sleep(3000)
        }
      }

      // 25-10: reg bằng SĐT giả -> FB đòi mã SMS. Chuyển sang xác minh email:
      // "I didn't get the code" -> "Change mobile number or email address" -> điền Gmail -> Add
      if (regPhone && !this.isAborted && win && !win.isDestroyed()) {
        try {
          await this.regPhoneSwitchToEmail(win, wc, log, email, baseGmail)
        } catch (swErr) {
          log(`⚠ Chuyển SĐT→Email lỗi: ${swErr.message} — tiếp tục flow (FB có thể đã gửi mã email)`)
        }
      }

      // Kiểm tra có thông báo lỗi từ chối ngay lập tức không
      const postSubmitCheck = await wc.executeJavaScript(`
        (function() {
          var text = (document.body ? document.body.innerText : '').toLowerCase();
          if (text.includes('an error occurred during your registration')) return 'FB_REG_ERROR';
          if (text.includes('please try again later')) return 'RATE_LIMITED';
          return 'OK';
        })()
      `).catch(() => 'OK')

      if (postSubmitCheck === 'FB_REG_ERROR' || postSubmitCheck === 'RATE_LIMITED') {
        const errMsg = `FB từ chối đăng ký (${postSubmitCheck === 'RATE_LIMITED' ? '"Please try again later"' : '"An error occurred during your registration"'}) - FB chặn theo IP/reputation, điền lại trong cùng Chrome là vô ích. Đóng Chrome này, mở Chrome MỚI (email/tên mới, xoay IP nếu có nguồn)...`
        log(`❌ ${errMsg}`)
        await releaseSms('FB từ chối đăng ký')
        await cleanup()
        return {
          success: false,
          status: 'ERROR',
          email: contactDisplay,
          password,
          name: fullName,
          error: errMsg,
          proxyFail: true,
          softFail: true
        }
      }

      // Nếu Facebook báo thiếu dữ liệu (trang xóa ngầm giá trị) -> điền lại và Submit lại
      for (let round = 1; round <= 2; round++) {
        const invalidFields = await wc.executeJavaScript(`
          (function() {
            var text = (document.body ? document.body.innerText : '').toLowerCase();
            var misses = [];
            if (text.includes("what's your first name")) misses.push('first');
            if (text.includes("what's your surname") || text.includes("what's your last name")) misses.push('last');
            if (text.includes('please enter a valid mobile number or email')) misses.push('email');
            if (text.includes('enter a combination of at least six')) misses.push('pass');
            if (text.includes('select your birthday')) misses.push('day');
            return misses;
          })()
        `).catch(() => [])

        if (!Array.isArray(invalidFields) || invalidFields.length === 0) break

        log(`⚠ Facebook báo thiếu: ${invalidFields.join(', ')} - điền lại và Submit lại (vòng ${round}/2)...`)
        const idx = await this.getFormInputIndices(wc)
        if (!idx || idx.first === -1) break

        if (invalidFields.includes('first')) await this.fillFieldReliably(win, idx.first, firstName, 'First name', log)
        if (invalidFields.includes('last')) await this.fillFieldReliably(win, idx.last, lastName, 'Last name', log)
        if (invalidFields.includes('email')) {
          if (regPhone) {
            const oldP2 = regPhone
            regPhone = randomPhoneFor((proxyGeo && proxyGeo.countryCode) || 'VN')
            log(`⚠ SĐT ${oldP2} bị chối ("valid mobile number or email") — đổi ${regPhone}...`)
            await this.fillFieldReliably(win, idx.email, regPhone, 'SĐT (đổi mới)', log)
          } else {
            await this.fillFieldReliably(win, idx.email, email, contactLabel, log)
          }
        }
        if (invalidFields.includes('pass')) await this.fillFieldReliably(win, idx.pass, password, 'Password', log)
        if (invalidFields.includes('day')) await this.selectComboByCoord(win, 'day', String(birthDay), log)

        if (await this.clickSubmitDom(wc)) {
          log('✓ Đã Submit lại')
        } else if (!this.isWindowHidden(win)) {
          const retryCoord = await this.findSubmitCoord(wc)
          if (retryCoord) {
            await this.mouseClick(wc, retryCoord.x, retryCoord.y)
            log('✓ Đã Submit lại')
          }
        }
        await sleep(3000)
      }

      // Bước 2 nếu có (nhập password lần 2)
      const needsPass2 = await wc.executeJavaScript(`
        (function() {
          var inp = Array.from(document.querySelectorAll('input[type="password"]'))
            .find(function(i) { return i.offsetWidth > 0 && !i.value; });
          return !!inp;
        })()
      `).catch(() => false)

      if (needsPass2) {
        log('Phát hiện bước 2 yêu cầu Password...')
        let p2Idx = 0
        const p2Form = await this.getFormInputIndices(wc)
        if (p2Form && p2Form.pass !== -1) p2Idx = p2Form.pass
        const pass2Ok = await this.fillFieldReliably(win, p2Idx, password, 'Password (bước 2)', log)
        if (!pass2Ok) {
          const errMsg = 'Không điền được ô Password ở bước 2.'
          log(`❌ ${errMsg}`)
          await releaseSms('lỗi bước password 2')
          await cleanup()
          return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, softFail: true }
        }
        await sleep(500)
        await wc.executeJavaScript(`
          (function() {
            var b = Array.from(document.querySelectorAll('[role="button"], button'))
              .find(function(el) {
                var t = (el.innerText || '').trim().toLowerCase();
                return t === 'next' || t === 'submit' || t === 'tiếp';
              });
            if (b) b.click();
          })()
        `).catch(() => {})
        await sleep(3000)
      }

      if (this.isAborted) {
        await releaseSms('bot bị dừng')
        await cleanup()
        return { success: false, status: 'ABORTED', error: 'Đã hủy' }
      }

      // Đợi Facebook chuyển sang trang "Enter the confirmation code" TRƯỚC khi gọi lấy OTP.
      // Gọi sớm: OTP về lúc form đăng ký còn hiển thị -> dán nhầm vào ô của form -> hỏng acc.
      log('⏳ Chờ Facebook chuyển sang trang nhập mã xác nhận...')
      let otpPageReady = false
      let otpSkipped = false  // FB tự xác nhận email (vào thẳng feed) -> bỏ qua OTP
      const otpPageStart = Date.now()
      let urlAfterSubmit = ''
      try { urlAfterSubmit = wc.getURL() } catch {}
      let lastDiag = 0
      let blankStreak = 0
      let lastGoodSt = Date.now()  // lần cuối đọc được nội dung DOM (điều hướng qua proxy chậm: JS eval fail thoáng qua là bình thường)
      let codeishUnreadSince = 0   // 24-10: URL đã là trang mã nhưng DOM trắng — mốc bắt đầu trắng
      while (Date.now() - otpPageStart < 240000) {
        if (this.isAborted) break
        // Quét TẤT CẢ frame — trang /recover/code nhét form vào IFRAME (main doc trống → quét main không thấy)
        let st = null
        let evalErr = null
        try {
          const frs = [wc.mainFrame, ...wc.mainFrame.framesInSubtree]
          for (const fr of frs) {
            if (!fr) continue
            const r = await fr.executeJavaScript(`
          (function() {
            // FB đổi sang layout Meta mới có thể nhét form vào iframe -> quét cả iframe same-origin
            var docs = [document];
            try {
              Array.from(document.querySelectorAll('iframe')).forEach(function(f) {
                try { if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument); } catch (e) {}
              });
            } catch (e) {}
            var allText = '', hit = false, rejected = false, red = '', visPw = false, visTxt = false, agreeClicked = false;
            docs.forEach(function(d) {
              var raw = (d.body && d.body.innerText) || '';
              if (!allText) allText = raw;
              var t = raw.toLowerCase();
              if (t.indexOf('enter the confirmation code') !== -1 || t.indexOf('confirmation code') !== -1
                || t.indexOf('enter the code') !== -1 || t.indexOf('nhập mã xác nhận') !== -1
                || t.indexOf('nhap ma xac nhan') !== -1
                // Layout "Confirm your account" (8 số): "We sent a code to your email address. Enter that code"
                || t.indexOf('we sent a code to your email') !== -1 || t.indexOf('enter that code') !== -1
                || t.indexOf('confirm your account') !== -1) hit = true;
              if (t.indexOf('an error occurred during your registration') !== -1) rejected = true;
              if (!red) {
                if (t.indexOf('in your name') !== -1 || t.indexOf('name policies') !== -1) red = 'TEN';
                else if (t.indexOf('your password must be') !== -1 || t.indexOf('combination of at least six') !== -1
                  || t.indexOf('password is too') !== -1 || t.indexOf('more secure password') !== -1) red = 'MATKHAU';
              }
              try {
                Array.from(d.querySelectorAll('input')).forEach(function(i) {
                  if (i.offsetWidth <= 0) return;
                  if (i.type === 'password') visPw = true;
                  else if (i.type !== 'hidden' && i.type !== 'submit' && i.type !== 'checkbox') visTxt = true;
                });
              } catch (e) {}
              // Trang dieu khoan Meta sau Submit: nut "I agree" - bam luon de qua trang ma xac nhan
              try {
                var abtns = d.querySelectorAll('div[role="button"], button');
                for (var ai = 0; ai < abtns.length; ai++) {
                  var ab = abtns[ai];
                  if (ab.offsetWidth <= 0) continue;
                  if (ab.getAttribute('aria-disabled') === 'true') continue;
                  var at = (ab.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                  var an = at.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/đ/g, 'd');
                  if (an === 'i agree' || an === 'agree' || an === 'i accept' || an === 'accept' || an === 'dong y') {
                    ab.click(); agreeClicked = true; break;
                  }
                }
              } catch (e) {}
              // FB tự xác nhận email: Submit xong vào THẲNG bàn tin (feed/popup remember password)
              var liveNow = false;
              try {
                if (d.querySelector('div[role="feed"]')) liveNow = true;
                var tl = (raw || '').toLowerCase();
                if (tl.indexOf("what's on your mind") !== -1 || tl.indexOf('remember password') !== -1
                  || tl.indexOf('create story') !== -1 || tl.indexOf('tạo story') !== -1) liveNow = true;
              } catch (e) {}
            });
            return { hit: hit, rejected: rejected, red: red, formStill: visPw && visTxt, hasInput: visPw || visTxt, agreeClicked: agreeClicked,
                     live: liveNow,
                     sample: allText.replace(/\\s+/g, ' ').trim().substring(0, 120) };
          })()
`).catch(e => { if (!evalErr) evalErr = (e && e.message) ? String(e.message).substring(0, 120) : 'reject không rõ'; return null })
            if (!r) continue
            st = st || { hit: false, rejected: false, red: '', hasInput: false, live: false, agreeClicked: false, sample: '' }
            if (r.hit) st.hit = true
            if (r.rejected) st.rejected = true
            if (r.red && !st.red) st.red = r.red
            if (r.hasInput) st.hasInput = true
            if (r.live) st.live = true
            if (r.agreeClicked) st.agreeClicked = true
            if (r.sample && !st.sample) st.sample = r.sample
          }
        } catch (e) { log('⚠ scan frames lỗi: ' + e.message) }
        if (st && st.live) {
          // Đã vào thẳng FEED = FB tự xác nhận email — KHÔNG cần OTP, reg coi như xong
          otpPageReady = true
          otpSkipped = true
          log('✅ FB tự xác nhận email — tài khoản vào thẳng bàn tin (không cần OTP)')
          break
        }
        if (st && st.agreeClicked) {
          log('🤝 FB hỏi đồng ý điều khoản ("I agree") - đã bấm đồng ý tự động, chờ chuyển trang...')
          await sleep(2500)
        }
        if (st && st.rejected) {
          // FB chặn reg (IP/proxy bị flag spam) - hủy số NGAY, đừng giữ số tốn tiền chờ 90s
          const errMsg = 'Facebook từ chối đăng ký ("An error occurred during your registration"). IP/proxy bị hạn chế spam hoặc số/email không được chấp nhận.'
          log(`❌ ${errMsg} Hủy số đã thuê ngay.`)
          await releaseSms('FB từ chối đăng ký')
          await cleanup()
          return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, proxyFail: true }
        }
        if (st && st.red) {
          // FB chấm đỏ ô Tên/Mật khẩu sau Submit - Submit không bao giờ ăn, hủy ngay mở Chrome khác
          const errMsg = `Facebook chấm đỏ ô ${st.red === 'TEN' ? 'Tên' : 'Mật khẩu'} - Submit không ăn. Đóng Chrome này, mở Chrome khác thử lại.`
          log(`❌ ${errMsg} Hủy số đã thuê.`)
          await releaseSms('FB chấm đỏ ô form')
          await cleanup()
          return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, softFail: true }
        }
        // Trang trắng/đang điều hướng: KHÔNG reload (reload giữa navigation = hủy luôn chuyển
        // trang!) — chỉ kiên nhẫn chờ. Hủy chỉ khi >2 PHÚT liền không đọc được nội dung gì
        let urlNow = ''
        try { urlNow = wc.getURL() || '' } catch {}
        const urlCodeish = /confirmemail\.php|recover\/code|\/checkpoint/i.test(urlNow)
        if (!st || (!st.hasInput && !st.sample)) {
          blankStreak++
        } else { blankStreak = 0; lastGoodSt = Date.now(); codeishUnreadSince = 0 }
        if (urlCodeish) {
          // 24-10 fix bug chính: URL đã là TRANG MÃ XÁC NHẬN = FB đã CHẤP NHẬN đăng ký!
          // DOM trắng lúc này chỉ là trang tải hụt qua proxy — KHÔNG ĐƯỢC kết luận "trắng
          // trang bỏ cuộc" (lỗi chiều 24-10: đứng 2 phút "(không đọc được DOM)" rồi đóng
          // Chrome, chưa lấy OTP dù Gmail có sẵn mã). Sau 20s trắng: poll OTP LUÔN
          // (Gmail window độc lập) — vòng điền OTP sẽ tự reload trang tới khi đọc được.
          if (!st || (!st.hasInput && !st.sample)) {
            if (!codeishUnreadSince) codeishUnreadSince = Date.now()
            if (Date.now() - codeishUnreadSince > 20000) {
              log('⚠ URL đã là trang mã xác nhận nhưng DOM trắng (trang tải hụt qua proxy) — bắt đầu nhận OTP, vòng điền sẽ tự reload trang tới khi đọc được...')
              otpPageReady = true
              break
            }
          }
        } else if (blankStreak >= 15 && Date.now() - lastGoodSt > 120000) {
          const errMsg = 'Trắng trang giữa chừng (Facebook không tải được nội dung) - đóng Chrome này, mở Chrome khác thử lại.'
          log(`❌ ${errMsg} Hủy số đã thuê.`)
          await releaseSms('trắng trang sau Submit')
          await cleanup()
          return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, proxyFail: true, softFail: true }
        }
        const waited = Date.now() - otpPageStart
        // Log chẩn đoán mỗi 15s: biết trang đang nằm đâu nếu detection trượt
        if (waited - lastDiag > 15000) {
          lastDiag = waited
          log(`ℹ Chưa thấy trang mã xác nhận (${Math.round(waited / 1000)}s): URL=${urlNow || '?'} | Trang: "${st ? st.sample : '(không đọc được DOM' + (evalErr ? ' — ' + evalErr : '') + ')'}"`)
        }
        // Treo: form VẪN nguyên trong DOM và ĐỌC ĐƯỢC (45s) = FB bỏ qua Submit im lặng
        // -> hủy. st null = trang đang load/điều hướng chậm — KHÔNG hủy, chờ tiếp
        if (waited > 45000 && st && st.formStill) {
          const errMsg = 'Trang vẫn kẹt ở form đăng ký sau khi Submit - Facebook không chuyển trang. Tự động đóng, mở phiên mới.'
          log(`❌ ${errMsg} Hủy số đã thuê.`)
          await releaseSms('kẹt sau Submit')
          await cleanup()
          return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, softFail: true }
        }
        if (st && st.hit && st.hasInput) { otpPageReady = true; break }
        await sleep(2000)
      }

      if (this.isAborted) {
        await releaseSms('bot bị dừng')
        await cleanup()
        return { success: false, status: 'ABORTED', error: 'Đã hủy' }
      }

      if (otpPageReady) {
        log('✓ Đã thấy trang nhập mã xác nhận - bắt đầu nhận OTP')
      } else if (mode === 'sms') {
        // Trang mã xác nhận không bao giờ xuất hiện = FB không chấp nhận đăng ký -> hủy số để hoàn tiền
        const errMsg = 'Không thấy trang nhập mã xác nhận của Facebook sau 90 giây.'
        log(`❌ ${errMsg} Hủy số đã thuê để hoàn tiền.`)
        await releaseSms('không thấy trang nhập mã xác nhận')
        await cleanup()
        return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg }
      } else {
        log('⚠ Chưa thấy trang nhập mã xác nhận - vẫn thử nhận OTP từ email...')
      }

      // 8b. Trang chết giữa chừng: toast "You are currently offline" = proxy chết sau khi Submit.
      // 24-10: CHỈ abort khi trang NÓI RÕ offline. DOM trắng/không đọc được KHÔNG còn được
      // coi là offline (đó là trang mã xác nhận tải hụt qua proxy — sẽ được reload ở vòng
      // điền OTP); abort oan trước đây đã vứt OTP nhận được rồi.
      const checkPageOffline = async () => {
        for (let k = 0; k < 2; k++) {
          const st = await wc.executeJavaScript(
            "(function(){var t=(document.body?document.body.innerText:'').toLowerCase();" +
            "var vis=0;var ins=document.querySelectorAll('input');for(var i=0;i<ins.length;i++){if(ins[i].offsetWidth>0)vis++;}" +
            "return {off:t.indexOf('currently offline')!==-1, blank:t.length<15&&vis===0};})()"
          ).catch(() => null)
          if (st && st.off) return true           // toast offline rõ ràng
          if (st && !st.off && !st.blank) return false  // trang đọc được và khỏe
          // st null (không đọc được DOM) hoặc blank (body rỗng): không kết luận — có thể
          // đang điều hướng/lỗi tải tạm thời. Retry lần 2 để chắc, rồi trả false.
          if (k === 0) await sleep(4000)
        }
        return false
      }

      if (await checkPageOffline()) {
        const errMsg = 'Chrome mất kết nối giữa chừng ("You are currently offline") - proxy chết sau khi Submit. Đóng Chrome này, mở Chrome khác thử lại.'
        log(`❌ ${errMsg}`)
        if (mode === 'sms') await releaseSms('Chrome mất kết nối')
        await cleanup()
        return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, proxyFail: true, softFail: true }
      }

      // 9. Lấy OTP: SMS (SMSPVA) hoặc Email (tempmailapi.io.vn)
      let otpCode = null
      if (mode === 'sms') {
        log('📱 Đang đợi SMS OTP từ SMSPVA cho số đã thuê...')
        otpCode = await this.sms.waitForOtp(smsOrderId, {
          log: (m) => log(m),
          checkRunning: () => !this.isAborted,
          ignoreCodes: oldSmsCodes
        })
        if (!otpCode) {
          // Timeout hoặc đơn đóng -> hủy để hoàn tiền (abort thì waitForOtp đã tự hủy)
          if (!this.isAborted) await releaseSms('không nhận được SMS OTP')
          await cleanup()
          return {
            success: false,
            status: 'ERROR',
            email: contactDisplay,
            password,
            name: fullName,
            error: 'Không nhận được mã OTP qua SMS'
          }
        }
      } else {
        if (!otpSkipped) {
        const mailClient = emailProvider === 'tempmailid'   ? this.tempmailId
                         : emailProvider === 'mailtm'       ? this.mailTm
                         : emailProvider === 'mailtd'       ? this.mailTd
                         : emailProvider === 'tempmailv2'   ? this.tempmailV2
   : emailProvider === 'mailown'   ? this.mailOwn
   : emailProvider === 'gmail'   ? this.gmail
   : emailProvider === 'customdomain' ? this.customDomain
                         : this.tempmail
        const provName   = emailProvider === 'tempmailid'   ? 'tempmail.id.vn'
                         : emailProvider === 'mailtm'       ? 'mail.tm'
                         : emailProvider === 'mailtd'       ? 'mail.td'
                         : emailProvider === 'tempmailv2'   ? 'tempemail.cc'
                         : emailProvider === 'mailown'       ? 'mail-own (VPS)'
       : emailProvider === 'gmail'       ? 'gmail dot/plus'
                         : emailProvider === 'customdomain' ? ('custom:' + (process.env.CUSTOM_DOMAIN || 'yourdomain.com'))
                         : 'tempmailapi.io.vn'
        log(`📬 Đang polling OTP qua email (${provName})...`)
        // Chia thành các vòng ngắn: giữa các vòng kiểm tra trang Chrome còn sống
        // (proxy chết giữa chừng thì hủy sớm, đừng chờ hết 150s rồi điền vào trang chết)
        let otpResult = null
        if (emailProvider === 'gmail' && gmailWin && !gmailWin.isDestroyed()) {
          // ── v2 COOKIE GMAIL: đọc OTP trực tiếp từ inbox Gmail trên cửa sổ cookie ──
          otpResult = await this.pollGmailCookieOtp(gmailWin, { firstName, variant: contactDisplay }, log)
        } else {
        // Gmail IMAP index lag: mail mới mất 1-5 phút mới vào SEARCH index -> poll dài hơn hẳn
        const pollAttempts = emailProvider === 'gmail' ? 45 : 5
        const pollInterval = emailProvider === 'gmail' ? 7000 : 6000
        for (let round = 1; round <= 5 && !otpResult; round++) {
          otpResult = await mailClient.pollForOtp(sidToken, new Set(), pollAttempts, pollInterval, (m) => log(m))
          if (!otpResult || !otpResult.otp) {
            if (await checkPageOffline()) {
              const errMsg = 'Chrome mất kết nối giữa chừng ("You are currently offline") - proxy chết khi đang chờ OTP. Đóng Chrome này, mở Chrome khác thử lại.'
              log(`❌ ${errMsg}`)
              await cleanup()
              return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, proxyFail: true, softFail: true }
            }
          }
        }
        }

        if (!otpResult || !otpResult.otp) {
          log('⏳ Timeout: Không nhận được mã OTP từ hòm thư.')
          await cleanup()
          // 27-10: timeout OTP đa phần do mạng/proxy hụt (trang trắng) — softFail để mở
          // Chrome mới thử lại nick này thay vì đếm là 1 nick hỏng thật
          return {
            success: false,
            status: 'ERROR',
            email: contactDisplay,
            password,
            name: fullName,
            error: 'Không nhận được mã OTP',
            softFail: true
          }
        }
        otpCode = otpResult.otp
      }

      log(`🔑 Đã nhận OTP: ${otpCode}`)
      await sleep(2000)

      // Kiểm tra chót trước khi điền: trang phải còn sống (proxy chết = điền vô ích)
      if (await checkPageOffline()) {
        const errMsg = 'Chrome mất kết nối khi chuẩn bị điền mã OTP - proxy đã chết. Đóng Chrome này, mở Chrome khác thử lại.'
        log(`❌ ${errMsg}`)
        if (mode === 'sms') await releaseSms('Chrome mất kết nối trước khi điền OTP')
        await cleanup()
        return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, proxyFail: true, softFail: true }
      }

      // 10+11. Điền mã OTP + bấm Continue — gói thành hàm để retry khi mã sai (v2 cookie)
      const fillAndSubmitOtp = async (code) => {
        // Quét TẤT CẢ frame tìm ô nhập mã (form có thể nằm trong iframe cross-origin)
        let frames = []
        try { frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree] } catch {}
        let targetFrame = null
        let targetIdx = -1
        for (const fr of frames) {
          if (!fr) continue
          const idx = await fr.executeJavaScript(`(function() {
            var docs = [document];
            try { Array.from(document.querySelectorAll('iframe')).forEach(function(f) { try { if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument); } catch (e) {} }); } catch (e) {}
            var text = (document.body ? document.body.innerText : '').toLowerCase();
            var onCodePage = text.indexOf('we sent a code to your email') !== -1 || text.indexOf('enter that code') !== -1
              || text.indexOf('confirm your account') !== -1 || text.indexOf('confirmation code') !== -1
              || text.indexOf('enter the code') !== -1 || text.indexOf('nhập mã xác nhận') !== -1;
            var vis = [];
            docs.forEach(function(d) { Array.from(d.querySelectorAll('input')).forEach(function(i) { if (i.offsetWidth > 0 && i.type !== 'hidden') vis.push(i); }); });
            for (var k = 0; k < vis.length; k++) {
              var meta = ((vis[k].name || '') + ' ' + (vis[k].id || '') + ' ' + (vis[k].getAttribute('aria-label') || '') + ' ' + (vis[k].placeholder || '')).toLowerCase();
              if (meta.indexOf('code') !== -1 || meta.indexOf('confirmation') !== -1 || meta.indexOf('xác nhận') !== -1 || meta.indexOf('xac nhan') !== -1) return k;
            }
            return (onCodePage && vis.length) ? 0 : -1;
          })()`).catch(() => -1)
          if (idx !== -1 && idx !== null) { targetFrame = fr; targetIdx = idx; break }
        }
        if (!targetFrame) return { ok: false, reason: 'Không tìm thấy ô nhập mã OTP trong bất kỳ frame nào.' }
        // Focus ô nhập TRONG frame rồi gõ vật lý (sendInputEvent đi vào element đang focus)
        const focused = await targetFrame.executeJavaScript(`(function() {
          var vis = Array.from(document.querySelectorAll('input')).filter(function(i) { return i.offsetWidth > 0 && i.type !== 'hidden'; });
          var target = vis[${targetIdx}];
          if (!target) return false;
          target.focus();
          return true;
        })()`).catch(() => false)
        if (!focused) return { ok: false, reason: 'Không focus được ô nhập mã OTP.' }
        await sleep(300)
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
        await sleep(40)
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
        await sleep(40)
        await wc.insertText(String(code)).catch(() => {})
        await sleep(400)
        // Verify giá trị đã vào ô trong frame
        const okVal = await targetFrame.executeJavaScript(`(function() {
          var vis = Array.from(document.querySelectorAll('input')).filter(function(i) { return i.offsetWidth > 0 && i.type !== 'hidden'; });
          return !!vis[${targetIdx}] && vis[${targetIdx}].value === ${JSON.stringify(String(code))};
        })()`).catch(() => false)
        if (!okVal) return { ok: false, reason: 'Giá trị OTP không vào ô nhập.' }
        await sleep(800)
        // Click Continue/Next trong frame
        const clicked = await targetFrame.executeJavaScript(`(function() {
          var btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
          for (var b of btns) {
            var t = (b.innerText || b.textContent || b.value || '').trim().toLowerCase();
            if (t === 'continue' || t === 'confirm' || t === 'xác nhận' || t === 'tiếp tục' || t === 'next' || t === 'tiếp theo' || t === 'tiep theo') {
              b.scrollIntoView({ block: 'center' }); b.click(); return t;
            }
          }
          return null;
        })()`).catch(() => null)
        if (clicked) log(`✓ Đã bấm nút OTP (${clicked})`)
        return { ok: true }
      }

      // 24-10: trang mã xác nhận có thể đang TRẮNG (tải hụt qua proxy) — reload rồi thử
      // lại tối đa 3 lần trước khi bỏ, thay vì bỏ ngay lần đầu không tìm thấy ô nhập
      let f1 = null
      for (let fillTry = 1; fillTry <= 3 && !this.isAborted; fillTry++) {
        f1 = await fillAndSubmitOtp(otpCode)
        if (f1.ok) break
        log(`⚠ Điền OTP lần ${fillTry}/3 thất bại: ${f1.reason} - reload trang mã xác nhận rồi thử lại...`)
        try { await Promise.race([wc.reload(), sleep(20000)]) } catch {}
        await sleep(6000)
      }
      if (!f1 || !f1.ok) {
        const errMsg = f1 ? f1.reason : 'trang mã xác nhận không tải được sau 3 lần reload'
        log(`❌ ${errMsg}`)
        if (mode === 'sms') await releaseSms('điền OTP thất bại')
        await cleanup()
        return { success: false, status: 'ERROR', email: contactDisplay, password, name: fullName, error: errMsg, softFail: true }
      }
      await sleep(4000)

      // ── v2 cookie: xử lý sau khi điền OTP. Bug 24-10: check sau 6s đọc nhầm trang CŨ
      // (FB xử lý OTP chậm, trang mã còn hiển thị) → báo oan "bị từ chối" dù FB ĐÃ CHẤP
      // NHẬN và ĐÃ TẠO ACC → flow treo poll inbox, không làm tiếp sau-reg. Giờ: chờ điều
      // hướng tới ~30s; chỉ kết luận "mã bị từ chối" khi trang vẫn là màn mã liên tục.
      if (emailProvider === 'gmail' && gmailWin && !gmailWin.isDestroyed()) {
        const readPageState = () => wc.executeJavaScript(`(function(){
            var t = (document.body ? document.body.innerText : '').toLowerCase();
            var live = t.indexOf("what's on your mind") !== -1 || t.indexOf('remember password') !== -1
              || t.indexOf('create story') !== -1 || (document.querySelector('div[role="feed"]') !== null);
            var code = t.indexOf('confirmation code') !== -1 || t.indexOf('enter the code') !== -1
              || t.indexOf('enter that code') !== -1 || t.indexOf('confirm your account') !== -1
              || t.indexOf('nhập mã xác nhận') !== -1
              || t.indexOf('no longer valid') !== -1 || t.indexOf('code you entered') !== -1
              || t.indexOf('incorrect code') !== -1 || t.indexOf('request a new code') !== -1;
            return live ? 'LIVE' : (code ? 'CODE' : 'UNKNOWN');
          })()`).catch(() => 'UNKNOWN')
        let pageSt = 'UNKNOWN'
        for (let w = 0; w < 10 && !this.isAborted; w++) {
          await sleep(3000)
          pageSt = await readPageState()
          if (pageSt === 'LIVE') break
          if (pageSt === 'CODE' && w >= 3) break   // CODE liên tục sau 12s = thật sự chưa ăn
        }
        const triedCodes = new Set([otpCode])
        for (let retry = 1; retry <= 3 && pageSt === 'CODE' && !this.isAborted; retry++) {
          if (retry === 1) {
            // Điền LẠI mã cũ trước: nút Continue lần đầu có thể chưa ăn (trang vừa hồi phục)
            log(`⚠ Trang vẫn ở màn nhập mã — điền lại mã ${otpCode} (Continue lần đầu có thể chưa ăn)...`)
            const fr = await fillAndSubmitOtp(otpCode)
            if (fr.ok) {
              let st2 = 'UNKNOWN'
              for (let w = 0; w < 8; w++) { await sleep(3000); st2 = await readPageState(); if (st2 !== 'CODE') break }
              if (st2 !== 'CODE') { pageSt = st2; break }
              log('⚠ Điền lại mã cũ vẫn đứng ở màn nhập mã — mã thật sự bị từ chối')
            }
          }
          // FB KHÔNG tự gửi lại mã — phải bấm "I didn't get the code"/"Resend" trên trang
          const resent = await this.clickResendCode(wc, log)
          log(`⚠ OTP ${otpCode} bị từ chối — ${resent ? 'đã bấm yêu cầu FB gửi lại mã' : 'không thấy nút gửi lại mã'}, chờ mã mới (lần ${retry}/3)...`)
          const r2 = await this.pollGmailCookieOtp(gmailWin, { firstName, variant: contactDisplay, excludeCodes: triedCodes, maxAttempts: 10 }, log)
          if (!r2 || !r2.otp) { log('⚠ Inbox chưa có mã mới — chờ rồi thử tiếp...'); continue }
          triedCodes.add(r2.otp)
          otpCode = r2.otp
          log(`⌨️ Điền mã OTP mới: ${otpCode}...`)
          const f2 = await fillAndSubmitOtp(otpCode)
          if (!f2.ok) { log(`⚠ ${f2.reason}`); continue }
          let st3 = 'UNKNOWN'
          for (let w = 0; w < 8; w++) { await sleep(3000); st3 = await readPageState(); if (st3 !== 'CODE') break }
          pageSt = st3
        }
      }

        }

      // 12. Theo dõi Checkpoint vs Live
      log('🛡️ Đang giám sát trạng thái tài khoản...')
      let isCheckpoint = false
      let isLive = false
      let isOtpStuck = false
      let detectedReason = ''
      let cUserSeenAt = 0
      let lastOtp = false
      this._otpWaitLogged = false

      for (let step = 1; step <= 20; step++) {
        if (this.isAborted) break
        await sleep(3000)

        const pageState = await wc.executeJavaScript(`
          (function() {
            var url = window.location.href.toLowerCase();
            var text = (document.body ? document.body.innerText : '').toLowerCase();

            if (url.includes('checkpoint') || url.includes('confirmidentity') || url.includes('disabled')) {
              return { status: 'CHECKPOINT', reason: 'URL: ' + url };
            }
            if (text.includes('vô hiệu hóa') || text.includes('vô hiệu hoá')
                || text.includes('disabled your account') || text.includes('suspended')
                || text.includes('locked') || text.includes('upload a photo')
                || text.includes('tài khoản của bạn đã bị khóa') || text.includes('tài khoản của bạn đã bị khoá')
                || text.includes('tạm khóa') || text.includes('tạm khoá')
                || text.includes('bị khóa') || text.includes('bị khoá')
                || text.includes('xác minh danh tính') || text.includes('confirm your identity')
                || text.includes('checkpoint')) {
              return { status: 'CHECKPOINT', reason: 'Nội dung trang báo checkpoint' };
            }
            // Trang vẫn hỏi nhập mã xác nhận = acc CHƯA hoàn tất reg (bug 19-10: báo LIVE nhầm)
            if (url.includes('r.php') || url.includes('/reg/') || url.includes('?step=')
                || text.includes('confirmation code') || text.includes('nhập mã xác nhận')
                || text.includes('nhap ma xac nhan')) {
              return { status: 'OTP', url: url };
            }
            if (url.includes('/feed') || url.includes('/home') || url.includes('?sk=')
                || url === 'https://www.facebook.com/' || url === 'https://m.facebook.com/') {
              return { status: 'LIVE', reason: 'Vào News Feed / Home' };
            }
            return { status: 'PENDING', url: url };
          })()
        `).catch(() => ({ status: 'PENDING' }))

        if (pageState.status === 'CHECKPOINT') {
          isCheckpoint = true
          detectedReason = pageState.reason
          break
        }

        if (pageState.status === 'OTP') {
          // Vẫn đang ở trang mã xác nhận: tuyệt đối không chốt LIVE, không tích lũy cUserSeenAt
          lastOtp = true
          cUserSeenAt = 0
          if (!this._otpWaitLogged) {
            this._otpWaitLogged = true
            log(`⏳ Trang vẫn ở bước mã xác nhận - chờ FB xử lý xong (không chốt LIVE lúc này)...`)
          }
          continue
        }
        lastOtp = false

        // Trang vẫn đứng yên ở bước mã xác nhận -> đọc câu báo lỗi của FB đưa vào log (1 lần)
        if (pageState.status === 'PENDING' && !this._otpErrLogged) {
          const errSnip = await wc.executeJavaScript(`
            (function() {
              var t = (document.body ? document.body.innerText : '');
              var i = t.toLowerCase().indexOf('invalid or has expired');
              if (i === -1) i = t.toLowerCase().indexOf('confirmation code that you');
              return i > -1 ? t.substring(Math.max(0, i - 40), i + 140).replace(/\\s+/g, ' ').trim() : '';
            })()
          `).catch(() => '')
          if (errSnip) {
            this._otpErrLogged = true
            log(`⚠ FB báo lỗi trên trang xác nhận: ${errSnip}`)
          }
        }

        const cookies = await ses.cookies.get({ domain: '.facebook.com' })
        const cUser = cookies.find(c => c.name === 'c_user')
        // c_user được set NGAY sau khi nhập OTP xong, TRƯỚC khi FB chuyển trang checkpoint
        // (lỗi thật 18-10: chốt LIVE sau 3s rồi acc rơi checkpoint) — chỉ chốt khi trang đã về feed
        if (cUser && cUser.value && pageState.status === 'LIVE') {
          isLive = true
          detectedReason = `Cookie c_user = ${cUser.value} + ${pageState.reason}`
          break
        }
        if (cUser && cUser.value && !cUserSeenAt) {
          cUserSeenAt = Date.now()
          log('✓ Có cookie c_user nhưng trang chưa về feed — chờ FB điều hướng xong để loại trừ checkpoint...')
        }
        if (cUser && cUser.value && cUserSeenAt && Date.now() - cUserSeenAt > 25000) {
          isLive = true
          detectedReason = `Cookie c_user = ${cUser.value} (chờ điều hướng quá 25s, sẽ kiểm tra lần cuối)`
          break
        }

        if (pageState.status === 'LIVE') {
          isLive = true
          detectedReason = pageState.reason
          break
        }
      }

      if (isLive) {
        // Kiểm tra lần cuối: acc sạch tải lại facebook.com sẽ đáp về feed,
        // acc bị khóa sẽ bị đẩy về /checkpoint/ hoặc /login
        log('🔍 Kiểm tra lần cuối: tải lại facebook.com để chắc chắn không checkpoint...')
        let probeVerdict = 'LIVE'
        try {
          await wc.loadURL('https://www.facebook.com/')
          let lastVerdict = ''
          for (let v = 0; v < 6; v++) {
            await sleep(2000)
            let u = ''
            let otpText = false
            try {
              u = (wc.getURL() || '').toLowerCase()
              otpText = await wc.executeJavaScript(`
                (function() {
                  var t = (document.body ? document.body.innerText : '').toLowerCase();
                  return t.indexOf('confirmation code') !== -1 || t.indexOf('nhập mã xác nhận') !== -1
                    || t.indexOf('nhap ma xac nhan') !== -1;
                })()
              `).catch(() => false)
            } catch {}
            const bad = u.includes('checkpoint') || u.includes('confirmidentity') || u.includes('/login')
            // URL có 'facebook.com' KHÔNG đủ để chốt LIVE - r.php/reg/?step= hoặc trang hỏi mã = reg chưa xong
            const otpPage = otpText || u.includes('r.php') || u.includes('/reg/') || u.includes('?step=')
            const verdict = bad ? 'CHECKPOINT' : (otpPage ? 'OTP' : (u.includes('facebook.com') ? 'LIVE' : ''))
            if (verdict && verdict === lastVerdict) break
            lastVerdict = verdict
          }
          if (lastVerdict === 'CHECKPOINT') probeVerdict = 'CHECKPOINT'
          if (lastVerdict === 'OTP') probeVerdict = 'OTP'
        } catch (e) {
          log(`⚠ Không kiểm tra lại được trang (${e.message}) — tin kết quả giám sát.`)
        }
        if (probeVerdict === 'CHECKPOINT') {
          isCheckpoint = true
          isLive = false
          detectedReason = 'Tải lại facebook.com bị đẩy về trang checkpoint/login'
        }
        if (probeVerdict === 'OTP') {
          isLive = false
          isOtpStuck = true
          detectedReason = 'Tải lại facebook.com vẫn rơi về trang nhập mã xác nhận (reg chưa hoàn tất)'
        }
      }

      if (!isLive && !isCheckpoint && lastOtp) {
        isOtpStuck = true
      }

      if (isCheckpoint) {
        log(`❌ TÀI KHOẢN CHECKPOINT: ${detectedReason} -> Bỏ qua (tắt cả Chrome Gmail)`)
        gmailCloseToo = true
        await releaseSms('tài khoản bị checkpoint')
        await cleanup()
        return {
          success: false,
          status: 'CHECKPOINT',
          email: contactDisplay,
          password,
          name: fullName,
          reason: detectedReason
        }
      }

      if (!isLive) {
        if (isOtpStuck) {
          log('❌ TÀI KHOẢN CHƯA HOÀN TẤT REG: trang vẫn hỏi mã xác nhận (không phải LIVE) - không lưu vào Live.')
          await releaseSms('reg chưa hoàn tất - vẫn ở trang mã xác nhận')
          await cleanup()
          return {
            success: false,
            status: 'ERROR',
            email: contactDisplay,
            password,
            name: fullName,
            error: 'FB vẫn hỏi mã xác nhận sau khi reg (tài khoản chưa hoàn tất bước OTP) - không lưu vào Live'
          }
        }
        log('❌ Không chốt được tài khoản LIVE sau khi xác nhận OTP (không có c_user, không về feed). Tính là thất bại - không lưu vào Live.')
        await releaseSms('không xác định được trạng thái sau reg')
        await cleanup()
        return {
          success: false,
          status: 'ERROR',
          email: contactDisplay,
          password,
          name: fullName,
          error: 'Không xác định được trạng thái tài khoản sau reg (không c_user / không về feed)'
        }
      }

      const allCookies = await ses.cookies.get({ domain: '.facebook.com' })
      const cookieMap = {}
      for (const c of allCookies) cookieMap[c.name] = c.value
      const uid = cookieMap['c_user'] || ''
      const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ')

      const netscapeLines = ['# Netscape HTTP Cookie File']
      for (const c of allCookies) {
        const d = c.domain.startsWith('.') ? c.domain : `.${c.domain}`
        netscapeLines.push(`${d}\tTRUE\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${Math.floor(c.expirationDate || 0)}\t${c.name}\t${c.value}`)
      }

      log(`🎉 ĐĂNG KÝ THÀNH CÔNG! UID: ${uid || email}`)

      // Flow sau-reg (thêm email mới + xóa SĐT thuê): CHỈ chạy chế độ SMS —
      // số thuê sẽ bị thu hồi nên phải thay bằng email; reg bằng email sẵn thì không cần
      // 25-10: bọc try/catch — flow sau-reg lỗi KHÔNG được làm mất nick đã LIVE
      let contactFlow = null
      if (!this.isAborted && mode === 'sms') {
        try {
          contactFlow = await this.postRegContactFlow({
            win, wc, log, mode,
            emailProvider,
            oldEmail: null,
            oldPhone: displayPhone,
            password
          })
        } catch (cfErr) {
          log(`⚠ v2 sau-reg contact flow lỗi (${cfErr.message}) — nick vẫn LIVE, bỏ qua bước này`)
          contactFlow = null
        }
      }
      // ── Reg v2 (Gmail): sau khi LIVE — thêm email mới (API tempmailapi.io.vn — 35 domain
      // xoay vòng) + XÓA email Gmail variant vừa dùng reg + bật 2FA (cơ chế Authentication).
      // 24-10: bỏ mail-own (2 domain cố định genblackmmoonline/khangvitoro đã bị FB chặn
      // xác minh — "FB không gửi OTP về bất kỳ email temp nào")
      if (!this.isAborted && emailProvider === 'gmail') {
        log('🧩 v2 sau-reg: thêm email mới (tempmailapi.io.vn) + xóa gmail variant cũ + bật 2FA...')
        try {
          contactFlow = await this.postRegContactFlow({
            win, wc, log, mode: 'email',
            emailProvider: 'tempmailapi',
            oldEmail: contactDisplay,
            oldPhone: null,
            password,
            forceDeleteOld: true
          })
        } catch (cfErr) {
          log(`⚠ v2 sau-reg contact flow lỗi (${cfErr.message}) — nick vẫn LIVE, bỏ qua bước này`)
          contactFlow = null
        }
        if (contactFlow && contactFlow.verified && !this.isAborted && !win.isDestroyed()) {
          try {
            const twoFa = await this.postRegTwoFactorFlow({ win, wc, log, password })
            contactFlow.twoFaKey = twoFa && twoFa.ok ? twoFa.key : ''
          } catch (tfErr) {
            contactFlow.twoFaKey = ''
            log(`⚠ v2 sau-reg 2FA lỗi (${tfErr.message}) — nick vẫn LIVE, chỉ thiếu 2FA`)
          }
          log(contactFlow.twoFaKey ? '🔑 v2 sau-reg: 2FA ON — key ' + contactFlow.twoFaKey : '⚠ v2 sau-reg: chưa bật được 2FA')
        }
      }

      await cleanup()

      return {
        success: true,
        status: 'LIVE',
        uid: uid || contactDisplay,
        // SMS-mode: contactDisplay là số thuê — ưu tiên email mới đã xác minh từ contact flow
        email: (contactFlow && contactFlow.verifiedEmail) || contactDisplay,
        phone: localPhone || displayPhone || undefined,
        password,
        name: fullName,
        // Key 2FA bật ở postRegTwoFactorFlow — main.js ghi vào FB_LIVE_REG.txt
        // (dòng uid|email|pass|2FA|cookie, parser extractAccountMeta đọc lại được)
        twoFaKey: (contactFlow && contactFlow.twoFaKey) || '',
        cookieStr,
        netscapeFormat: netscapeLines.join('\n'),
        cookies: allCookies,
        contactFlow
      }

    } catch (err) {
      log(`❌ Lỗi tiến trình: ${err.message}`)
      await releaseSms('lỗi tiến trình')
      await cleanup()
      // 25-10: cửa sổ bị đóng/CDP detach giữa chừng là lỗi MỀM (Chrome hụt) -> softFail
      // để worker mở Chrome mới thử lại nick này thay vì đếm là 1 lần reg hỏng thật
      const softErr = /destroyed|Object has been|Session deleted|debugger|Target closed|Session closed/i.test(String(err.message || ''))
      return {
        success: false,
        status: 'ERROR',
        proxyFail: String(err.message || '').startsWith('Proxy không tải được'),
        softFail: String(err.message || '').startsWith('Proxy không tải được') || softErr,
        email: contactDisplay,
        password,
        name: fullName,
        error: err.message
      }
    }
  }

  // ===== Flow sau-reg: thêm email mới + xóa contact cũ qua Accounts Center =====
  // Chạy trên chính cửa sổ reg (session đã đăng nhập). Không fatal — mọi lỗi chỉ log.
  async postRegContactFlow({ win, wc, log, mode, emailProvider = 'tempmailapi', oldEmail, oldPhone, password, forceDeleteOld = false }) {
    const CONTACT_URL = 'https://accountscenter.facebook.com/youraccount/contact_points/?entrypoint=profile_page&is_from_dialog=true'
    const res = { added: false, verified: false, verifiedEmail: null, deletedOld: false, mailProvider: null, mailToken: null }
    if (win.isDestroyed()) return res

    const { sleep, mouseClick, clickText, fillInput, loadPage, visibleTextInput, hasPasswordField, dumpPageState } =
      this._pageHelpers(win, wc, log, 'Contact flow')
    const loadContactPage = () => loadPage(CONTACT_URL)

    try {
      log('📇 Contact flow: mở Accounts Center...')
      if (!await loadContactPage()) { log('⚠ Contact flow: không load được trang contact — bỏ qua'); return res }

      // ===== PHẦN 1: THÊM EMAIL MỚI + XÁC MINH OTP =====
      // OTP không về → tạo email khác và thử lại (tối đa 3 email)
      const MAX_EMAIL_TRIES = 3
      for (let attempt = 1; attempt <= MAX_EMAIL_TRIES && !res.verified; attempt++) {
        if (this.isAborted || win.isDestroyed()) return res
        if (attempt > 1) log(`🔄 Contact flow: email #${attempt - 1} không nhận OTP → đổi email khác (${attempt}/${MAX_EMAIL_TRIES})`)
        let ei = null
        const cfMail = emailProvider === 'tempmailid'   ? this.tempmailId
                     : emailProvider === 'mailtm'       ? this.mailTm
                     : emailProvider === 'tempmailg'    ? this.tempmailG
                     : emailProvider === 'mailtd'       ? this.mailTd
                     : emailProvider === 'tempmailv2'   ? this.tempmailV2
   : emailProvider === 'mailown'   ? this.mailOwn
   : emailProvider === 'gmail'   ? this.gmail
   : emailProvider === 'customdomain' ? this.customDomain
                     : this.tempmail
        if (cfMail === this.tempmailV2) cfMail.queueKey = this._regProxyKey || 'home-ip'
        // 24-10: user chốt đuôi tempmailapi.io.vn cho email sau-reg (cố định, không random
        // domain — domain khác FB thỉnh thoảng không gửi OTP)
        try { ei = await cfMail.createEmail(cfMail === this.tempmail ? 'tempmailapi.io.vn' : null) } catch (e) { log(`✗ Contact flow: tạo email thất bại: ${e.message}`); return res }
        log(`📧 Contact flow: email mới #${attempt}: ${ei.email}`)
        await loadContactPage()

        if (!await clickText(['Add new contact info', 'Add new contact'], true, 25000)) { await dumpPageState('thiếu nút Add new contact info'); continue }
        await sleep(1500)
        // Menu Add email hay flake (BM modal cũng vậy) -> thất bại thì thử attempt sau, đừng bỏ luôn
        if (!await visibleTextInput() && !await clickText(['Add email address', 'Add email'], true, 20000)) { await dumpPageState('thiếu mục Add email address'); continue }
        await sleep(2000)
        if (!await fillInput({ sel: 'div[role="dialog"] input[type="text"]', val: ei.email }) &&
            !await fillInput({ sel: 'input[type="text"]', val: ei.email })) { log('⚠ Contact flow: không điền được email'); return res }
        await sleep(800)
        if (!await clickText(['Next', 'Tiep theo'], true, 15000)) { log('⚠ Contact flow: không thấy nút Next'); return res }
        await sleep(3000)
        res.added = true

        log('📬 Contact flow: đợi OTP về email mới (tối đa 150s)...')
        const otp = await cfMail.pollForOtp(ei.sidToken, new Set(), 30, 5000, () => {})
        if (!otp || !otp.otp) continue
        log(`✉️ Contact flow: nhận OTP ${otp.otp}`)
        if (!await fillInput({ sel: 'input[autocomplete="one-time-code"]', val: otp.otp }) &&
            !await fillInput({ sel: 'div[role="dialog"] input[type="text"]', val: otp.otp })) { log('⚠ Contact flow: không điền được OTP'); continue }

        // Next không phải lúc nào cũng ăn (dialog vẫn đứng ở màn code dù value đã vào — E2E 21-10 bắt được)
        // → vòng retry: Next → Enter → Next, đến khi dialog rời màn confirmation code
        let otpAccepted = false
        for (let t = 0; t < 3 && !otpAccepted; t++) {
          if (t > 0) {
            log(`🔄 Contact flow: dialog chưa nhận OTP — thử lại (${t + 1}/3)`)
            await fillInput({ sel: 'input[autocomplete="one-time-code"]', val: otp.otp }).catch(() => false)
            await sleep(500)
          }
          if (!await clickText(['Next', 'Confirm', 'Tiep theo', 'Xac nhan'], true, 15000)) { log('⚠ Contact flow: không thấy nút Next sau OTP'); break }
          await sleep(3000)
          const stillCode = await wc.executeJavaScript('(function(){var d=document.querySelector(\'div[role="dialog"]\');return d?/confirmation code|confirm your email|mã xác nhận/i.test(d.innerText||""):false})()').catch(() => false)
          if (!stillCode) { otpAccepted = true; break }
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
          await sleep(2500)
          const stillCode2 = await wc.executeJavaScript('(function(){var d=document.querySelector(\'div[role="dialog"]\');return d?/confirmation code|confirm your email|mã xác nhận/i.test(d.innerText||""):false})()').catch(() => false)
          if (!stillCode2) otpAccepted = true
        }
        if (!otpAccepted) { try { const dlg = await wc.executeJavaScript('(function(){var d=document.querySelector(\'div[role="dialog"]\');return d?(d.innerText||"").replace(/\\s+/g," ").trim().substring(0,220):"(không có dialog)";})()'); log(`🔍 Contact flow: dialog sau OTP → ${dlg}`) } catch {} continue }
        res.verified = true
        res.verifiedEmail = ei.email
        // Lưu provider + token hòm thư để sau này còn gọi lại API lấy OTP của email này
        res.mailProvider = emailProvider
        res.mailToken = ei.sidToken || ei.email
        log(`✅ Contact flow: email mới ${ei.email} đã xác minh`)
      }
      if (!res.verified && res.added) log('⚠ Contact flow: FB không gửi OTP về bất kỳ email temp nào (chặn xác minh domain temp) — email mới ở trạng thái chưa xác minh')

      // ===== PHẦN 2: XÓA CONTACT CŨ =====
      const isPhone = mode === 'sms'
      const delTarget = isPhone ? (oldPhone || '') : (oldEmail || '')
      if (!delTarget) { log('ℹ Contact flow: không có contact cũ để xóa'); return res }
      // Email-mode: chỉ xóa email cũ khi email mới đã xác minh (tránh mất đường đăng nhập)
      if (!isPhone && !res.verified) {
        if (forceDeleteOld) {
          log('⚠ Contact flow: email mới chưa xác minh nhưng VẪN XÓA email cũ theo yêu cầu — nick sẽ mất email xác minh (chỉ còn SĐT/nick trần), rủi ro khi recovery!')
        } else {
          log('ℹ Contact flow: giữ nguyên email cũ vì email mới chưa xác minh'); return res
        }
      }
      if (this.isAborted || win.isDestroyed()) return res

      // Mẹo so khớp: phone FB hiện dạng có khoảng cách → so bằng 8 số cuối
      const digitsTail = String(delTarget).replace(/\D/g, '').slice(-8)
      const rowHit = () => wc.executeJavaScript(`(function(){
        var isPhone=${isPhone ? 'true' : 'false'};var target=${JSON.stringify(isPhone ? digitsTail : delTarget)};
        function norm(s){return (s||"").replace(/\\s+/g," ").trim();}
        var els=Array.from(document.querySelectorAll("div,span"));
        var best=null;
        for(var i=0;i<els.length;i++){
          var e=els[i];var t=norm(e.innerText||"");
          if(!t)continue;
          var hit;
          if(isPhone){var dg=t.replace(/\\D/g,"");hit=dg.length>=8&&dg.indexOf(target)!==-1;}
          else{hit=t.indexOf("@")!==-1&&t.indexOf(target)!==-1;}
          if(!hit)continue;
          var r=e.getBoundingClientRect();if(r.width<2||r.height<2)continue;
          var score=r.width*r.height;
          if(!best||score<best.score){best={score:score,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:t.substring(0,70)};}
        }
        return best;})()`).catch(() => null)
      // Gate: dialog đang mở ĐÚNG contact mục tiêu (tránh xóa nhầm row kề)
      const dialogOnTarget = () => wc.executeJavaScript(`(function(){
        var d=document.querySelector('div[role="dialog"]');if(!d)return false;
        var t=(d.innerText||'');
        var isPhone=${isPhone ? 'true' : 'false'};var target=${JSON.stringify(isPhone ? digitsTail : delTarget)};
        var hasTarget=isPhone?(t.replace(/\\D/g,"").indexOf(target)!==-1):t.indexOf(target)!==-1;
        return hasTarget && /delete/i.test(t);
      })()`).catch(() => false)
      const oldGone = () => wc.executeJavaScript(`(function(){
        var isPhone=${isPhone ? 'true' : 'false'};var target=${JSON.stringify(isPhone ? digitsTail : delTarget)};
        var t=(document.body?document.body.innerText:'');
        if(isPhone)return t.replace(/\\D/g,"").indexOf(target)===-1;
        return t.indexOf(target)===-1;
      })()`).catch(() => false)

      log(`🗑 Contact flow: xóa ${isPhone ? 'số điện thoại' : 'email'} cũ ${delTarget}...`)
      if (!await loadContactPage()) { log('⚠ Contact flow: không load lại trang contact'); return res }
      let row = null
      for (let i = 0; i < 6 && !row && !this.isAborted; i++) {
        row = await rowHit()
        if (!row) await sleep(1500)
      }
      if (!row) { log('⚠ Contact flow: không thấy contact cũ trong danh sách'); return res }

      await mouseClick(row.x, row.y)
      await sleep(2000)
      let detailOk = false
      for (let i = 0; i < 5 && !detailOk && !this.isAborted; i++) {
        detailOk = await dialogOnTarget()
        if (!detailOk) { await sleep(1200); await mouseClick(row.x, row.y) }
      }
      if (!detailOk) { log('⚠ Contact flow: không mở được đúng contact cũ — dừng xóa'); return res }

      const delTexts = isPhone ? ['Delete phone number', 'Delete number', 'Remove number'] : ['Delete email address', 'Remove email address', 'Delete email', 'Xóa địa chỉ email', 'Xóa email']
      let delClicked = await clickText(delTexts, true, 20000)
      if (!delClicked) {
        // 30-10: nút Delete của FB đổi text — dump các nút trong dialog để soi + thử khớp mềm
        const dbg = await wc.executeJavaScript(`(function(){
          var d = document.querySelector('div[role="dialog"]');
          if (!d) return '(không có dialog)';
          var els = Array.from(d.querySelectorAll('button, div[role="button"], a, span'));
          var out = [];
          for (var i = 0; i < els.length; i++) {
            var r = els[i].getBoundingClientRect();
            if (r.width < 20 || r.height < 8) continue;
            var t = ((els[i].textContent || '')).trim().replace(/\\s+/g, ' ');
            if (t) out.push(t.substring(0, 40));
          }
          return out.join(' | ').substring(0, 400);
        })()`).catch(() => '')
        log(`🔍 Contact flow: nút trong dialog → ${dbg}`)
        delClicked = await clickText(['delete', 'remove', 'xóa'], false, 8000)
      }
      if (!delClicked) { log('⚠ Contact flow: không thấy nút Delete contact'); return res }
      await sleep(1500)
      if (!await clickText(['Delete', 'Xoa'], true, 15000)) { log('⚠ Contact flow: không thấy nút Delete xác nhận'); return res }
      await sleep(2500)

      if (await hasPasswordField()) {
        log('🔐 Contact flow: FB hỏi mật khẩu — điền...')
        if (!await fillInput({ sel: 'input[type="password"]', val: password }) ||
            !await clickText(['Continue', 'Tiep tuc'], true, 15000)) { log('⚠ Contact flow: xử lý mật khẩu thất bại'); return res }
        await sleep(2500)
      }

      await loadContactPage()
      let gone = false
      for (let i = 0; i < 3 && !gone; i++) { await sleep(2500); gone = await oldGone() }
      res.deletedOld = gone
      log(gone ? `✅ Contact flow: đã xóa ${isPhone ? 'số điện thoại' : 'email'} cũ` : '⚠ Contact flow: contact cũ vẫn còn trong list')
      return res
    } catch (e) {
      log(`⚠ Contact flow lỗi: ${e.message}`)
      return res
    }
  }

  // ===== 25-10: reg bằng SĐT giả → chuyển FB sang xác minh bằng email =====
  // Sau Submit với SĐT, FB hiện màn đòi mã SMS. Bấm "I didn't get the code" →
  // "Change mobile number or email address" → điền Gmail → "Add" → FB gửi OTP về
  // Gmail, flow đọc OTP bình thường phía sau tiếp tục như reg bằng email.
  async regPhoneSwitchToEmail(win, wc, log, regEmail, baseGmail) {
    const { sleep, clickText, fillInput, visibleTextInput, dumpPageState } = this._pageHelpers(win, wc, log, 'SĐT→Email')
    // Chờ màn SMS ("I didn't get the code") xuất hiện — tối đa ~30s
    let smsScreen = false
    for (let t = 0; t < 15 && !smsScreen && !this.isAborted && !win.isDestroyed(); t++) {
      const body = await wc.executeJavaScript('((document.body && document.body.innerText) || "").toLowerCase()').catch(() => '')
      if (!body) { await sleep(2000); continue }
      if (/didn'?t get the code|không nhận được mã|khong nhan duoc ma/.test(body)) { smsScreen = true; break }
      // FB đã gửi mã email luôn (đôi khi SĐT bị nuốt, đi theo email cũ) -> không cần chuyển
      if (/confirmation code|enter this code|nhập mã xác nhận|we (?:sent|emailed).*email|mã xác nhận/.test(body) && !/mobile|sms|điện thoại/.test(body)) {
        log('ℹ FB đã gửi mã về email luôn — bỏ qua bước chuyển từ SĐT')
        return true
      }
      await sleep(2000)
    }
    if (!smsScreen) {
      log('⚠ Không thấy màn "I didn\'t get the code" sau khi Submit bằng SĐT — tiếp tục chờ OTP như thường')
      return false
    }
    log("👉 Bấm \"I didn't get the code\"...")
    if (!await clickText(["I didn't get the code", 'I didnt get the code', "I didn't get a code", 'Không nhận được mã', 'Khong nhan duoc ma'], true, 20000)) {
      await dumpPageState("không bấm được I didn't get the code")
      return false
    }
    await sleep(2000)
    log('👉 Bấm "Change mobile number or email address"...')
    // 28-10: text thật trên màn mới là "Change mobile number or email" (không có "address")
    if (!await clickText(['Change mobile number or email address', 'Change mobile number or email', 'Change mobile number', 'Đổi số điện thoại hoặc địa chỉ email', 'Doi so dien thoai'], true, 20000)) {
      await dumpPageState('không thấy Change mobile number or email address')
      return false
    }
    await sleep(2000)
    // Điền Gmail vào ô rồi bấm Add — thử email reg trước, FB chối ("already/in use") thì thử base gmail
    // 27-10: Add phải bấm TRONG dialog + xác minh FB chuyển màn mã; trượt thì thử lại 3 lần
    const clickAddInDialog = async () => {
      const pos = await wc.executeJavaScript(`(function(){
        var dlg = document.querySelector('div[role="dialog"]');
        var scope = dlg || document;
        var els = Array.from(scope.querySelectorAll('div[role="button"], button, [role="none"] span, span'));
        var best = null;
        for (var i = 0; i < els.length; i++) {
          var e = els[i];
          var t = ((e.innerText || '') || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          if (t !== 'add' && t !== 'thêm' && t !== 'them') continue;
          var r = e.getBoundingClientRect();
          if (r.width < 20 || r.height < 12) continue;
          var score = r.width * r.height;
          if (!best || score < best.score) best = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), s: score };
        }
        return best;
      })()`).catch(() => null)
      if (!pos) return false
      const wcx = win.webContents
      wcx.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      await sleep(70)
      wcx.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      return true
    }
    const codeScreenUp = async () => {
      const t2 = await wc.executeJavaScript('((document.body && document.body.innerText) || "").toLowerCase()').catch(() => '')
      return !!t2 && /enter the code|confirmation code|we sent|mã xác nhận|check your email/.test(t2)
    }
    const candidates = [regEmail, baseGmail].filter((v, i, a) => v && a.indexOf(v) === i)
    for (const gm of candidates) {
      let added = false
      for (let aTry = 1; aTry <= 3 && !added && !this.isAborted && !win.isDestroyed(); aTry++) {
        if (!await visibleTextInput()) { await dumpPageState('không thấy ô nhập email sau khi đổi phương thức'); return false }
        if (!await fillInput({ sel: 'div[role="dialog"] input[type="text"]', val: gm }) &&
            !await fillInput({ sel: 'input[type="text"]', val: gm })) { log('⚠ Không điền được email vào ô'); return false }
        await sleep(800)
        if (!await clickAddInDialog()) {
          if (!await clickText(['Add', 'Thêm'], true, 8000)) { log(`⚠ Không thấy nút Add (lần ${aTry}/3)`); continue }
        }
        await sleep(4000)
        if (await codeScreenUp()) { added = true; break }
        const errTxt = await wc.executeJavaScript('((document.body && document.body.innerText) || "").toLowerCase()').catch(() => '')
        if (errTxt && /already|in use|đã được sử dụng|da duoc su dung|try another email|invalid email|không hợp lệ/.test(errTxt)) {
          log(`⚠ FB từ chối ${gm} — thử địa chỉ khác...`)
          break
        }
        log(`⚠ Bấm Add rồi nhưng chưa thấy màn nhập mã — thử lại (${aTry}/3)...`)
      }
      if (!added) continue
      log(`📧 Đã Add email ${gm} — FB sẽ gửi OTP về Gmail, đọc OTP như bình thường...`)
      return true
    }
    await dumpPageState('FB không nhận email nào sau Add')
    return false
  }

  // ===== Mobile wbloks (m.facebook.com/reg): điền input / bấm nút theo aria-label bằng tọa độ vật lý =====
  // Form wbloks là React-controlled: click tọa độ + gõ thật (Ctrl+A → Backspace → insertText) mới ăn
  async _wbloksFillInput(win, wc, ariaLabels, value, log) {
    const labelList = Array.isArray(ariaLabels) ? ariaLabels : [ariaLabels]
    const pos = await wc.executeJavaScript(`(function(){
      var labels = ${JSON.stringify(labelList)};
      var ins = Array.from(document.querySelectorAll('input, textarea'));
      for (var i = 0; i < ins.length; i++) {
        var e = ins[i];
        var r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        var al = (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.name || '');
        for (var j = 0; j < labels.length; j++) {
          if (al.toLowerCase().indexOf(labels[j].toLowerCase()) !== -1) {
            e.scrollIntoView({block: 'center'});
            var r2 = e.getBoundingClientRect();
            return {x: Math.round(r2.left + r2.width/2), y: Math.round(r2.top + r2.height/2), label: labels[j]};
          }
        }
      }
      return null;
    })()`).catch(() => null)
    if (!pos) return false
    wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await new Promise(r => setTimeout(r, 70))
    wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await new Promise(r => setTimeout(r, 250))
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await new Promise(r => setTimeout(r, 40))
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await new Promise(r => setTimeout(r, 40))
    await wc.insertText(String(value)).catch(() => {})
    await new Promise(r => setTimeout(r, 400))
    // Verify giá trị đã vào
    const ok = await wc.executeJavaScript(`(function(){
      var labels = ${JSON.stringify(labelList)};
      var ins = Array.from(document.querySelectorAll('input'));
      for (var i = 0; i < ins.length; i++) {
        var e = ins[i];
        var al = (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.name || '');
        for (var j = 0; j < labels.length; j++) {
          if (al.toLowerCase().indexOf(labels[j].toLowerCase()) !== -1) return e.value === ${JSON.stringify(String(value))};
        }
      }
      return false;
    })()`).catch(() => false)
    if (!ok) log(`⚠ wbloks: ô "${labelList[0]}" chưa nhận đúng giá trị`)
    return ok
  }

  async _wbloksClick(win, wc, labels, log, maxWaitMs = 20000, opts = {}) {
    const labelList = Array.isArray(labels) ? labels : [labels]
    const exact = !!opts.exact
    // exact=true: khớp CHÍNH XÁC text (phân biệt Male vs Female — 'male' là substring của 'female'!)
    // và quét cả div/span vì option giới tính wbloks là row div trần
    const sel = exact
      ? '[role="button"], [role="radio"], button, a, label, div, span, input[type="submit"]'
      : '[role="button"], [role="radio"], button, a, label, input[type="submit"]'
    const start = Date.now()
    while (Date.now() - start < maxWaitMs) {
      if (this.isAborted || win.isDestroyed()) return null
      // Tìm trên toàn trang: cuộn dần xuống (nút Next nhiều khi nằm dưới fold)
      const pos = await wc.executeJavaScript(`(function(){
        var labels = ${JSON.stringify(labelList)};
        var exact = ${exact ? 'true' : 'false'};
        var els = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
        for (var i = 0; i < els.length; i++) {
          var e = els[i];
          var r = e.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          var alEl = (e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          var txEl = ((e.innerText || e.textContent || e.value || '') + '').replace(/\\s+/g, ' ').trim().toLowerCase();
          for (var j = 0; j < labels.length; j++) {
            var L = labels[j].toLowerCase();
            var hit = exact ? (alEl === L || txEl === L) : (alEl.indexOf(L) !== -1 || txEl.indexOf(L) !== -1);
            if (hit) {
              e.scrollIntoView({block: 'center'});
              var r2 = e.getBoundingClientRect();
              return {x: Math.round(r2.left + r2.width/2), y: Math.round(r2.top + r2.height/2), label: labels[j]};
            }
          }
        }
        // Chưa thấy: cuộn xuống 1 màn (tối đa 4 lần cuộn trong 1 lượt tìm)
        if (window.__wbScrollCount === undefined) window.__wbScrollCount = 0;
        if (window.__wbScrollCount < 4 && (window.innerHeight + window.scrollY) < document.body.scrollHeight) {
          window.__wbScrollCount++;
          window.scrollBy(0, window.innerHeight * 0.8);
          return 'SCROLLED';
        }
        window.__wbScrollCount = 0;
        window.scrollTo(0, 0);
        return null;
      })()`).catch(() => null)
      if (pos === 'SCROLLED') { await new Promise(r => setTimeout(r, 500)); continue }
      if (pos) {
        wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
        await new Promise(r => setTimeout(r, 70))
        wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
        await new Promise(r => setTimeout(r, 300))
        return pos
      }
      await new Promise(r => setTimeout(r, 600))
    }
    return null
  }

  // ===== Vòng thích ứng form mobile wbloks: mỗi màn điền thứ mình có rồi bấm Next =====
  // Trả về { ok, reachedOtp, reason } — reachedOtp = đã tới màn nhập mã xác nhận email
  async runMobileWbloksFlow(win, wc, { firstName, lastName, birthDay, birthMonth, birthYear, gender, email, password, log }) {
    const genderLabel = String(gender) === '2' ? 'Male' : 'Female'   // engine: '2'=Nam
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const mName = monthNames[parseInt(birthMonth, 10) - 1] || 'January'
    let sawOtp = false
    const screenInfo = () => wc.executeJavaScript(`(function(){
      var t = (document.body ? document.body.innerText : '');
      var els = Array.from(document.querySelectorAll('input, select, [role="button"][aria-label], [role="radio"][aria-label]'));
      var labels = [];
      for (var i = 0; i < els.length; i++) {
        var e = els[i]; var r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        var al = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || (e.tagName === 'SELECT' ? 'select' : e.type || '');
        if (al) labels.push(al + (e.tagName === 'SELECT' ? '(select)' : ''));
      }
      var otpInput = !!document.querySelector('input[aria-label*="code" i], input[name="approvals_code"], input[autocomplete="one-time-code"], input[name*="code" i]');
      return {labels: labels.slice(0, 12), otp: otpInput, text: t.replace(/\\s+/g, ' ').substring(0, 200)};
    })()`).catch(() => null)

    // Tối đa 10 màn — mỗi vòng: nhìn màn, điền gì có, bấm Next
    for (let step = 1; step <= 10 && !sawOtp && !this.isAborted && !win.isDestroyed(); step++) {
      await new Promise(r => setTimeout(r, 1200))
      const info = await screenInfo()
      if (!info) continue

      if (info.otp) { sawOtp = true; log('🔢 Mobile: tới màn nhập mã xác nhận (OTP) — chuyển sang chờ mã email'); break }

      const lbl = (info.labels || []).join(', ')
      log(`📱 Mobile màn ${step}: ${lbl || info.text.substring(0, 80)}`)

      // Màn INTRO còn đó ("Get started on Facebook with a Meta Account") → bấm Get started ngay
      // (dấu hiệu = heading intro trong body text — form thật KHÔNG có heading này)
      const introScreen = /get started on facebook|with a meta account|join facebook/i.test(info.text || '')
      if (introScreen && !info.otp) {
        const hit = await this._wbloksClick(win, wc, ['Get started', 'Create new account', 'Tạo tài khoản mới'], log, 8000)
        if (hit) { log('👉 Mobile: (vòng) bấm lại "Get started"'); await new Promise(r => setTimeout(r, 3500)); continue }
      }

      // Màn tên
      if (info.labels.some(l => /first name/i.test(l))) {
        await this._wbloksFillInput(win, wc, ['First name', 'first'], firstName, log)
        await new Promise(r => setTimeout(r, 300))
        await this._wbloksFillInput(win, wc, ['Last name', 'last', 'surname'], lastName, log)
      }
      // Màn email / số ĐT
      if (info.labels.some(l => /email|mobile number|phone/i.test(l)) && !info.labels.some(l => /password/i.test(l))) {
        // có khi phải bấm "Sign up with email" trước
        const switchBtn = await this._wbloksClick(win, wc, ['Sign up with email', 'Sign up with email address'], log, 2500).catch(() => null)
        if (switchBtn) { log('👉 Mobile: bấm "Sign up with email"'); await new Promise(r => setTimeout(r, 1500)) }
        await this._wbloksFillInput(win, wc, ['email', 'email address', 'mobile number', 'phone number'], email, log)
      }
      // Màn mật khẩu
      if (info.labels.some(l => /password/i.test(l))) {
        await this._wbloksFillInput(win, wc, ['password', 'Password'], password, log)
      }
      // Màn "How old are you?" — điền TUỔI (tính từ birthYear); FB hay hiện popup xác nhận -> OK
      if (/how old are you/i.test(info.text || '') || info.labels.some(l => /^age$/i.test(l) || /your age/i.test(l))) {
        const now = new Date()
        let age = now.getFullYear() - parseInt(birthYear, 10)
        const mDiff = (now.getMonth() + 1) - parseInt(birthMonth, 10)
        if (mDiff < 0 || (mDiff === 0 && now.getDate() < parseInt(birthDay, 10))) age--
        if (age < 5 || age > 90) age = 20 + Math.floor(Math.random() * 10)
        const filledAge = await this._wbloksFillInput(win, wc, ['Age', 'your age'], String(age), log)
        log(`🎂 Mobile age: điền ${age} (${filledAge ? 'OK' : 'KHÔNG được'})`)
        if (!filledAge) {
          // Không điền được tuổi -> chuyển sang màn nhập ngày sinh (nhánh birthday xử lý)
          const useDob = await this._wbloksClick(win, wc, ['Use date of birth'], log, 5000)
          if (useDob) { log('👉 Mobile: bấm "Use date of birth"'); await new Promise(r => setTimeout(r, 2500)); continue }
        }
      }

      // Màn ngày sinh — wbloks mobile dùng input[type=date]: CLICK vào ô rồi GÕ MMDDYYYY
      // (test 12:00 — insertText KHÔNG ăn; gõ char từng ký tự ăn: value "2006-10-22", "20 years old")
      if (info.labels.some(l => /day|month|year|birth/i.test(l))) {
        const digits = String(birthMonth).padStart(2, '0') + String(birthDay).padStart(2, '0') + String(birthYear)
        const datePos = await wc.executeJavaScript(`(function(){
          var e = document.querySelector('input[type="date"]');
          if (!e) return null;
          e.scrollIntoView({block: 'center'});
          var r = e.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return null;
          // click vùng TEXT (35% trái) — tránh icon lịch bên phải làm mở popup pick date
          return {tx: Math.round(r.left + r.width*0.35), cx: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)};
        })()`).catch(() => null)
        if (datePos) {
          const expected = `${birthYear}-${String(birthMonth).padStart(2, '0')}-${String(birthDay).padStart(2, '0')}`
          const readDate = () => wc.executeJavaScript(`(function(){
            var e = document.querySelector('input[type="date"]');
            return e ? (e.value || '') : '';
          })()`).catch(() => '')
          const typeDigits = async (mode) => {
            for (const ch of digits) {
              try {
                if (mode === 'cdp') {
                  win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch }).catch(() => {})
                  await sleep(30)
                  win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }).catch(() => {})
                } else {
                  wc.sendInputEvent({ type: 'char', keyCode: ch })
                }
                await sleep(110)
              } catch {}
            }
          }
          let done = false
          for (let attempt = 1; attempt <= 3 && !done && !this.isAborted; attempt++) {
            // click vào ô (CDP click không phụ thuộc focus; fallback sendInputEvent)
            try {
              win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: datePos.tx, y: datePos.y, button: 'left', clickCount: 1 }).catch(() => {})
              await sleep(60)
              win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: datePos.tx, y: datePos.y, button: 'left', clickCount: 1 }).catch(() => {})
            } catch {
              wc.sendInputEvent({ type: 'mouseDown', x: datePos.tx, y: datePos.y, button: 'left', clickCount: 1 })
              await sleep(70)
              wc.sendInputEvent({ type: 'mouseUp', x: datePos.tx, y: datePos.y, button: 'left', clickCount: 1 })
            }
            await sleep(500)
            // Ưu tiên CDP key events (đa luồng: window không focus thì sendInputEvent char bị drop)
            await typeDigits(attempt === 1 ? 'cdp' : (attempt === 2 ? 'cdp' : 'char'))
            await sleep(500)
            const got = await readDate()
            if (got === expected) {
              done = true
              log(`🎂 Mobile birthday: gõ ${digits} -> ${got} (CDP, lần ${attempt})`)
            } else {
              log(`⚠ Mobile birthday lần ${attempt}: ô date = "${got || '(trống)'}" ≠ ${expected} — thử cách khác`)
            }
          }
          if (!done) {
            // Chót: native setter + events (nhặng kém với React wbloks nhưng còn hơn để ngày hôm nay)
            await wc.executeJavaScript(`(function(){
              var e = document.querySelector('input[type="date"]');
              if (!e) return;
              var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(e, ${JSON.stringify(expected)});
              e.dispatchEvent(new Event('input', {bubbles: true}));
              e.dispatchEvent(new Event('change', {bubbles: true}));
            })()`).catch(() => {})
            const got = await readDate()
            log(`🎂 Mobile birthday: native setter -> ${got}`)
          }
        } else {
          // Fallback bản UI cũ: select Day/Month/Year hoặc input text
          const setSelect = async (names, val) => wc.executeJavaScript(`(function(){
            var names = ${JSON.stringify(names)}; var val = ${JSON.stringify(String(val))};
            var sels = Array.from(document.querySelectorAll('select'));
            for (var i = 0; i < sels.length; i++) {
              var s = sels[i]; var r = s.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) continue;
              var al = (s.getAttribute('aria-label') || s.name || s.id || '').toLowerCase();
              for (var j = 0; j < names.length; j++) {
                if (al.indexOf(names[j]) !== -1) {
                  var opt = Array.from(s.options).find(function(o){ return (o.value === val) || (o.textContent.trim().toLowerCase() === val.toLowerCase()) });
                  if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', {bubbles: true})); return 'SET:' + names[j]; }
                }
              }
            }
            return null;
          })()`).catch(() => null)
          const d = await setSelect(['day'], birthDay)
          const m = await setSelect(['month'], mName)
          const y = await setSelect(['year'], birthYear)
          log(`🎂 Mobile birthday (select): ${d || '?'} / ${m || '?'} / ${y || '?'}`)
          if (!d) await this._wbloksFillInput(win, wc, ['Day'], String(birthDay), log).catch(() => {})
          if (!m) await this._wbloksFillInput(win, wc, ['Month'], mName, log).catch(() => {})
          if (!y) await this._wbloksFillInput(win, wc, ['Year'], String(birthYear), log).catch(() => {})
        }
      }
      // Màn giới tính — row radio Female/Male/More options + nút Next, hoặc select "Select your gender"
      // BẮT BUỘC exact=true: tìm 'Male' contains sẽ dính 'Female' ('male' là substring của 'female')!
      if (info.labels.some(l => /male|female|gender|custom/i.test(l)) || /what'?s your gender/i.test(info.text || '')) {
        const genderSet = await wc.executeJavaScript(`(function(){
          var want = ${JSON.stringify(genderLabel)};
          var sels = Array.from(document.querySelectorAll('select'));
          for (var i = 0; i < sels.length; i++) {
            var s = sels[i]; var r = s.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            var al = (s.getAttribute('aria-label') || s.name || '').toLowerCase();
            if (al.indexOf('gender') !== -1) {
              var opt = Array.from(s.options).find(function(o){ return o.textContent.trim().toLowerCase() === want.toLowerCase(); });
              if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', {bubbles: true})); return 'SET_SELECT:' + want; }
            }
          }
          return null;
        })()`).catch(() => null)
        if (genderSet) {
          log(`⚧ Mobile gender: ${genderSet}`)
        } else {
          const gRow = await this._wbloksClick(win, wc, [genderLabel], log, 6000, { exact: true })
          if (!gRow) await this._wbloksClick(win, wc, [genderLabel], log, 4000).catch(() => null)
          log(`⚧ Mobile gender: chọn ${genderLabel}${gRow ? ' (đúng row)' : ''}`)
        }
      }

      // Bấm nút chuyển màn: Next/Continue/Submit + các màn đặc biệt Save / I agree.
      // Không có gì thì thử nút phụ Not now / Skip
      let next = await this._wbloksClick(win, wc, ['Next', 'Continue', 'Submit', 'Create account', 'Sign up', 'Save', 'I agree', 'Agree'], log, 12000)
      if (!next) {
        next = await this._wbloksClick(win, wc, ['Not now', 'Skip', 'Bỏ qua'], log, 5000)
        if (next) log(`👉 Mobile: bấm "${next.label}" (nút phụ)`)
      }
      if (next) {
        log(`👉 Mobile: bấm "${next.label}"`)
        await new Promise(r => setTimeout(r, 2500))
        // Sau Next: FB hay bật popup/dialog xác nhận (tuổi/date/verify) -> bấm OK/Yes/Got it
        const ack = await this._wbloksClick(win, wc, ['OK', 'Okay', 'Ok', 'Yes', 'Got it', 'Continue'], log, 6000)
        if (ack && ack.label !== next.label) {
          log(`👉 Mobile: bấm "${ack.label}" (xác nhận popup sau ${next.label})`)
          await new Promise(r => setTimeout(r, 2000))
        }
      } else {
        // không còn nút Next mà cũng chưa tới OTP — có thể màn xong (Done) hoặc kẹt
        const again = await screenInfo()
        if (again && again.otp) { sawOtp = true; break }
        log(`⚠ Mobile màn ${step}: không thấy nút Next — dump màn: ${(again && again.labels || []).join(', ') || (again && again.text || '').substring(0, 100)}`)
        if (step >= 3) return { ok: false, reachedOtp: false, reason: 'Mobile kẹt: không thấy nút Next' }
      }
      await new Promise(r => setTimeout(r, 2500))
    }
    return { ok: sawOtp, reachedOtp: sawOtp, reason: sawOtp ? '' : 'Mobile chưa tới màn OTP sau 10 màn' }
  }

  // ===== v2 COOKIE GMAIL: mở cửa sổ Gmail nạp cookie từ IMPORT =====
  async openGmailSession({ gmailCookie, slot, showBrowser, log }) {
    // Lock theo bộ cookie: nick chạy sau chờ nick trước xong mới dùng cửa sổ Gmail chung
    const idHash = crypto.createHash('sha1').update(String(gmailCookie || '').trim()).digest('hex').substring(0, 16)
    this._gmailHash = idHash   // cleanup cần để gỡ khỏi danh sách cửa sổ sống khi đóng
    const prevLock = gmailLocks.get(idHash) || Promise.resolve()
    let release = () => {}
    const myTurn = new Promise(r => { release = r })
    gmailLocks.set(idHash, prevLock.then(() => myTurn))
    await prevLock
    // Safety: nếu reg treo mà không gọi cleanup -> 15 phút tự nhả khóa cho nick sau
    setTimeout(() => { try { release() } catch {} }, 15 * 60 * 1000).unref()

    // Cửa sổ Gmail của bộ cookie này còn sống -> DÙNG LẠI, không nạp lại cookie
    const existing = gmailLiveWindows.get(idHash)
    if (existing && existing.win && !existing.win.isDestroyed()) {
      try { await Promise.race([existing.win.webContents.loadURL('https://mail.google.com/mail/u/0/#inbox'), sleep(25000)]) } catch {}
      await sleep(2500)
      const u2 = (existing.win.webContents.getURL() || '')
      if (!(u2.includes('accounts.google.com') || u2.includes('ServiceLogin'))) {
        log(`📧 Dùng lại cửa sổ Gmail đang mở (${existing.baseGmail}) — session sống, không tắt`)
        return { ok: true, win: existing.win, baseGmail: existing.baseGmail, release }
      }
      log('📧 Cửa sổ Gmail cũ bị đá ra đăng nhập — mở lại từ cookie import')
      try { existing.win.destroy() } catch {}
      gmailLiveWindows.delete(idHash)
    }

    const ses = session.fromPartition(`gmailv2_${idHash}_${Date.now()}`)
    ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
    const posX = 560 + (slot % 4) * 445
    const posY = 40 + Math.floor(slot / 4) * 850
    const win = new BrowserWindow({
      x: posX, y: posY,
      width: 480, height: 860,
      show: Boolean(showBrowser),
      title: 'Gmail (v2 OTP)',
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: false, backgroundThrottling: false }
    })
    const wc = win.webContents
    // Nạp cookie Google. gmailCookie có thể là:
    //  - chuỗi "name=value; name2=value2" (flatten từ IMPORT)
    //  - JSON array cookie object (file export cookie của trình duyệt)
    // Lưu ý 24-10: cookie tiền tố __Host-* BẮT BUỘC secure + path=/ + KHÔNG set domain —
    // set sai là Chromium từ chối thẳng ("violated prefix rules", mất 3 cookie/lần nạp)
    const setGoogleCookie = async (name, value, { domain, path, expirationDate, httpOnly, sameSite, hostOnly } = {}) => {
      const isHost = /^__Host-/i.test(name)
      const isMailDomain = !domain || /^(\.?)mail\.google\.com$/i.test(domain)
      const conf = {
        url: isMailDomain ? 'https://mail.google.com/' : 'https://www.google.com/',
        name, value, path: isHost ? '/' : (path || '/'), secure: true
      }
      if (!isHost && domain && !hostOnly) conf.domain = domain
      if (expirationDate) conf.expirationDate = expirationDate
      if (httpOnly) conf.httpOnly = true
      if (sameSite === 'no_restriction' || sameSite === 'lax' || sameSite === 'strict') conf.sameSite = sameSite
      try { await ses.cookies.set(conf); return true } catch (e) { log(`⚠ Cookie Google ${name}: ${e.message}`); return false }
    }
    let ok = 0, total = 0
    const rawCk = String(gmailCookie || '').trim()
    if (rawCk.startsWith('[')) {
      // JSON array: giữ nguyên domain/path của từng cookie (GMAIL_AT/OSID thuộc mail.google.com)
      let arr = []
      try { arr = JSON.parse(rawCk) } catch (e) { log(`⚠ Cookie JSON không đọc được: ${e.message}`) }
      for (const c of (Array.isArray(arr) ? arr : [])) {
        if (!c || !c.name || c.value === undefined || c.value === null) continue
        total++
        if (await setGoogleCookie(c.name, String(c.value), { domain: c.domain, path: c.path, expirationDate: c.expirationDate, httpOnly: c.httpOnly, sameSite: c.sameSite, hostOnly: !!c.hostOnly })) ok++
      }
    } else {
      const pairs = rawCk.split(';').map(s => s.trim()).filter(Boolean)
      total = pairs.length
      for (const pair of pairs) {
        const i = pair.indexOf('=')
        if (i === -1) continue
        const name = pair.substring(0, i).trim()
        const value = pair.substring(i + 1).trim()
        if (!name || !value) continue
        // chuỗi flatten mất domain gốc: __Host-* phải set hostOnly, còn lại lên .google.com
        if (await setGoogleCookie(name, value, { domain: '.google.com' })) ok++
      }
    }
    log(`📧 Gmail: nạp ${ok}/${total} cookie — mở inbox...`)
    try { await Promise.race([wc.loadURL('https://mail.google.com/mail/u/0/#inbox'), sleep(35000)]) } catch {}
    await sleep(4000)
    // Cookie chết: bị đá ra trang đăng nhập
    const url = (wc.getURL() || '')
    if (url.includes('accounts.google.com') || url.includes('ServiceLogin')) {
      try { win.destroy() } catch {}
      release()
      return { ok: false, error: 'Cookie Gmail chết (bị đá ra trang đăng nhập) — lấy cookie Gmail mới' }
    }
    // Đọc base gmail từ trang (nút tài khoản có aria-label chứa @gmail.com)
    let baseGmail = ''
    for (let t = 0; t < 10 && !baseGmail && !win.isDestroyed(); t++) {
      baseGmail = await wc.executeJavaScript(`(function(){
        var el = document.querySelector('[aria-label*="@gmail.com"], [aria-label*="@googlemail.com"]');
        if (el) {
          var m = (el.getAttribute('aria-label') || '').match(/[\\w.+-]+@(?:gmail|googlemail)\\.com/i);
          if (m) return m[0].toLowerCase();
        }
        var m2 = (document.title || '').match(/[\\w.+-]+@(?:gmail|googlemail)\\.com/i);
        return m2 ? m2[0].toLowerCase() : '';
      })()`).catch(() => '')
      if (!baseGmail) await sleep(1500)
    }
    if (!baseGmail) {
      try { win.destroy() } catch {}
      release()
      return { ok: false, error: 'Không đọc được địa chỉ Gmail từ trang — cookie sống nhưng inbox không render (thử lại)' }
    }
    log(`📧 Gmail đăng nhập OK: ${baseGmail}`)
    // Đăng ký cửa sổ sống để lần reg sau DÙNG LẠI (không tắt — session Google giữ nguyên)
    gmailLiveWindows.set(idHash, { win, ses, baseGmail })
    return { ok: true, win, baseGmail, release }
  }

  // ===== v2: bấm "I didn't get the code"/"Resend" trên trang mã xác nhận — FB KHÔNG tự
  // gửi lại mã khi điền sai, phải bấm nút nó mới gửi mail mới =====
  async clickResendCode(wc, log) {
    const CLICK_PATS = JSON.stringify(["didn't get the code", "didnt get the code", "didn't receive the code", "resend code", "send code again", "gửi lại mã", "gửi lại", "không nhận được mã"])
    const RESEND_PATS = JSON.stringify(["resend code", "send code again", "resend", "gửi lại mã", "gửi lại"])
    const tryClick = async (fr, patsJson) => fr.executeJavaScript(`(function(){
          var els = Array.from(document.querySelectorAll('button, [role="button"], a'));
          var pats = ${patsJson};
          var best = null;
          for (var i = 0; i < els.length; i++) {
            var e = els[i];
            if (e.offsetWidth <= 0) continue;
            var t = ((e.innerText || e.textContent || '') + '').replace(/\\s+/g, ' ').trim().toLowerCase();
            if (!t || t.length > 60) continue;
            for (var j = 0; j < pats.length; j++) {
              if (t.indexOf(pats[j]) !== -1 && (!best || t.length < best.t.length)) { best = { el: e, t: t }; }
            }
          }
          if (best) { best.el.scrollIntoView({ block: 'center' }); best.el.click(); return best.t; }
          return null;
        })()`).catch(() => null)
    try {
      const frs = [wc.mainFrame, ...wc.mainFrame.framesInSubtree]
      for (const fr of frs) {
        if (!fr) continue
        const clicked = await tryClick(fr, CLICK_PATS)
        if (clicked) {
          log(`📧 V2: đã bấm "${clicked}" — yêu cầu FB gửi lại mã...`)
          await sleep(2500)
          // Layout "I didn't get the code" mở menu phụ — bấm tiếp nút Resend bên trong nếu có
          const second = await tryClick(fr, RESEND_PATS)
          if (second) log(`📧 V2: xác nhận gửi lại qua "${second}"`)
          return true
        }
      }
    } catch {}
    return false
  }

  // ===== v2 COOKIE GMAIL: poll OTP bằng cách đọc DOM Gmail — ưu tiên SEARCH "to:<variant>"
  // (chỉ thư gửi đúng địa chỉ variant của phiên này; bug 24-10: scan inbox trần lấy nhầm
  // OTP của nick trước dùng cùng base gmail — mã 102094 bị trả lại cho 2 phiên khác nhau)
  async pollGmailCookieOtp(gmailWin, { firstName, variant = '', excludeCodes = null, maxAttempts = 40 }, log) {
    const interval = 6000
    const used = new Set()
    const htmlMode = this._gmailHtmlMode === true
    const INBOX_URL = htmlMode ? 'https://mail.google.com/mail/u/0/h/' : 'https://mail.google.com/mail/u/0/#inbox'
    const searchUrl = variant
      ? (htmlMode
          ? 'https://mail.google.com/mail/u/0/h/?q=' + encodeURIComponent('to:' + variant + ' newer_than:1d')
          : 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent('to:' + variant + ' newer_than:1d'))
      : ''
    const scanRows = async (strictName) => {
      const rowsJson = await gmailWin.webContents.executeJavaScript(`(function(){
          var firstName = ${JSON.stringify(firstName || '')};
          var out = [];
          var rows = Array.from(document.querySelectorAll('tr.zA'));
          for (var i = 0; i < rows.length; i++) {
            var t = (rows[i].innerText || '').replace(/\\s+/g, ' ');
            if (!/facebook/i.test(t)) continue;
            if (!/is your Facebook (confirmation )?code|enter this code|là mã Facebook|la ma Facebook/i.test(t)) continue;
            var timeEl = rows[i].querySelector('.xW span[title]');
            var timeTxt = timeEl ? ((timeEl.textContent || '') + '').trim() : '';
            // Thư hôm nay: Gmail hiển thị thuần giờ ("10:52" VI hoặc "10:52 AM" EN).
            // Thư cũ hơn luôn kèm ngày ("Oct 23", "24 thg 10") -> không khớp
            var isToday = /^\\d{1,2}:\\d{2}(\\s?(AM|PM))?$/i.test(timeTxt);
            var m = t.match(/enter this code:\\s*(\\d{4,8})/i) || t.match(/(\\d{4,8})\\s+(?:is your Facebook|là mã|la ma)/i);
            out.push({ code: m ? m[1] : '', timeTxt: timeTxt, isToday: isToday,
              nameHit: firstName ? t.toLowerCase().indexOf(String(firstName).toLowerCase()) !== -1 : true,
              snippet: t.substring(0, 150) });
          }
          // Inbox HTML cơ bản: không có tr.zA — dò theo từng dòng text quanh chữ Facebook
          if (!out.length) {
            var lines = ((document.body && document.body.innerText) || '').split(/\\n+/);
            for (var L = 0; L < lines.length; L++) {
              var t2 = lines[L].replace(/\\s+/g, ' ');
              if (!/facebook/i.test(t2)) continue;
              var m2 = t2.match(/enter this code:\\s*(\\d{4,8})/i) || t2.match(/(\\d{4,8})\\s+(?:is your Facebook|là mã|la ma)/i);
              if (!m2) continue;
              var near = lines.slice(Math.max(0, L - 3), L + 4).join(' ');
              var tm = near.match(/\\b\\d{1,2}:\\d{2}(\\s?(AM|PM))?\\b/i);
              out.push({ code: m2[1], timeTxt: tm ? tm[0] : '', isToday: !!tm,
                nameHit: firstName ? near.toLowerCase().indexOf(String(firstName).toLowerCase()) !== -1 : true,
                snippet: t2.substring(0, 150), html: true });
            }
          }
          return JSON.stringify(out);
        })()`).catch(() => '[]')
      try {
        const arr = JSON.parse(rowsJson || '[]')
        // strictName=true (scan inbox trần): bắt buộc khớp tên để không lấy nhầm OTP nick khác
        return strictName ? arr.filter(r => r.nameHit) : arr
      } catch { return [] }
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.isAborted || gmailWin.isDestroyed()) return null
      log(`[gmail-cookie] Đọc inbox Gmail lần ${attempt}/${maxAttempts}...`)
      try {
        // Vòng 1: mở thẳng Gmail SEARCH to:<variant> — lọc đúng thư của địa chỉ phiên này
        if (attempt === 1 && searchUrl) {
          log(`[gmail-cookie] Search thư gửi đúng địa chỉ: to:${variant}`)
          try { await Promise.race([gmailWin.webContents.loadURL(searchUrl), sleep(20000)]) } catch {}
          await sleep(4000)
        } else {
          // reload THẬT trang (loadURL cùng URL #... là no-op -> DOM stale, không thấy thư mới)
          try { await Promise.race([gmailWin.webContents.reload(), sleep(20000)]) } catch {}
          await sleep(4000)
        }
        // Search mode: KHÔNG lọc theo tên — search to:<variant> đã bảo đảm đúng người nhận
        // (bug 24-10: snippet thư không luôn chứa tên random của phiên -> nameHit=0 oan)
        let rows = await scanRows(false)
        // Search trống: Gmail search có thể trễ index / sai cú pháp — mỗi 2 vòng fallback
        // scan inbox (cách cũ) để không treo vĩnh viễn chỉ vì search trống
        if (!rows.length && searchUrl && attempt % 2 === 0) {
          log('[gmail-cookie] Search to:variant trống — fallback scan inbox...')
          try { await Promise.race([gmailWin.webContents.loadURL(INBOX_URL), sleep(20000)]) } catch {}
          await sleep(4000)
          // Inbox trần: lọc nghiêm theo tên để không lấy nhầm OTP của nick khác
          rows = await scanRows(true)
        }
        // Ưu tiên: thư HÔM NAY + chưa dùng + không thuộc mã loại trừ
        const hit = rows.find(r => r.code && r.isToday && !used.has(r.code + r.timeTxt) && !(excludeCodes && excludeCodes.has(r.code)))
        if (hit) {
          used.add(hit.code + hit.timeTxt)
          log(`[gmail-cookie] OTP: ${hit.code} (thư ${hit.timeTxt})`)
          return { otp: hit.code, subject: hit.snippet, mailId: hit.code }
        }
        if (rows.length) log(`[gmail-cookie] ${rows.length} dòng FB quét được: ` + rows.map(r => `[mã=${r.code || '?'} | giờ="${r.timeTxt}" | hômNay=${r.isToday ? 1 : 0} | đúngTên=${r.nameHit ? 1 : 0}]`).join(' '))
        else log(`[gmail-cookie] Không quét được dòng nào (trang chưa render?)`)
      } catch (err) {
        log(`[gmail-cookie] Lỗi: ${err.message}`)
      }
      if (attempt < maxAttempts) await sleep(interval)
    }
    return null
  }

  // ===== Bộ helper DOM dùng chung cho các flow sau-reg (click toạ độ vật lý + gõ thật) =====
  // Trả về { sleep, mouseClick, clickText, fillInput, fillVisibleInput, loadPage, visibleTextInput, hasPasswordField, dumpPageState }
  _pageHelpers(win, wc, log, prefix = 'Flow') {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const mouseClick = async (x, y) => {
      wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
      await sleep(70)
      wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
      await sleep(200)
    }
    // Gõ đè lên ô đang focus: Ctrl+A -> Backspace -> insertText
    const clearAndType = async (val) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
      await sleep(40)
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
      await sleep(40)
      await wc.insertText(String(val)).catch(() => {})
    }
    // Click element theo text (ưu tiên leaf + diện tích nhỏ nhất — tránh trúng container cả cụm)
    // Tự scrollIntoView trước khi đọc toạ độ: nút dưới fold / lazy-render vẫn bấm trúng
    const clickText = async (texts, exact, maxWait) => {
      if (!Array.isArray(texts)) texts = [texts]
      const start = Date.now()
      while (Date.now() - start < (maxWait || 15000)) {
        if (this.isAborted || win.isDestroyed()) return null
        const coords = await wc.executeJavaScript(
          '(function(){' +
          'var texts=' + JSON.stringify(texts) + ';var exact=' + (exact ? 'true' : 'false') + ';' +
          'function norm(s){return (s||"").replace(/\\s+/g," ").trim().toLowerCase();}' +
          'var els=Array.from(document.querySelectorAll("div,span,a,button,[role=\\"button\\"],[role=\\"menuitem\\"],[role=\\"link\\"],label"));' +
          'var best=null;' +
          'for(var i=0;i<els.length;i++){' +
          '  var e=els[i];var t=norm(e.innerText||e.textContent);if(!t)continue;' +
          '  for(var j=0;j<texts.length;j++){' +
          '    var hit=exact?(t===texts[j].toLowerCase()):(t.indexOf(texts[j].toLowerCase())!==-1);' +
          '    if(!hit)continue;' +
          '    var r=e.getBoundingClientRect();if(r.width<2||r.height<2)continue;' +
          '    var isLeaf=(e.childElementCount===0);' +
          '    var score=(isLeaf?0:100)+r.width*r.height;' +
          '    if(!best||score<best.score){best={score:score,el:e};}' +
          '  }' +
          '}' +
          'if(!best)return null;' +
          'best.el.scrollIntoView({block:"center"});' +
          'var r=best.el.getBoundingClientRect();' +
          'return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:norm(best.el.innerText||best.el.textContent)};' +
          '})();'
        ).catch(() => null)
        if (coords) {
          await mouseClick(coords.x, coords.y)
          return coords
        }
        await sleep(600)
      }
      return null
    }
    // Điền ô input theo selector bằng click toạ độ + Ctrl+A + insertText, verify theo selector
    const fillInput = async ({ sel, val }) => {
      const pos = await wc.executeJavaScript(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();if(r.width<2||r.height<2)return null;e.scrollIntoView({block:'center'});r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`).catch(() => null)
      if (!pos) return false
      await mouseClick(pos.x, pos.y)
      await clearAndType(val)
      await sleep(400)
      return wc.executeJavaScript(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return !!e&&e.value===${JSON.stringify(String(val))};})()`).catch(() => false)
    }
    // Điền input visible đầu tiên (trừ password/hidden) — dùng cho màn OTP khi selector không ổn định
    const fillVisibleInput = async (val, excludePassword = true) => {
      const pickJs = (retExpr) => `(function(){
        var exc=${excludePassword ? 'true' : 'false'};
        var ins=Array.from(document.querySelectorAll('input')).filter(function(e){
          var r=e.getBoundingClientRect();
          if(r.width<2||r.height<2)return false;
          var t=(e.type||'').toLowerCase();
          if(t==='hidden')return false;
          if(exc&&t==='password')return false;
          if(e.disabled||e.readOnly)return false;
          return true;});
        if(!ins.length)return null;var e=ins[0];
        ${retExpr}})()`
      const pos = await wc.executeJavaScript(pickJs('e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};')).catch(() => null)
      if (!pos) return false
      await mouseClick(pos.x, pos.y)
      await clearAndType(val)
      await sleep(400)
      return wc.executeJavaScript(pickJs(`return e.value===${JSON.stringify(String(val))};`)).catch(() => false)
    }
    // Load trang, chờ render (tránh trang trắng); false nếu 3 lần vẫn trắng
    const loadPage = async (url) => {
      if (win.isDestroyed()) return false
      for (let i = 0; i < 3; i++) {
        await win.loadURL(url + (url.includes('?') ? '&' : '?') + '_r=' + Date.now()).catch(() => {})
        for (let t = 0; t < 20; t++) {
          if (this.isAborted || win.isDestroyed()) return false
          const len = await wc.executeJavaScript('(document.body ? document.body.innerText.length : 0)').catch(() => 0)
          if (len > 100) return true
          await sleep(700)
        }
      }
      return false
    }
    const visibleTextInput = () => wc.executeJavaScript(`(function(){
      var ins=Array.from(document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])'));
      return ins.some(function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0;});
    })()`).catch(() => false)
    const hasPasswordField = () => wc.executeJavaScript(`(function(){return !!Array.from(document.querySelectorAll('input[type="password"]')).find(function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0});})()`).catch(() => false)
    // Dump trạng thái trang khi flow kẹt: URL + tổng độ dài text + text các nút thấy được
    const dumpPageState = async (reason) => {
      const dbg = await wc.executeJavaScript('(function(){' +
        'var els=Array.from(document.querySelectorAll("div[role=\\"button\\"],button,a,[role=\\"menuitem\\"],input")).slice(0,60);' +
        'var out=[];for(var i=0;i<els.length;i++){var e=els[i];var r=e.getBoundingClientRect();if(r.width<2||r.height<2)continue;' +
        'var t=((e.innerText||e.textContent||"")+(e.value?(" ["+e.value+"]"):"")).replace(/\\s+/g," ").trim().substring(0,50);if(t)out.push(t);}' +
        'return JSON.stringify({url:location.href.substring(0,140),len:(document.body?document.body.innerText.length:0),els:out.slice(0,25)});})()').catch(() => null)
      if (dbg) log(`⚠ ${prefix} kẹt (${reason}): ${dbg}`)
      else log(`⚠ ${prefix} kẹt (${reason}): không dump được DOM`)
    }
    return { sleep, mouseClick, clickText, fillInput, fillVisibleInput, loadPage, visibleTextInput, hasPasswordField, dumpPageState }
  }

  // ===== Lấy mã OTP từ trang 2fa.page =====
  // Mở cửa sổ phụ (session riêng, không đụng session FB), dán key vào #listToken,
  // bấm #submit, đọc kết quả "SECRET | CODE" từ #output. Trả về chuỗi 6 số hoặc null.
  async getOtpFrom2faPage(secretBase32, mainWin, log) {
    const secret = String(secretBase32 || '').replace(/[^A-Za-z2-7]/g, '').toUpperCase()
    if (!secret) return null
    let helperWin = null
    try {
      const show = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible())
      const opts = {
        width: 720, height: 760, show,
        title: '2FA Helper',
        webPreferences: { nodeIntegration: false, contextIsolation: false, partition: `2fahelper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }
      }
      if (mainWin && !mainWin.isDestroyed()) {
        const b = mainWin.getBounds()
        opts.x = b.x + 440
        opts.y = b.y
      }
      helperWin = new BrowserWindow(opts)
      const hwc = helperWin.webContents
      const readCodeJs =
        '(function(){var o=document.getElementById("output");var s=' + JSON.stringify(secret) + ';' +
        'if(!o||!o.value)return null;' +
        'var lines=o.value.split("\\n");' +
        'for(var i=0;i<lines.length;i++){var p=lines[i].split("|");if(p.length<2)continue;' +
        'var k=p[0].replace(/[^A-Za-z2-7]/g,"").toUpperCase();if(k===s)return p[1].replace(/[^0-9]/g,"");}' +
        'return null;})()'
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (this.isAborted) return null
        try { await Promise.race([hwc.loadURL('https://2fa.page/'), sleep(30000)]) } catch {}
        // Chờ form render
        let ready = false
        for (let t = 0; t < 15; t++) {
          if (this.isAborted || helperWin.isDestroyed()) return null
          ready = await hwc.executeJavaScript('!!document.getElementById("listToken") && !!document.getElementById("submit") && !!document.getElementById("output")').catch(() => false)
          if (ready) break
          await sleep(1000)
        }
        if (!ready) { if (attempt < 2) continue; log('⚠ 2FA flow: không mở được trang 2fa.page'); return null }
        // Dán key + bấm Submit (trang sinh code bằng JS phía client)
        const out = await hwc.executeJavaScript(
          '(function(){var s=' + JSON.stringify(secret) + ';' +
          'var ta=document.getElementById("listToken");var btn=document.getElementById("submit");' +
          'if(!ta||!btn)return "NO_DOM";' +
          'ta.value=s;btn.click();return "OK";})()'
        ).catch(() => null)
        if (out !== 'OK') { if (attempt < 2) continue; log('⚠ 2FA flow: thao tác trên 2fa.page thất bại'); return null }
        // Chờ #output ra kết quả cho đúng key
        for (let t = 0; t < 10; t++) {
          if (this.isAborted || helperWin.isDestroyed()) return null
          const code = await hwc.executeJavaScript(readCodeJs).catch(() => null)
          if (code && code.length === 6) return code
          await sleep(700)
        }
      }
      return null
    } finally {
      try { if (helperWin && !helperWin.isDestroyed()) helperWin.destroy() } catch {}
    }
  }

  // ===== Flow sau-reg: bật 2FA "Authentication app" qua Accounts Center =====
  // Get started -> mật khẩu -> Continue -> (chọn Authentication app) -> Next -> bắt key + Copy key
  // -> Next -> lấy OTP từ 2fa.page theo key -> điền -> Next. Trả về { ok, key } để lưu lại lấy OTP sau này.
  async postRegTwoFactorFlow({ win, wc, log, password }) {
    const TWOFA_URL = 'https://accountscenter.facebook.com/password_and_security/two_factor'
    const res = { ok: false, key: '' }
    if (win.isDestroyed()) return res
    const { sleep, mouseClick, clickText, fillInput, fillVisibleInput, loadPage, hasPasswordField, dumpPageState } =
      this._pageHelpers(win, wc, log, '2FA flow')

    // Tìm khóa 2FA trong body: 4 cụm 4 ký tự base32 (A-Z, 2-7), ví dụ "PMYX 2PA3 UKBA PHM6"
    const findKey = () => wc.executeJavaScript(
      '(function(){var t=(document.body?document.body.innerText:"");var m=t.match(/\\b[A-Z2-7]{4}\\s*[A-Z2-7]{4}\\s*[A-Z2-7]{4}\\s*[A-Z2-7]{4}\\b/);return m?m[0]:null;})()'
    ).catch(() => null)
    // Trạng thái màn hình: còn ô nhập mã không / có báo lỗi mã sai không
    const screenState = () => wc.executeJavaScript('(function(){' +
      'var t=(document.body?document.body.innerText:"");' +
      'var d=document.querySelector(\'div[role="dialog"]\');var dt=d?(d.innerText||""):t;' +
      'var hasInput=false;var ins=document.querySelectorAll("input");' +
      'for(var i=0;i<ins.length;i++){var r=ins[i].getBoundingClientRect();if(r.width>2&&r.height>2&&(ins[i].type||"").toLowerCase()!=="password"){hasInput=true;break;}}' +
      'var err=/incorrect|khong dung|không đúng|wrong code|thu lai|thử lại|invalid code|mã không/i.test(dt);' +
      'return {hasInput:hasInput,err:err};})()').catch(() => null)

    try {
      log('🔐 2FA flow: mở trang Two-factor authentication...')
      if (!await loadPage(TWOFA_URL)) { log('⚠ 2FA flow: không load được trang — bỏ qua'); return res }

      // FB có thể khóa cổng security bằng màn hình mật khẩu ngay trước khi thấy Get started
      for (let i = 0; i < 2; i++) {
        if (this.isAborted || win.isDestroyed()) return res
        if (!await hasPasswordField()) break
        log('🔐 2FA flow: FB hỏi mật khẩu trước — điền...')
        if (!await fillInput({ sel: 'input[type="password"]', val: password }) ||
            !await clickText(['Continue', 'Tiếp tục', 'Tiep tuc'], true, 15000)) { await dumpPageState('điền mật khẩu mở đầu thất bại'); return res }
        await sleep(3000)
      }

      // 1. Nút "Get started"
      if (!await clickText(['Get started', 'Bắt đầu'], true, 25000)) {
        await dumpPageState('không thấy nút Get started'); return res
      }
      await sleep(2500)

      // 2. Màn xác nhận mật khẩu (input type="password" — id kiểu "_r_s_")
      let pwDone = false
      for (let i = 0; i < 3 && !pwDone && !this.isAborted && !win.isDestroyed(); i++) {
        if (!await hasPasswordField()) { pwDone = true; break }
        if (!await fillInput({ sel: 'input[type="password"]', val: password })) { await dumpPageState('điền mật khẩu thất bại'); return res }
        await sleep(600)
        if (!await clickText(['Continue', 'Tiếp tục', 'Tiep tuc'], true, 15000)) { await dumpPageState('không thấy nút Continue (mật khẩu)'); return res }
        await sleep(3000)
      }
      if (!pwDone) { await dumpPageState('màn mật khẩu không chịu đi tiếp'); return res }

      // 3. Màn chọn phương thức — chọn Authentication app rồi bấm Next/Continue tới khi thấy khóa.
      //    Nút các màn có thể là: "Continue" (Help protect your account), "Enter code" (màn Instructions
      //    for setup sau copy key), "Next" (màn Get your code). Kèm bản Việt
      const navTexts = ['Next', 'Continue', 'Enter code', 'Tiếp theo', 'Tiếp tục', 'Nhập mã', 'Tiep theo', 'Tiep tuc', 'Nhap ma']
      await clickText(['Authentication app', 'Ứng dụng xác thực'], true, 6000).catch(() => null)
      await sleep(500)
      let keyRaw = await findKey()
      if (!keyRaw) {
        if (!await clickText(navTexts, true, 20000)) { await dumpPageState('không thấy nút Next/Continue (chọn phương thức)'); return res }
        await sleep(3000)
        keyRaw = await findKey()
        // 4. Có thể có màn trung gian (QR/tải app) — cứ bấm Next/Continue tới khi khóa hiện ra
        for (let i = 0; i < 4 && !keyRaw && !this.isAborted && !win.isDestroyed(); i++) {
          if (!await clickText(navTexts, true, 15000)) break
          await sleep(3000)
          keyRaw = await findKey()
        }
        for (let i = 0; i < 10 && !keyRaw && !this.isAborted && !win.isDestroyed(); i++) {
          keyRaw = await findKey()
          if (!keyRaw) await sleep(1500)
        }
      }
      if (!keyRaw) { await dumpPageState('không thấy khóa 2FA trên trang'); return res }
      res.key = keyRaw.replace(/[^A-Za-z2-7]/g, '').toUpperCase()
      log(`🔑 2FA flow: bắt được khóa ${keyRaw} -> lưu key: ${res.key}`)

      // Log sempre màn hình đang đứng sau khi bắt key (để soi UI khi cần debug)
      const logScreen = async (label) => {
        const dbg = await wc.executeJavaScript('(function(){' +
          'var els=Array.from(document.querySelectorAll("div[role=\\"button\\"],button,a,[role=\\"menuitem\\"],input,textarea")).slice(0,80);' +
          'var out=[];for(var i=0;i<els.length;i++){var e=els[i];var r=e.getBoundingClientRect();if(r.width<2||r.height<2)continue;' +
          'var t=((e.innerText||e.textContent||e.value||"")).replace(/\\s+/g," ").trim().substring(0,40);if(t)out.push(t);}' +
          'return JSON.stringify({url:location.href.substring(0,120),len:(document.body?document.body.innerText.length:0),els:out.slice(0,30)});})()').catch(() => null)
        if (dbg) log(`🔍 2FA flow [${label}]: ${dbg}`)
      }

      // Bấm "Copy key" cho giống thao tác tay
      await clickText(['Copy key', 'Sao chép khóa', 'Copy'], true, 8000).catch(() => null)
      await sleep(1200)
      await logScreen('sau copy key')

      // 5. Đi tới màn nhập mã: ô nhập có thể đã sẵn trên màn, hoặc phải bấm Next/Continue.
      //    Poll 30s: thấy ô nhập -> dừng; thấy nút -> bấm rồi chờ; không thấy gì thì log màn hình để soi
      let otpScreenReady = false
      for (let t = 0; t < 15 && !otpScreenReady && !this.isAborted && !win.isDestroyed(); t++) {
        const st = await screenState()
        if (st && st.hasInput) { otpScreenReady = true; break }
        const clicked = await clickText(navTexts, true, 3000)
        if (clicked) { log(`👉 2FA flow: bấm "${clicked.text}" để sang màn nhập mã`); await sleep(2500); continue }
        if (t % 4 === 3) await logScreen('chưa thấy ô nhập OTP lẫn nút Next/Continue')
        await sleep(1200)
      }
      if (!otpScreenReady) { await dumpPageState('không đi tới màn nhập OTP sau copy key'); return res }

      // 5. Lấy OTP từ 2fa.page theo key -> điền -> Next. Mã sai thì lấy mã mới thử lại (tối đa 3 lần)
      let otpAccepted = false
      for (let attempt = 1; attempt <= 3 && !otpAccepted; attempt++) {
        if (this.isAborted || win.isDestroyed()) return res
        if (attempt > 1) log(`🔄 2FA flow: mã chưa được chấp nhận — lấy mã mới từ 2fa.page (${attempt}/3)`)
        log('🌐 2FA flow: mở 2fa.page lấy mã OTP từ key...')
        const otp = await this.getOtpFrom2faPage(res.key, win, log)
        if (!otp) { log('⚠ 2FA flow: không lấy được OTP từ 2fa.page'); return res }
        log(`🔢 2FA flow: lấy được OTP ${otp} — điền vào Facebook`)
        if (!await fillVisibleInput(otp) &&
            !await fillInput({ sel: 'input[type="tel"]', val: otp })) {
          // Trang có thể ĐÃ hoàn tất (mã lần trước đã ăn) — nhận diện Done/is-on = thành công
          const done = await wc.executeJavaScript(`(function(){
            var t = (document.body ? document.body.innerText : '');
            var hasDone = Array.from(document.querySelectorAll('[role="button"], button')).some(function(b){
              var tt = ((b.innerText||'')+'').trim().toLowerCase();
              return tt === 'done' || tt === 'xong';
            });
            return { done: hasDone, on: /two-factor authentication is on|đã bật xác thực hai yếu tố/i.test(t) };
          })()`).catch(() => null)
          if (done && (done.done || done.on)) {
            res.ok = true
            log(`✅ 2FA flow: trang đã sang màn hoàn tất — 2FA đã bật (key: ${res.key})`)
            await clickText(['Done', 'Xong'], true, 6000).catch(() => null)
            return res
          }
          await dumpPageState('không điền được mã OTP'); return res
        }
        await sleep(800)
        if (!await clickText(navTexts, true, 15000)) { await dumpPageState('không thấy nút Next/Continue (OTP)'); return res }
        await sleep(3500)
        const st = await screenState()
        if (!st) continue
        if (st.err && !st.hasInput) continue   // FB báo mã sai -> lấy mã cửa sổ mới
        if (st.hasInput) continue              // vẫn màn nhập mã -> thử lại
        otpAccepted = true
      }
      if (!otpAccepted) { await dumpPageState('OTP 2FA không được chấp nhận'); return res }

      // 6. Màn hoàn tất — bấm Done nếu có
      await clickText(['Done', 'Xong', 'Finish', 'Hoàn tất'], true, 8000).catch(() => null)
      res.ok = true
      log(`✅ 2FA flow: đã bật 2FA thành công — key: ${res.key}`)
      return res
    } catch (e) {
      log(`⚠ 2FA flow lỗi: ${e.message}`)
      return res
    }
  }
}

module.exports = FBRegisterEngine
