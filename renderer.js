// ── STATE ──
let loadedEntries = []   // { cookie, file }[]
let allResults   = []    // result objects (after check)
let activeFilter = 'all'
let isChecking   = false
let unsubProgress, unsubComplete

const $ = id => document.getElementById(id)

// ── STATS COUNTERS ──
const stats = { total: 0, live: 0, die: 0, checkpoint: 0, error: 0 }
function updateStats(key, val) {
  if (key === 'reset') {
    Object.keys(stats).forEach(k => { stats[k] = 0; $(`stat-${k === 'checkpoint' ? 'ckpt' : k === 'error' ? 'err' : k}`).textContent = '0' })
    return
  }
  stats[key] = val
  const elId = key === 'checkpoint' ? 'stat-ckpt' : key === 'error' ? 'stat-err' : `stat-${key}`
  const el = $(elId)
  if (el) {
    el.textContent = val
    el.parentElement.classList.add('bump')
    setTimeout(() => el.parentElement.classList.remove('bump'), 300)
  }
}

// ── TOAST ──
function showToast(msg, duration = 2500) {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), duration)
}

// ── WINDOW CONTROLS ──
$('btn-min').onclick   = () => window.api.minimize()
$('btn-max').onclick   = () => window.api.maximize()
$('btn-close').onclick = () => window.api.close()

// ── CONCURRENCY SLIDER ──
const sliderEl = $('concurrency')
const sliderVal = $('concurrency-val')
sliderEl.oninput = () => { sliderVal.textContent = sliderEl.value }

// ── SETTINGS: TEMPMAIL API KEY ──
if ($('setting-apikey')) {
  window.api.getApiKey().then(k => { $('setting-apikey').value = k || '' }).catch(() => {})
  $('btn-save-apikey').onclick = async () => {
    const key = $('setting-apikey').value.trim()
    if (!key) { showToast('⚠️ Chưa nhập API key!'); return }
    const btn = $('btn-save-apikey')
    const oldTxt = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '⏳ Test...'
    const res = await window.api.saveApiKey(key)
    btn.disabled = false
    btn.innerHTML = oldTxt
    if (res && res.success) showToast('✅ Key OK (200) — tạo được email: ' + res.email, 4500)
    else showToast('❌ Key không hợp lệ / server lỗi: ' + (res && res.error || '?'), 5000)
  }
}

// ── SETTINGS: SMS (SMSPVA) API KEY ──
if ($('setting-smskey')) {
  window.api.getSmsKey().then(k => { $('setting-smskey').value = k || '' }).catch(() => {})
  $('btn-save-smskey').onclick = async () => {
    const key = $('setting-smskey').value.trim()
    if (!key) { showToast('⚠️ Chưa nhập SMS API key!'); return }
    const btn = $('btn-save-smskey')
    const oldTxt = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '⏳ Test...'
    const res = await window.api.saveSmsKey(key)
    btn.disabled = false
    btn.innerHTML = oldTxt
    if (res && res.success) showToast('✅ SMS Key OK — số dư SMSPVA: $' + res.balance, 4500)
    else showToast('❌ SMS Key không hợp lệ / server lỗi: ' + (res && res.error || '?'), 5000)
  }
}

// ── SETTINGS: TEMPMAIL.ID.VN TOKEN ──
if ($('setting-tempmailidkey')) {
  window.api.getTempmailIdKey().then(k => { $('setting-tempmailidkey').value = k || '' }).catch(() => {})
  $('btn-save-tempmailidkey').onclick = async () => {
    const key = $('setting-tempmailidkey').value.trim()
    if (!key) { showToast('⚠️ Chưa nhập token tempmail.id.vn!'); return }
    const btn = $('btn-save-tempmailidkey')
    const oldTxt = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '⏳ Test...'
    const res = await window.api.saveTempmailIdKey(key)
    btn.disabled = false
    btn.innerHTML = oldTxt
    if (res && res.success) showToast('✅ Token OK — tạo thử email: ' + res.email, 4500)
    else showToast('❌ Token không hợp lệ / server lỗi: ' + (res && res.error || '?'), 5000)
  }
}

// ── SETTINGS: ĐƯỜNG DẪN LDPLAYER ──
if ($('setting-ldpath')) {
  window.api.getLdPath().then(r => {
    if (r && r.path) $('setting-ldpath').value = r.path
    else $('setting-ldpath').placeholder = 'Không tự tìm thấy - dán đường dẫn thư mục LDPlayer'
  }).catch(() => {})
  $('btn-save-ldpath').onclick = async () => {
    const dir = $('setting-ldpath').value.trim()
    if (!dir) { showToast('⚠️ Chưa nhập đường dẫn LDPlayer!'); return }
    const res = await window.api.saveLdPath(dir)
    if (res && res.success) showToast('✅ Đã lưu đường dẫn LDPlayer', 3500)
    else showToast('❌ ' + (res && res.error || 'Lỗi lưu đường dẫn'), 5000)
  }
}

// ── SETTINGS: MAIL.TD API TOKEN (td_...) ──
if ($('setting-mailtdkey')) {
  window.api.getMailTdKey().then(k => { $('setting-mailtdkey').value = k || '' }).catch(() => {})
  $('btn-save-mailtdkey').onclick = async () => {
    const key = $('setting-mailtdkey').value.trim()
    if (!key) { showToast('⚠️ Chưa nhập token Mail.td!'); return }
    const btn = $('btn-save-mailtdkey')
    const oldTxt = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '⏳ Test...'
    const res = await window.api.saveMailTdKey(key)
    btn.disabled = false
    btn.innerHTML = oldTxt
    if (res && res.success) showToast('✅ Token OK — tạo thử email: success', 4500)
    else showToast('❌ Token không hợp lệ / server lỗi: ' + (res && res.error || '?'), 5000)
  }
}

// ── SETTINGS: TEMPMail G API KEY ──
if ($('setting-tempmailgkey')) {
  window.api.getTempmailGKey().then(k => { $('setting-tempmailgkey').value = k || '' }).catch(() => {})
  $('btn-save-tempmailgkey').onclick = async () => {
    const key = $('setting-tempmailgkey').value.trim()
    if (!key) { showToast('⚠️ Chưa nhập key TempMail G!'); return }
    const btn = $('btn-save-tempmailgkey')
    const oldTxt = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '⏳ Test...'
    const res = await window.api.saveTempmailGKey(key)
    btn.disabled = false
    btn.innerHTML = oldTxt
    if (res && res.success) showToast('✅ Key OK — tạo thử email: success', 4500)
    else showToast('❌ Key không hợp lệ / server lỗi: ' + (res && res.error || '?'), 5000)
  }
}

// ── LOAD ENTRIES ──
async function restoreImportedCookies() {
  try {
    const saved = await window.api.getImportedCookies()
    if (Array.isArray(saved) && saved.length && !loadedEntries.length) {
      setEntries({ entries: saved })
      appendRegV2Log && appendRegV2Log(`📂 Đã khôi phục ${saved.length} cookie đã nạp từ lần trước`)
    }
  } catch {}
}

function setEntries(data) {
  if (!data || data.canceled) return
  if (data.error) {
    showToast('❌ Lỗi: ' + data.error, 3500)
    return
  }
  if (!data.entries || data.entries.length === 0) {
    showToast('⚠️ Không tìm thấy cookie hợp lệ (Cần có c_user hoặc xs trong cookie)', 3500)
    return
  }

  // Lọc trùng theo UID (c_user) trước khi nạp — tránh check 2 lần cùng acc
  const seen = new Set()
  const uniq = []
  let dupCount = 0
  for (const e of data.entries) {
    if (!e || !e.cookie) continue
    const m = String(e.cookie).match(/c_user=(\d+)/)
    const key = m ? m[1] : String(e.cookie).replace(/\s+/g, '')
    if (seen.has(key)) { dupCount++; continue }
    seen.add(key)
    uniq.push(e)
  }
  loadedEntries = uniq
  try { window.api.saveImportedCookies(uniq).catch(() => {}) } catch {}
  if (dupCount > 0) showToast(`♻️ Đã lọc ${dupCount} cookie trùng (cùng UID)`)
  nuoiUpdateImportCount()
  ckptUpdateImportCount()
  profileUpdateImportCount()
  authUpdateImportCount()
  const fileSet = new Set(uniq.map(e => e.file))

  $('queue-count').textContent = uniq.length
  $('queue-files').textContent = fileSet.size
  $('queue-bar').style.display = 'flex'
  $('drop-zone').style.display = 'none'
  updateStats('reset')
  updateStats('total', uniq.length)
  showToast(`✅ Đã nạp thành công ${uniq.length} cookie từ ${fileSet.size} nguồn!`)
}

// ── IMPORT BUTTONS ──
$('btn-folder').onclick = async () => {
  const data = await window.api.openFolder()
  setEntries(data)
}
$('btn-zip').onclick = async () => {
  const data = await window.api.openZip()
  setEntries(data)
}
$('btn-files').onclick = async () => {
  const data = await window.api.openFiles()
  setEntries(data)
}

// ── DIRECT PASTE MODAL ──
const modalPaste = $('modal-paste')
const pasteInput = $('paste-input')
if ($('btn-paste')) {
  $('btn-paste').onclick = () => {
    pasteInput.value = ''
    modalPaste.style.display = 'flex'
    pasteInput.focus()
  }
}
if ($('btn-close-paste')) {
  $('btn-close-paste').onclick = () => { modalPaste.style.display = 'none' }
}
if ($('btn-cancel-paste')) {
  $('btn-cancel-paste').onclick = () => { modalPaste.style.display = 'none' }
}
if ($('btn-confirm-paste')) {
  $('btn-confirm-paste').onclick = async () => {
    const text = pasteInput.value.trim()
    if (!text) {
      showToast('⚠️ Vui lòng dán hoặc nhập cookie!')
      return
    }
    const data = await window.api.parseDirectText(text)
    modalPaste.style.display = 'none'
    setEntries(data)
  }
}

// ── DROP ZONE ──
const dropZone = $('drop-zone')
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
dropZone.addEventListener('drop', async e => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  const items = e.dataTransfer.files
  if (!items || !items.length) return

  const f = items[0]
  let fpath = ''
  if (window.api.getFilePath) {
    try { fpath = window.api.getFilePath(f) } catch {}
  }
  if (!fpath && f.path) {
    fpath = f.path
  }

  if (fpath) {
    const data = await window.api._dropPath(fpath)
    setEntries(data)
    return
  }

  // Fallback: Read directly via browser FileReader
  try {
    const reader = new FileReader()
    reader.onload = async () => {
      const text = reader.result
      const data = await window.api.parseDirectText(text)
      setEntries(data)
    }
    reader.readAsText(f)
  } catch {
    showToast('⚠️ Vui lòng dùng các nút bên trái để chọn file!')
  }
})
dropZone.onclick = () => $('btn-folder').click()

// ── CHECK COOKIES ──
$('btn-check').onclick = startChecking
$('btn-stop').onclick  = stopChecking
$('btn-clear').onclick = clearAll

async function startChecking() {
  if (!loadedEntries.length) { showToast('⚠️ Chưa có cookie nào để check'); return }
  if (isChecking) return

  isChecking = true
  allResults = []
  $('btn-check').style.display = 'none'
  $('btn-stop').style.display  = 'flex'
  $('btn-check').disabled = true
  $('table-wrap').style.display = 'block'
  $('filter-bar').style.display = 'flex'
  $('progress-wrap').style.display = 'flex'
  $('checking-placeholder').style.display = 'none'
  $('results-body').innerHTML = ''

  // Pre-fill pending rows
  loadedEntries.forEach((e, i) => {
    allResults.push({ ...e, status: 'PENDING', uid: '', name: '', index: i })
    appendRow({ ...e, status: 'PENDING', uid: '', name: '' }, i)
  })

  updateStats('reset')
  updateStats('total', loadedEntries.length)

  // Subscribe to events
  unsubProgress = window.api.onProgress(onProgress)
  unsubComplete = window.api.onComplete(onComplete)

  const concurrency = parseInt(sliderEl.value) || 3
  const showBrowser = $('chk-show-browser') ? $('chk-show-browser').checked : true
  window.api.checkCookies(loadedEntries, concurrency, showBrowser)
}

function stopChecking() {
  window.api.abortCheck()
  isChecking = false
  $('btn-check').style.display = 'flex'
  $('btn-stop').style.display  = 'none'
  $('btn-check').disabled = false
  showToast('⏹ Đã dừng check')
}

function clearAll() {
  loadedEntries = []
  nuoiUpdateImportCount()
  ckptUpdateImportCount()
  allResults = []
  $('results-body').innerHTML = ''
  $('table-wrap').style.display     = 'none'
  $('filter-bar').style.display     = 'none'
  $('progress-wrap').style.display  = 'none'
  $('queue-bar').style.display      = 'none'
  $('drop-zone').style.display      = 'block'
  $('checking-placeholder').style.display = 'none'
  $('progress-fill').style.width    = '0%'
  $('progress-glow').style.width    = '0%'
  updateStats('reset')
  $('speed-val').textContent = '0'
  $('eta-val').textContent   = '--'
}

// ── PROGRESS HANDLER ──
function onProgress({ index, result, completed, total, speed, eta }) {
  allResults[index] = result

  // Update stats
  const liveCount = allResults.filter(r => r?.status === 'LIVE').length
  const dieCount  = allResults.filter(r => r?.status === 'DIE').length
  const ckptCount = allResults.filter(r => r?.status === 'CHECKPOINT').length
  const errCount  = allResults.filter(r => ['ERROR','INVALID'].includes(r?.status)).length
  updateStats('live', liveCount)
  updateStats('die', dieCount)
  updateStats('checkpoint', ckptCount)
  updateStats('error', errCount)

  // Update row
  updateRow(index, result)

  // Progress bar
  const pct = Math.round((completed / total) * 100)
  $('progress-fill').style.width = `${pct}%`
  $('progress-glow').style.width = `${pct}%`
  $('progress-pct').textContent  = `${pct}%`
  $('progress-label').textContent = `Đang check ${completed}/${total}...`

  // Speed & ETA
  $('speed-val').textContent = speed || '0'
  $('eta-val').textContent   = eta ? formatETA(parseInt(eta)) : '--'
}

function onComplete(finalStats) {
  isChecking = false
  if (unsubProgress) { unsubProgress(); unsubProgress = null }
  if (unsubComplete) { unsubComplete(); unsubComplete = null }

  $('btn-check').style.display = 'flex'
  $('btn-stop').style.display  = 'none'
  $('btn-check').disabled = false

  $('progress-label').textContent = '✅ Hoàn thành!'
  $('progress-fill').style.width  = '100%'
  $('progress-glow').style.width  = '100%'
  $('progress-pct').textContent   = '100%'
  $('speed-val').textContent = '0'
  $('eta-val').textContent   = '0s'

  showToast(`✅ Xong! Live: ${finalStats.live} | Die: ${finalStats.die} | Checkpoint: ${finalStats.checkpoint}`, 4000)
}

function formatETA(secs) {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60), s = secs % 60
  return `${m}m ${s}s`
}

// ── TABLE ROWS ──
const STATUS_ICON = { LIVE: '●', DIE: '●', CHECKPOINT: '⚠', ERROR: '!', INVALID: '?', PENDING: '○' }

function makeCookieShort(c) {
  if (!c) return ''
  const xs = c.match(/xs=([^;]+)/)
  return xs ? `xs=${xs[1].substring(0, 12)}...` : c.substring(0, 30) + '...'
}

function appendRow(entry, i) {
  const tbody = $('results-body')
  const tr = document.createElement('tr')
  tr.id = `row-${i}`
  tr.className = 'result-row'
  tr.setAttribute('data-status', entry.status)
  tr.innerHTML = rowHTML(entry, i)
  tbody.appendChild(tr)
  attachCopyHandler(tr, i)
}

function updateRow(i, result) {
  const tr = $(`row-${i}`)
  if (!tr) return
  tr.setAttribute('data-status', result.status)
  tr.innerHTML = rowHTML(result, i)
  attachCopyHandler(tr, i)
  applyFilter()
}

function rowHTML(r, i) {
  const name = r.name ? escHtml(r.name) : '<span class="name-cell empty">—</span>'
  return `
    <td style="text-align:center"><input type="checkbox" class="chk-cookie" data-idx="${i}" ${r.selected ? 'checked' : ''}/></td>
    <td class="num-cell">${i + 1}</td>
    <td><span class="status-badge ${r.status}" title="${escHtml(r.note || '')}">${STATUS_ICON[r.status] || '●'} ${r.status}</span></td>
    <td class="uid-cell">${escHtml(r.uid || '—')}</td>
    <td class="name-cell">${name}</td>
    <td class="file-cell" title="${escHtml(r.file || '')}">${escHtml(r.file || '—')}</td>
    <td class="cookie-cell" title="${escHtml(r.cookie || '')}">${escHtml(makeCookieShort(r.cookie))}</td>
    <td style="text-align:center"><button class="copy-btn" data-idx="${i}">Copy</button></td>
  `
}

function attachCopyHandler(tr, i) {
  const btn = tr.querySelector('.copy-btn')
  if (btn) {
    btn.onclick = async () => {
      const r = allResults[i]
      if (!r) return
      await navigator.clipboard.writeText(r.cookie || '')
      btn.textContent = '✓ OK'
      btn.classList.add('copied')
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 1500)
    }
  }
  const chk = tr.querySelector('.chk-cookie')
  if (chk) {
    chk.onchange = () => {
      const r = allResults[i]
      if (r) r.selected = chk.checked
    }
  }
}

function escHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── FILTER TABS ──
document.querySelectorAll('.filter-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    activeFilter = btn.dataset.filter
    applyFilter()
  }
})

$('search-input').oninput = applyFilter

// ── CHỌN COOKIE (tick) + MỞ CHROME THEO COOKIE ──
if ($('chk-all')) {
  $('chk-all').onchange = () => {
    const on = $('chk-all').checked
    allResults.forEach(r => { r.selected = on })
    document.querySelectorAll('#results-body .chk-cookie').forEach(chk => { chk.checked = on })
  }
}

if ($('btn-open-chrome')) {
  $('btn-open-chrome').onclick = async () => {
    const picked = allResults.filter(r => r.selected && r.cookie)
    if (!picked.length) { showToast('⚠️ Tích chọn cookie trước đã!'); return }
    let opened = 0
    for (const r of picked) {
      const res = await window.api.openCookieBrowser({ uid: r.uid || '', name: r.name || '', cookie: r.cookie })
      if (res && res.ok) opened++
      else if (res && res.error) showToast('❌ ' + res.error)
    }
    if (opened) showToast(`🌐 Đã mở ${opened} cửa sổ Chrome — tắt bằng nút X trên từng cửa sổ`, 3500)
  }
}

function applyFilter() {
  const search = $('search-input').value.toLowerCase().trim()
  const rows = document.querySelectorAll('#results-body tr')
  rows.forEach((tr, i) => {
    const r = allResults[i]
    if (!r) { tr.style.display = ''; return }
    const matchFilter = activeFilter === 'all' || r.status === activeFilter
    const matchSearch = !search || 
      (r.uid && r.uid.includes(search)) ||
      (r.name && r.name.toLowerCase().includes(search)) ||
      (r.file && r.file.toLowerCase().includes(search)) ||
      (r.cookie && r.cookie.toLowerCase().includes(search))
    tr.style.display = (matchFilter && matchSearch) ? '' : 'none'
  })
}

// ── EXPORT ──
async function doExport(format) {
  if (!allResults.length) { showToast('⚠️ Chưa có kết quả để export'); return }
  const validResults = allResults.filter(Boolean)
  const ok = await window.api.exportResults(validResults, format)
  showToast(ok ? '✅ Đã export thành công!' : '❌ Export thất bại')
}
$('btn-export-live').onclick = async () => {
  if (!allResults.length) { showToast('⚠️ Chưa có kết quả để export'); return }
  const liveResults = allResults.filter(r => r?.status === 'LIVE')
  if (!liveResults.length) { showToast('⚠️ Không có cookie LIVE nào để xuất'); return }

  const res = await window.api.exportLiveFolder(allResults, 'LIVE')
  if (!res || res.canceled) return
  if (res.error) {
    showToast('❌ Lỗi: ' + res.error)
  } else if (res.success) {
    showToast(`✅ Đã xuất ${res.count} cookie Live dạng Netscape vào thư mục!`, 3500)
  }
}
// 25-10: xuất folder Netscape cho cookie CHECKPOINT (song song nút Live)
$('btn-export-ckpt').onclick = async () => {
  if (!allResults.length) { showToast('⚠️ Chưa có kết quả để export'); return }
  const ckptResults = allResults.filter(r => r?.status === 'CHECKPOINT')
  if (!ckptResults.length) { showToast('⚠️ Không có cookie CHECKPOINT nào để xuất'); return }

  const res = await window.api.exportLiveFolder(allResults, 'CHECKPOINT')
  if (!res || res.canceled) return
  if (res.error) {
    showToast('❌ Lỗi: ' + res.error)
  } else if (res.success) {
    showToast(`✅ Đã xuất ${res.count} cookie Checkpoint dạng Netscape vào thư mục!`, 3500)
  }
}
$('btn-export-uid').onclick  = () => doExport('uid_live')
$('btn-export-all').onclick  = () => doExport('all_txt')
$('btn-export-json').onclick = () => doExport('json')

// ========================================================
// ── TAB SWITCHING (CHECKER / AUTO REG / ACCOUNT BM) ──
// ========================================================
const tabChecker = $('tab-btn-checker')
const tabAutoReg = $('tab-btn-autoreg')
const sideChecker = $('side-tab-checker')
const sideAutoReg = $('side-tab-autoreg')
const viewChecker = $('view-checker')
const viewAutoReg = $('view-autoreg')
let domainsLoaded = false

function switchTab(target) {
  // 'ckpt' phải nằm trong tabs — thiếu nó thì bấm menu GIẢI CHECKPOINT ẩn hết view khác
  // mà view-ckpt không được hiện -> màn hình trống (bug 25-10)
  const tabs  = ['checker', 'autoreg', 'regv2', 'accountbm', 'tiktok', 'nuoi', 'ckpt', 'profile', 'auth', 'page', 'tempmail']
  tabs.forEach(t => {
    const tabEl  = $(`tab-btn-${t}`)
    const sideEl = $(`side-tab-${t}`)
    const views  = { checker: 'view-checker', autoreg: 'view-autoreg', regv2: 'view-regv2', accountbm: 'view-accountbm', tiktok: 'view-tiktok', nuoi: 'view-nuoi', ckpt: 'view-ckpt', profile: 'view-profile', auth: 'view-auth', page: 'view-page', tempmail: 'view-tempmail' }
    const viewEl = $(views[t])
    if (tabEl)  tabEl.classList.toggle('active',  t === target)
    if (sideEl) sideEl.classList.toggle('active', t === target)
    if (viewEl) viewEl.style.display = t === target ? 'block' : 'none'
  })
  if (target === 'autoreg' && !domainsLoaded) loadRegDomains()
}

if (tabChecker)  tabChecker.onclick  = () => switchTab('checker')
if (tabAutoReg)  tabAutoReg.onclick  = () => switchTab('autoreg')
if (sideChecker) sideChecker.onclick = () => switchTab('checker')
if (sideAutoReg) sideAutoReg.onclick = () => switchTab('autoreg')
if ($('side-tab-regv2')) $('side-tab-regv2').onclick = () => switchTab('regv2')

const regDomainsCaches = {}

function currentMailProvider() {
  const v = regModeSelect ? regModeSelect.value : 'mailown'
  if (v === 'tempmailid') return 'tempmailid'
  if (v === 'mailtm') return 'mailtm'
  if (v === 'mailtd') return 'mailtd'
  if (v === 'tempmailv2') return 'tempmailv2'
  if (v === 'mailown') return 'mailown'
  if (v === 'customdomain') return 'customdomain'
  return 'tempmailapi'
}

function renderDomainOptions(prov = 'tempmailapi') {
  const select = $('reg-domain-select')
  if (!select) return
  if (prov === 'tempmailid') {
    // API tempmail.id.vn luôn tự random domain khi tạo mail -> chỉ hiển thị, không cho chọn
    select.disabled = true
    select.innerHTML = '<option value="">-- API tự random domain (không chọn được) --</option>'
    ;(regDomainsCaches.tempmailid || []).forEach(d => {
      const opt = document.createElement('option')
      opt.value = d
      opt.textContent = d
      select.appendChild(opt)
    })
    return
  }
  if (prov === 'mailown') {
    // Mail Own: catch-all — tool tự random giữa các domain của hệ thống, không cần chọn
    select.disabled = true
    select.innerHTML = '<option value="">-- Server tự random (khangvitoro.store / genblackmmoonline.online) --</option>'
    ;(regDomainsCaches.mailown || []).forEach(d => {
      const opt = document.createElement('option')
      opt.value = d
      opt.textContent = d
      select.appendChild(opt)
    })
    return
  }
  if (prov === 'mailtm') {
    // mail.tm: domain cố định từ API, không cho chọn thủ công
    select.disabled = true
    select.innerHTML = '<option value="">-- mail.tm tự chọn domain (maxxspace.com...) --</option>'
    ;(regDomainsCaches.mailtm || []).forEach(d => {
      const opt = document.createElement('option')
      opt.value = d
      opt.textContent = d
      select.appendChild(opt)
    })
    return
  }
  select.disabled = false
  select.innerHTML = '<option value="">-- Tự động chọn domain tốt --</option>'
  ;(regDomainsCaches.tempmailapi || []).forEach(d => {
    const opt = document.createElement('option')
    opt.value = d
    opt.textContent = d
    select.appendChild(opt)
  })
}

async function loadRegDomains(prov = 'tempmailapi') {
  if (regDomainsCaches[prov]) { renderDomainOptions(prov); return }
  try {
    const domains = await window.api.getRegDomains(prov)
    regDomainsCaches[prov] = Array.isArray(domains) ? domains : []
    const label = prov === 'tempmailid' ? 'tempmail.id.vn'
                : prov === 'mailtm'     ? 'mail.tm'
                : 'tempmailapi.io.vn'
    appendRegLog(`🌐 Đã tải danh sách domain (${label}): ${(regDomainsCaches[prov] || []).join(', ')}`, 'info')
    if (!regModeSelect || currentMailProvider() === prov) renderDomainOptions(prov)
  } catch (err) {
    appendRegLog('⚠️ Không thể tải danh sách domain: ' + err.message, 'ckpt')
  }
}

// ========================================================
// ── AUTO REG FACEBOOK CONTROLLER ──
// ========================================================
const regAccounts = []
const regStats = { total: 0, live: 0, ckpt: 0, err: 0 }

function updateRegStats(key, val) {
  regStats[key] = val
  const el = $(`stat-reg-${key}`)
  if (el) {
    el.textContent = val
    el.parentElement.classList.add('bump')
    setTimeout(() => el.parentElement.classList.remove('bump'), 300)
  }
  if (key === 'live') {
    const badge = $('reg-live-badge')
    if (badge) badge.textContent = `${val} Live`
  }
}

// ── CHUÔNG KHI CÓ NICK LIVE (tổng hợp bằng WebAudio, không cần file âm thanh) ──
let liveBellCtx = null
function playLiveBell() {
  try {
    if (!liveBellCtx) liveBellCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (liveBellCtx.state === 'suspended') liveBellCtx.resume().catch(() => {})
    const t0 = liveBellCtx.currentTime + 0.01
    ;[[987.77, 0], [1318.51, 0.16]].forEach(([freq, dt]) => {
      const osc = liveBellCtx.createOscillator()
      const gain = liveBellCtx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t0 + dt)
      gain.gain.exponentialRampToValueAtTime(0.5, t0 + dt + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 1.1)
      osc.connect(gain)
      gain.connect(liveBellCtx.destination)
      osc.start(t0 + dt)
      osc.stop(t0 + dt + 1.2)
    })
  } catch {}
}

function appendRegLog(msg, type = 'sys') {
  const box = $('reg-console-box')
  if (!box) return
  const line = document.createElement('div')
  line.className = `log-entry ${type}`
  
  // Tự động phân loại màu log
  if (msg.includes('LIVE') || msg.includes('THÀNH CÔNG') || msg.includes('OTP:')) {
    line.className = 'log-entry live'
  } else if (msg.includes('CHECKPOINT') || msg.includes('Lỗi') || msg.includes('thất bại') || msg.includes('Timeout')) {
    line.className = 'log-entry ckpt'
  } else if (msg.includes('Đang') || msg.includes('Thông tin:')) {
    line.className = 'log-entry info'
  }

  line.textContent = msg
  box.appendChild(line)
  box.scrollTop = box.scrollHeight
}

$('btn-reg-clear-log').onclick = () => {
  const box = $('reg-console-box')
  if (box) box.innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa nhật ký.</div>'
}

$('btn-reg-clear').onclick = () => {
  regAccounts.length = 0
  regStats.total = 0; regStats.live = 0; regStats.ckpt = 0; regStats.err = 0;
  $('stat-reg-total').textContent = '0'
  $('stat-reg-live').textContent = '0'
  $('stat-reg-ckpt').textContent = '0'
  $('stat-reg-err').textContent = '0'
  $('reg-live-badge').textContent = '0 Live'
  $('reg-results-body').innerHTML = '<tr class="empty-row"><td colspan="6" style="text-align:center;color:var(--text-muted);padding:30px">Chưa có tài khoản nào được tạo trong phiên này</td></tr>'
  showToast('🗑 Đã xóa bảng kết quả')
}

// ── MODE SELECT: TempMail vs SMS ──
const regModeSelect = $('reg-mode-select')
let smsPricesCache = null      // [{operator, price}] từ /activation/serviceprice

if (regModeSelect) {
  const opLabel = (op) => op.replace(/^Donor/, '').replace(/_VN$/, '')

  async function fillSmsPriceOptions() {
    const select = $('reg-domain-select')
    if (!select) return
    select.disabled = false

    if (!smsPricesCache) {
      select.innerHTML = '<option value="">-- Đang tải bảng giá SMSPVA... --</option>'
      try {
        const res = await window.api.getSmsPrices()
        if (res && res.success && Array.isArray(res.operators) && res.operators.length) {
          smsPricesCache = res.operators
        } else {
          smsPricesCache = []
          showToast('⚠️ Không lấy được bảng giá SMSPVA: ' + (res && res.error || '?'), 4500)
        }
      } catch (err) {
        smsPricesCache = []
        showToast('⚠️ Lỗi lấy bảng giá: ' + err.message, 4500)
      }
    }

    if (!smsPricesCache.length) {
      select.innerHTML = '<option value="">-- Không tải được bảng giá (dùng tự động) --</option>'
      return
    }
    select.innerHTML = '<option value="">-- Giá nào cũng được (ưu tiên rẻ) --</option>'
      + smsPricesCache.map(o =>
        `<option value="${o.operator}">$${o.price.toFixed(2)} — ${opLabel(o.operator)}</option>`
      ).join('')
  }

  const syncModeUI = () => {
    const val = regModeSelect.value
    const isSms = val === 'sms'
    const isLd = val === 'ldplayer'
    const isMailId = val === 'tempmailid'
    const isMailTm = val === 'mailtm'
    const label = $('reg-domain-label')
    const domainField = label ? label.closest('.reg-field') : null
    if (isLd) {
      if (domainField) domainField.style.display = 'none'
    } else if (isSms) {
      if (domainField) domainField.style.display = ''
      if (label) label.textContent = 'Giá số thuê (SMS)'
      fillSmsPriceOptions()
    } else if (isMailId) {
      if (domainField) domainField.style.display = ''
      if (label) label.textContent = 'Domain TempMail.id.vn'
      loadRegDomains('tempmailid')
    } else if (isMailTm) {
      if (domainField) domainField.style.display = ''
      if (label) label.textContent = 'Domain mail.tm'
      loadRegDomains('mailtm')
    } else {
      if (domainField) domainField.style.display = ''
      if (label) label.textContent = 'Domain TempMail'
      loadRegDomains('tempmailapi')
    }
    const testBtn = $('btn-reg-testmail')
    if (testBtn) {
      testBtn.innerHTML = isLd ? '<span>🤖</span> Test LDPlayer'
        : isSms ? '<span>📱</span> Test SMS' : '<span>📧</span> Test Email'
    }
  }
  regModeSelect.onchange = () => {
    syncModeUI()
    // Đổ lại danh sách domain theo provider vừa chọn (mailown/mailtd/v2/customdomain/tempmailapi...)
    loadRegDomains(currentMailProvider())
    const v = regModeSelect.value
    appendRegLog(
      v === 'sms'        ? '📱 Chế độ SMS: chọn giá số thuê rồi bấm Reg (giá rẻ nhất $0.25)'
      : v === 'ldplayer' ? '🤖 Chế độ LDPlayer: reg bằng app Facebook Lite trong giả lập Android. Cần cài LDPlayer + Facebook Lite.'
      : v === 'tempmailid' ? '📧 Chế độ TempMail tempmail.id.vn: API tự random domain'
      : v === 'mailtm'   ? '📧 Chế độ mail.tm: domain sạch (maxxspace.com)'
      : v === 'mailtd'   ? '📧 Chế độ Mail.td: API key riêng (đã lưu trong Cài đặt)'
      : v === 'tempmailv2' ? '📧 Chế độ TempEmail.cc: JWT miễn phí, rate 1 email/30s/IP'
      : v === 'mailown'  ? '📧 Chế độ MAIL OWN ✨: mail server tự xây (catch-all @khangvitoro.store), OTP bóc sẵn, KHÔNG giới hạn!'
      : '📧 Chế độ TempMail tempmailapi.io.vn: chọn domain rồi bấm Reg'
    , 'info')
  }
  syncModeUI()
}

// ── TEST MAIL BUTTON ──
$('btn-reg-testmail').onclick = async () => {
  const mode = $('reg-mode-select') ? $('reg-mode-select').value : 'tempmail'
  if (mode === 'ldplayer') {
    appendRegLog('🤖 Đang kiểm tra LDPlayer trên máy này...', 'info')
    try {
      const res = await window.api.testLdplayer()
      if (res.success) {
        appendRegLog(`✅ Tìm thấy LDPlayer: ${res.path} | ldconsole + adb OK | ${res.instances} giả lập đang được quản lý`, 'live')
        showToast(`✅ LDPlayer OK: ${res.instances} giả lập`, 3500)
      } else {
        appendRegLog(`❌ ${res.error}`, 'ckpt')
        showToast(`❌ ${res.error}`, 4500)
      }
    } catch (err) {
      appendRegLog(`❌ Lỗi kiểm tra LDPlayer: ${err.message}`, 'ckpt')
    }
    return
  }
  const isSms = mode === 'sms'
  if (isSms) {
    appendRegLog('📱 Đang thử kết nối SMSPVA (kiểm tra số dư)...', 'info')
    try {
      const res = await window.api.testSms()
      if (res.success) {
        appendRegLog(`✅ Kết nối SMSPVA thành công! Số dư: $${res.balance}`, 'live')
        showToast(`✅ SMSPVA OK - số dư: $${res.balance}`, 3500)
      } else {
        appendRegLog(`❌ Lỗi SMSPVA: ${res.error}`, 'ckpt')
        showToast(`❌ Lỗi: ${res.error}`, 3500)
      }
    } catch (err) {
      appendRegLog(`❌ Lỗi kết nối: ${err.message}`, 'ckpt')
    }
    return
  }
  const isMailIdTest = mode === 'tempmailid'
  const isMailTmTest = mode === 'mailtm'
  const mailProvider = isMailIdTest ? 'tempmailid' : isMailTmTest ? 'mailtm' : 'tempmailapi'
  const domain = (isMailIdTest || isMailTmTest) ? null : ($('reg-domain-select').value || null)
  const providerTxt = isMailIdTest ? 'tempmail.id.vn' : isMailTmTest ? 'mail.tm ✨' : 'tempmailapi.io.vn'
  appendRegLog(`📧 Đang thử tạo email (${providerTxt})${domain ? ` với domain: ${domain}` : ''}...`, 'info')
  try {
    const res = await window.api.testMail(domain, mailProvider)
    if (res.success) {
      appendRegLog(`✅ Kết nối thành công! Email tạo được: ${res.email} (Token: ${res.sidToken.substring(0, 10)}...)`, 'live')
      showToast(`✅ Tạo email thành công: ${res.email}`, 3500)
    } else {
      appendRegLog(`❌ Lỗi tạo email: ${res.error}`, 'ckpt')
      showToast(`❌ Lỗi: ${res.error}`, 3500)
    }
  } catch (err) {
    appendRegLog(`❌ Lỗi kết nối: ${err.message}`, 'ckpt')
  }
}

// ── NẠP PROXY TỪ FILE ──
$('btn-reg-loadproxy').onclick = async () => {
  const res = await window.api.pickProxyFile()
  if (res && res.content) {
    const lines = res.content.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    $('reg-proxy-input').value = lines.join('\n')
    showToast(`📂 Đã nạp ${lines.length} proxy từ file`)
  } else if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 3000)
  }
}

// ── BẮT ĐẦU REG ──
const startRegRun = async (continuous) => {
  const selVal = $('reg-mode-select') ? $('reg-mode-select').value : 'tempmail'
  const isSms = selVal === 'sms'
  const isLd = selVal === 'ldplayer'
  const isMailId = selVal === 'tempmailid'
  const isMailTm = selVal === 'mailtm'
  const isMailTd = selVal === 'mailtd'
  const isMailV2 = selVal === 'tempmailv2'
  const isMailOwn = selVal === 'mailown'
  const isMailCustom = selVal === 'customdomain'
  // mailtm/mailtd/tempmailid/tempemail.cc/customdomain chay cung luong email, chi doi provider ben trong
  const mode = (isMailId || isMailTm || isMailTd || isMailV2 || isMailCustom || isMailOwn) ? 'tempmail' : selVal
  const emailProvider = isMailId ? 'tempmailid' : isMailTm ? 'mailtm' : isMailTd ? 'mailtd' : isMailV2 ? 'tempmailv2' : isMailCustom ? 'customdomain' : isMailOwn ? 'mailown' : 'tempmailapi'
  const domain = $('reg-domain-select').value || null
  const smsOperator = isSms ? domain : null   // khi SMS, select này giữ operator (giá) đã chọn
  const count = parseInt($('reg-count-input').value, 10) || 1
  const proxy = $('reg-proxy-input').value.trim() || null
  const showBrowser = $('reg-show-browser').checked
  const concurrency = parseInt($('concurrency') ? $('concurrency').value : '1', 10) || 1

  if (isLd) {
    const ldCheck = await window.api.getLdPath()
    if (!ldCheck || !ldCheck.success) {
      showToast('⚠️ Không tìm thấy LDPlayer! Cài LDPlayer hoặc khai báo đường dẫn trong Settings.', 5000)
      return
    }
  }

  $('btn-reg-start').style.display = 'none'
  $('btn-reg-forever').style.display = 'none'
  $('btn-reg-stop').style.display = ''

  const priceTxt = isSms
    ? (smsOperator ? ` | Giá số: ${$('reg-domain-select').selectedOptions[0] ? $('reg-domain-select').selectedOptions[0].textContent : smsOperator}` : ' | Giá số: tự động (ưu tiên rẻ)')
    : ''
  const modeTxt = isLd ? 'LDPlayer (Facebook Lite)'
    : isSms ? 'SMS (SMSPVA)'
    : `TempMail (${ emailProvider === 'tempmailid'   ? 'tempmail.id.vn'
                  : emailProvider === 'mailtm'       ? 'mail.tm'
                  : emailProvider === 'mailtd'       ? 'mail.td'
                  : emailProvider === 'tempmailv2'   ? 'tempemail.cc'
                  : emailProvider === 'mailown'      ? 'mail-own (VPS)'
                  : emailProvider === 'customdomain' ? ('Domain rieńg: @' + (typeof process !== 'undefined' && process.env && process.env.CUSTOM_DOMAIN ? process.env.CUSTOM_DOMAIN : 'yourdomain.com'))
                  : 'tempmailapi.io.vn' })`
  appendRegLog(`🚀 Khởi động luồng Auto Reg: Chế độ = ${modeTxt}${priceTxt} | Số lượng = ${continuous ? '♾️ LIÊN TỤC (đến khi bấm Dừng)' : count} | ${Math.min(concurrency, count)} ${isLd ? 'giả lập LDPlayer' : 'Chrome'} song song | Browser = ${showBrowser ? 'Hiện' : 'Ẩn'}...`, 'info')

  let res = null
  try {
    res = await window.api.startReg({
      count,
      mode,
      domain: (isSms || emailProvider === 'tempmailid' || emailProvider === 'mailtm' || emailProvider === 'mailtd' || emailProvider === 'tempmailv2' || emailProvider === 'customdomain' || emailProvider === 'mailown') ? null : domain,
      emailProvider: isSms || isLd ? 'tempmailapi' : emailProvider,
      smsOperator,
      proxy,
      showBrowser,
      concurrency,
      continuous: !!continuous,
      regVia: $('reg-via-select') ? $('reg-via-select').value : 'web'
    })
  } catch (err) {
    appendRegLog(`❌ Lỗi khởi động reg: ${err && err.message ? err.message : err}`, 'fail')
    showToast('⚠️ Không khởi động được reg - xem log', 3000)
    $('btn-reg-start').style.display = ''
    $('btn-reg-forever').style.display = ''
    $('btn-reg-stop').style.display = 'none'
    return
  }

  if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 3000)
    $('btn-reg-start').style.display = ''
    $('btn-reg-forever').style.display = ''
    $('btn-reg-stop').style.display = 'none'
  }
}

$('btn-reg-start').onclick = () => startRegRun(false)
$('btn-reg-forever').onclick = () => startRegRun(true)

// ── BẬT/TẮT HIỆN CỬA SỔ CHROME REG LÚC ĐANG CHẲY ──
$('reg-show-browser').addEventListener('change', async (e) => {
  if ($('btn-reg-stop').style.display === 'none') return
  const r = await window.api.toggleRegShowBrowser(e.target.checked)
  if (r && r.changed > 0) {
    appendRegLog(`${e.target.checked ? '🌐 Đã hiện' : '🙈 Đã ẩn'} ${r.changed} cửa sổ Chrome reg đang chạy`, 'info')
  }
})

// ── DỪNG REG ──
$('btn-reg-stop').onclick = async () => {
  appendRegLog('⏹ Đang yêu cầu dừng tiến trình đăng ký...', 'ckpt')
  await window.api.stopReg()
  $('btn-reg-start').style.display = ''
  $('btn-reg-forever').style.display = ''
  $('btn-reg-stop').style.display = 'none'
  showToast('⏹ Đã gửi lệnh dừng')
}

// ── XUẤT NICK LIVE ──
$('btn-reg-export').onclick = async () => {
  const res = await window.api.exportLiveReg(regAccounts)
  if (res && res.success) {
    showToast(`✅ Đã xuất ${res.count} nick Live thành công!`, 3500)
  } else if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 3000)
  }
}

// ── XUẤT NICK CHECKPOINT ──
$('btn-reg-export-ckpt').onclick = async () => {
  const res = await window.api.exportCkptReg(regAccounts)
  if (res && res.success) {
    showToast(`✅ Đã xuất ${res.count} nick Checkpoint!`, 3500)
  } else if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 3000)
  }
}

// ── LẮNG NGHE SỰ KIỆN TỪ MAIN PROCESS ──
window.api.onRegLog((msg) => {
  appendRegLog(msg)
})

window.api.onRegAccountResult((acc) => {
  regAccounts.push(acc)
  regStats.total++
  $('stat-reg-total').textContent = regStats.total

  if (acc.status === 'LIVE') {
    playLiveBell()
    regStats.live++
    $('stat-reg-live').textContent = regStats.live
    $('reg-live-badge').textContent = `${regStats.live} Live`
  } else if (acc.status === 'CHECKPOINT') {
    regStats.ckpt++
    $('stat-reg-ckpt').textContent = regStats.ckpt
  } else {
    regStats.err++
    $('stat-reg-err').textContent = regStats.err
  }

  // Cập nhật bảng kết quả
  const tbody = $('reg-results-body')
  const emptyRow = tbody.querySelector('.empty-row')
  if (emptyRow) emptyRow.remove()

  const tr = document.createElement('tr')
  const isLive = acc.status === 'LIVE'
  const isCkpt = acc.status === 'CHECKPOINT'
  const badgeClass = isLive ? 'badge-live' : isCkpt ? 'badge-ckpt' : 'badge-err'
  const statusIcon = isLive ? '✓ LIVE' : isCkpt ? '⚠ CKPT (BỎ)' : '✗ LỖI'

  tr.innerHTML = `
    <td>${regAccounts.length}</td>
    <td><span class="status-badge ${badgeClass}">${statusIcon}</span></td>
    <td class="col-uid-val" title="${acc.uid || 'Chưa có'}">${acc.uid || '<i style="color:var(--text-muted)">Không có</i>'}</td>
    <td>
      <div style="font-weight:600">${acc.name || ''}</div>
      <small style="color:var(--text-muted)">${acc.email || ''}</small>
    </td>
    <td><code>${acc.password || ''}</code></td>
    <td>
      ${isLive && acc.cookieStr ? `
        <button class="btn-copy-cookie" title="Copy Cookie">📋 Copy</button>
      ` : '<span style="color:var(--text-muted)">--</span>'}
    </td>
  `

  if (isLive && acc.cookieStr) {
    const copyBtn = tr.querySelector('.btn-copy-cookie')
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(acc.cookieStr)
        showToast('📋 Đã copy cookie tài khoản!')
      }
    }
  }

  tbody.prepend(tr)
})

window.api.onRegDone(() => {
  $('btn-reg-start').style.display = ''
  $('btn-reg-forever').style.display = ''
  $('btn-reg-stop').style.display = 'none'
  showToast('🏁 Đã hoàn tất tiến trình Auto Reg!', 3500)
})

// ========================================================
// ── ACCOUNT BM TAB ──
// ========================================================
const tabBM  = $('tab-btn-accountbm')
const sideBM = $('side-tab-accountbm')

// Wire up BM tab buttons
if (tabBM)  tabBM.onclick  = () => switchTab('accountbm')
if (sideBM) sideBM.onclick = () => switchTab('accountbm')

// Wire up TikTok tab buttons
if ($('tab-btn-tiktok'))  $('tab-btn-tiktok').onclick  = () => switchTab('tiktok')
if ($('side-tab-tiktok')) $('side-tab-tiktok').onclick = () => switchTab('tiktok')

// Danh sách cookie đã chuyển sang BM
let bmCookieList = []  // [{ uid, name, cookie, file, bmStatus, bmId, selected }]
let bmRunning    = false

// ── NÚT "GỬI LIVE → BM" trong tab Checker ──
const btnSendToBM = $('btn-send-to-bm')
if (btnSendToBM) {
  btnSendToBM.onclick = () => {
    const liveResults = allResults.filter(r => r?.status === 'LIVE')
    if (!liveResults.length) {
      showToast('⚠️ Chưa có cookie LIVE nào! Hãy check cookie trước.')
      return
    }

    // Lọc trùng (theo cookie string)
    let added = 0
    liveResults.forEach(r => {
      const exists = bmCookieList.some(c => c.cookie === r.cookie)
      if (!exists) {
        bmCookieList.push({
          uid:      r.uid || '',
          name:     r.name || '',
          cookie:   r.cookie || '',
          file:     r.file || '',
          bmStatus: 'pending',
          bmId:     null,
          selected: true,
        })
        added++
      }
    })

    if (!added) {
      showToast('⚠️ Tất cả cookie Live đã có trong danh sách BM rồi!')
      return
    }

    renderBMCookieTable()
    switchTab('accountbm')
    showToast(`✅ Đã chuyển ${added} cookie Live sang tab Account BM!`, 3000)
  }
}

// ── RENDER BẢNG COOKIE BM ──
function renderBMCookieTable() {
  const tbody = $('bm-cookie-body')
  if (!tbody) return

  $('bm-cookie-badge').textContent = `${bmCookieList.length} cookie`
  $('stat-bm-total').textContent   = bmCookieList.length

  if (!bmCookieList.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có cookie. Vào tab Kiểm Tra Cookie và dùng nút "Gửi Live → BM"</td></tr>`
    return
  }

  tbody.innerHTML = bmCookieList.map((c, i) => {
    const statusLabel = {
      pending:  '<span class="bm-status-pending">⏳ Chờ</span>',
      running:  '<span class="bm-status-running">⚙ Đang chạy</span>',
      success:  `<span class="bm-status-success">✅ OK${c.bmId ? ` (${c.bmId})` : ''}</span>`,
      failed:   '<span class="bm-status-failed">❌ Thất bại</span>',
      error:    '<span class="bm-status-error">⚠️ Lỗi</span>',
    }[c.bmStatus] || ''
    const checked = c.selected !== false ? 'checked' : ''
    const uidShort = c.uid ? c.uid.substring(0, 16) : '—'
    const nameShort = c.name ? escHtml(c.name.substring(0, 20)) : '<span style="color:var(--text-muted)">—</span>'
    const bmIdCell = c.bmId
      ? `<span class="bmid-cell" data-bmid="${escHtml(String(c.bmId))}" title="Bấm để copy" style="color:var(--accent);cursor:pointer">${escHtml(String(c.bmId))}</span>`
      : '<span style="color:var(--text-muted)">—</span>'
    return `<tr>
      <td style="text-align:center"><input type="checkbox" class="bm-chk-row" data-idx="${i}" ${checked}/></td>
      <td>${i + 1}</td>
      <td class="uid-cell" title="${escHtml(c.uid)}">${uidShort}</td>
      <td class="name-cell">${nameShort}</td>
      <td>${bmIdCell}</td>
      <td>${statusLabel}</td>
    </tr>`
  }).join('')

  // Gắn events checkbox
  tbody.querySelectorAll('.bm-chk-row').forEach(chk => {
    chk.onchange = () => {
      const idx = parseInt(chk.dataset.idx)
      if (bmCookieList[idx]) bmCookieList[idx].selected = chk.checked
    }
  })

  // Bấm vào ID BM -> copy
  tbody.querySelectorAll('.bmid-cell').forEach(el => {
    el.onclick = async () => {
      await navigator.clipboard.writeText(el.dataset.bmid || '')
      showToast('📋 Đã copy BM ID!', 1500)
    }
  })
}

// ── CHỌN TẤT CẢ / BỎ CHỌN ──
const bmChkAll = $('bm-chk-all')
if (bmChkAll) {
  bmChkAll.onchange = () => {
    bmCookieList.forEach(c => c.selected = bmChkAll.checked)
    renderBMCookieTable()
  }
}
if ($('btn-bm-sel-all')) {
  $('btn-bm-sel-all').onclick = () => {
    bmCookieList.forEach(c => c.selected = true)
    if (bmChkAll) bmChkAll.checked = true
    renderBMCookieTable()
  }
}
if ($('btn-bm-sel-none')) {
  $('btn-bm-sel-none').onclick = () => {
    bmCookieList.forEach(c => c.selected = false)
    if (bmChkAll) bmChkAll.checked = false
    renderBMCookieTable()
  }
}

// ── DÁN THÊM COOKIE THỦ CÔNG ──
if ($('btn-bm-paste-cookie')) {
  $('btn-bm-paste-cookie').onclick = async () => {
    const raw = prompt('Dán cookie string vào đây (mỗi dòng 1 cookie):')
    if (!raw || !raw.trim()) return
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    let added = 0
    lines.forEach(line => {
      if (!line.includes('=')) return
      const exists = bmCookieList.some(c => c.cookie === line)
      if (!exists) {
        bmCookieList.push({ uid: '', name: '', cookie: line, file: 'Manual', bmStatus: 'pending', bmId: null, selected: true })
        added++
      }
    })
    renderBMCookieTable()
    showToast(`✅ Đã thêm ${added} cookie vào danh sách BM`)
  }
}

// ── LOG BM ──
function appendBMLog(msg, type = 'sys') {
  const box = $('bm-console-box')
  if (!box) return
  const line = document.createElement('div')
  if (msg.includes('SUCCESS') || msg.includes('thanh cong') || msg.includes('thành công') || msg.includes('OK')) {
    line.className = 'log-entry live'
  } else if (msg.includes('FAILED') || msg.includes('LOI') || msg.includes('lỗi') || msg.includes('CANH BAO')) {
    line.className = 'log-entry ckpt'
  } else if (msg.includes('Dang') || msg.includes('Bat dau') || msg.includes('Thu')) {
    line.className = 'log-entry info'
  } else {
    line.className = `log-entry ${type}`
  }
  const time = new Date().toLocaleTimeString('vi-VN')
  line.textContent = `[${time}] ${msg}`
  box.appendChild(line)
  box.scrollTop = box.scrollHeight
}

if ($('btn-bm-clear-log')) {
  $('btn-bm-clear-log').onclick = () => {
    const box = $('bm-console-box')
    if (box) box.innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa log.</div>'
  }
}

// ── XÓA TẤT CẢ BM ──
if ($('btn-bm-clear')) {
  $('btn-bm-clear').onclick = () => {
    bmCookieList = []
    renderBMCookieTable()
    $('stat-bm-success').textContent = '0'
    $('stat-bm-fail').textContent    = '0'
    $('stat-bm-running').textContent = '0'
    $('bm-console-box').innerHTML    = '<div class="log-entry sys">[Hệ thống] Đã xóa tất cả.</div>'
    showToast('🗑 Đã xóa toàn bộ danh sách BM')
  }
}

// ── MENU CON: Tạo BM | Tạo Account trong BM ──
if ($('bm-subtab-create') && $('bm-subtab-adacc')) {
  const bmShowPanel = (which) => {
    const isCreate = which === 'create'
    $('bm-panel-create').style.display = isCreate ? '' : 'none'
    $('bm-panel-adacc').style.display  = isCreate ? 'none' : ''
    $('bm-subtab-create').classList.toggle('active', isCreate)
    $('bm-subtab-adacc').classList.toggle('active', !isCreate)
    $('btn-bm-start').style.display     = isCreate ? '' : 'none'
    $('btn-bm-acc-start').style.display = isCreate ? 'none' : ''
  }
  $('bm-subtab-create').onclick = () => bmShowPanel('create')
  $('bm-subtab-adacc').onclick  = () => bmShowPanel('adacc')
}

// ── BẮT ĐẦU TẠO BM ──
if ($('btn-bm-start')) {
  $('btn-bm-start').onclick = async () => {
    const bmName      = ($('bm-name-input').value || '').trim()
    const bmEmail     = ($('bm-email-input').value || '').trim()
    const concurrency = parseInt($('bm-concurrency').value) || 2
    const perCookie   = parseInt($('bm-per-cookie').value) || 1
    const proxy       = ($('bm-proxy-input').value || '').trim() || null
    const showBrowser = $('bm-show-browser').checked

    if (!bmName) { showToast('⚠️ Vui lòng nhập tên Business Manager!'); return }
    if (!bmEmail) { showToast('⚠️ Vui lòng nhập email đăng ký BM!'); return }

    const selected = bmCookieList.filter(c => c.selected !== false && c.bmStatus === 'pending')
    if (!selected.length) {
      showToast('⚠️ Không có cookie nào được chọn / tất cả đã chạy rồi!')
      return
    }

    bmRunning = true
    $('btn-bm-start').style.display = 'none'
    $('btn-bm-stop').style.display  = ''

    appendBMLog(`=== Bắt đầu tạo BM: "${bmName}" | ${bmEmail} | ${selected.length} cookie ===`, 'info')

    const res = await window.api.startBM({
      bmName, bmEmail, concurrency, perCookie, proxy, showBrowser,
      cookies: selected.map(c => ({ uid: c.uid, name: c.name, cookie: c.cookie }))
    })

    if (res && res.error) {
      showToast(`⚠️ ${res.error}`, 3500)
      $('btn-bm-start').style.display = ''
      $('btn-bm-stop').style.display  = 'none'
      bmRunning = false
    }
  }
}

// ── DỪNG TẠO BM ──
if ($('btn-bm-stop')) {
  $('btn-bm-stop').onclick = async () => {
    await window.api.stopBM()
    const isCreate = $('bm-panel-create').style.display !== 'none'
    $('btn-bm-start').style.display     = isCreate ? '' : 'none'
    $('btn-bm-acc-start').style.display = isCreate ? 'none' : ''
    $('btn-bm-stop').style.display  = 'none'
    bmRunning = false
    showToast('⏹ Đã gửi lệnh dừng')
  }
}

// ── BẮT ĐẦU TẠO ACCOUNT TRONG BM ──
if ($('btn-bm-acc-start')) {
  $('btn-bm-acc-start').onclick = async () => {
    const businessId  = ($('bm-acc-bmid').value || '').trim()
    const accName     = ($('bm-acc-name').value || '').trim()
    const timezone    = ($('bm-acc-tz').value || '').trim() || '(GMT+07:00) Asia/Jakarta'
    const currency    = ($('bm-acc-currency').value || '').trim() || 'USD — US Dollars'
    const concurrency = parseInt($('bm-concurrency').value) || 2
    const proxy       = ($('bm-proxy-input').value || '').trim() || null
    const showBrowser = $('bm-show-browser').checked

    if (!/^\d{10,20}$/.test(businessId)) { showToast('⚠️ Business ID (BM) không hợp lệ!'); return }
    if (!accName) { showToast('⚠️ Vui lòng nhập tên ad account!'); return }

    const selected = bmCookieList.filter(c => c.selected !== false && c.bmStatus === 'pending')
    if (!selected.length) {
      showToast('⚠️ Không có cookie nào được chọn / tất cả đã chạy rồi!')
      return
    }

    bmRunning = true
    $('btn-bm-acc-start').style.display = 'none'
    $('btn-bm-stop').style.display  = ''

    appendBMLog(`=== Tạo ad account trong BM ${businessId}: "${accName}" | ${selected.length} cookie ===`, 'info')

    const res = await window.api.bmAccStart({
      businessId, accName, timezone, currency, concurrency, proxy, showBrowser,
      cookies: selected.map(c => ({ uid: c.uid, name: c.name, cookie: c.cookie }))
    })

    if (res && res.error) {
      showToast(`⚠️ ${res.error}`, 3500)
      $('btn-bm-acc-start').style.display = ''
      $('btn-bm-stop').style.display  = 'none'
      bmRunning = false
    }
  }
}

// ── XUẤT KẾT QUẢ BM ──
if ($('btn-bm-export')) {
  $('btn-bm-export').onclick = async () => {
    const done = bmCookieList.filter(c => c.bmStatus === 'success')
    if (!done.length) { showToast('⚠️ Chưa có kết quả thành công nào để xuất!'); return }
    const res = await window.api.exportBMResults(done)
    if (res && res.success) showToast(`✅ Đã xuất ${res.count} kết quả BM!`, 3500)
    else if (res && res.error) showToast(`❌ ${res.error}`, 3500)
  }
}

// ── LẮNG NGHE SỰ KIỆN TỪ MAIN (BM) ──
window.api.onBMLog((msg) => {
  appendBMLog(msg)
})

window.api.onBMResult((data) => {
  // data: { cookieIndex, status, bmId, reason }
  const idx = bmCookieList.findIndex(c => c.cookie === data.cookie)
  if (idx > -1) {
    bmCookieList[idx].bmStatus = data.status  // success/failed/error
    bmCookieList[idx].bmId     = data.bmId || null
  }
  renderBMCookieTable()

  // Cập nhật stats
  const success = bmCookieList.filter(c => c.bmStatus === 'success').length
  const failed  = bmCookieList.filter(c => ['failed','error'].includes(c.bmStatus)).length
  const running = bmCookieList.filter(c => c.bmStatus === 'running').length
  $('stat-bm-success').textContent = success
  $('stat-bm-fail').textContent    = failed
  $('stat-bm-running').textContent = running
})

window.api.onBMDone(() => {
  bmRunning = false
  const isCreate = $('bm-panel-create').style.display !== 'none'
  $('btn-bm-start').style.display     = isCreate ? '' : 'none'
  $('btn-bm-acc-start').style.display = isCreate ? 'none' : ''
  $('btn-bm-stop').style.display  = 'none'
  showToast('🏁 Đã hoàn tất!', 3500)
  appendBMLog('=== HOÀN TẤT ===', 'live')

  const success = bmCookieList.filter(c => c.bmStatus === 'success').length
  const total   = bmCookieList.filter(c => c.bmStatus !== 'pending').length
  $('stat-bm-running').textContent = '0'
  $('stat-bm-success').textContent = success
})

// ── ĐÁNH DẤU COOKIE ĐANG CHẠY ──
window.api.onBMRunning((data) => {
  const idx = bmCookieList.findIndex(c => c.cookie === data.cookie)
  if (idx > -1) bmCookieList[idx].bmStatus = 'running'
  renderBMCookieTable()
  const running = bmCookieList.filter(c => c.bmStatus === 'running').length
  $('stat-bm-running').textContent = running
})

// ── TẠO LINK MỜI VÀO BM ──
let inviteResults = []

function inviteLine(r) {
  return `UID:${r.uid || ''} | BM:${r.bmId || ''} | LINK:${r.inviteLink || ''}`
}

if ($('btn-bm-invite')) {
  $('btn-bm-invite').onclick = async () => {
    if (bmRunning) { showToast('⚠️ Đang có tiến trình BM chạy, chờ xong đã!'); return }
    const fallbackBmId = ($('bm-acc-bmid').value || '').trim()
    const selected = bmCookieList
      .filter(c => c.selected !== false && c.cookie)
      .map(c => ({ uid: c.uid, name: c.name, cookie: c.cookie, bmId: c.bmId || (fallbackBmId || null) }))
    if (!selected.length) {
      showToast('⚠️ Chưa có cookie nào được chọn!')
      return
    }

    const showBrowser = $('bm-show-browser').checked
    const concurrency = parseInt($('bm-concurrency').value) || 2

    inviteResults = []
    bmRunning = true
    $('btn-bm-stop').style.display = ''

    appendBMLog(`=== Tạo link mời cho ${selected.length} cookie (BM: ${[...new Set(selected.map(c => c.bmId).filter(Boolean))].join(', ') || 'tự tìm theo cookie'}) ===`, 'info')

    const res = await window.api.startBMInvite({
      cookies: selected, concurrency, proxy: null, showBrowser
    })

    if (res && res.error) {
      showToast(`⚠️ ${res.error}`, 3500)
      $('btn-bm-stop').style.display = 'none'
      bmRunning = false
    }
  }
}

// ── QUÉT BM: dò ID BM của từng cookie được chọn ──
if ($('btn-bm-scan')) {
  $('btn-bm-scan').onclick = async () => {
    if (bmRunning) { showToast('⚠️ Đang có tiến trình BM chạy, chờ xong đã!'); return }
    const selected = bmCookieList.filter(c => c.selected !== false && c.cookie)
    if (!selected.length) { showToast('⚠️ Chưa có cookie nào được chọn!'); return }

    const showBrowser = $('bm-show-browser').checked
    const concurrency = parseInt($('bm-concurrency').value) || 2

    bmRunning = true
    $('btn-bm-stop').style.display = ''

    appendBMLog(`=== Quét BM cho ${selected.length} cookie (quét xong dùng nút "Tạo link mời" sẽ vào đúng BM tìm được) ===`, 'info')

    const res = await window.api.scanBM({
      cookies: selected.map(c => ({ uid: c.uid, name: c.name, cookie: c.cookie })),
      concurrency, showBrowser
    })

    if (res && res.error) {
      showToast(`⚠️ ${res.error}`, 3500)
      $('btn-bm-stop').style.display = 'none'
      bmRunning = false
    }
  }
}

window.api.onBMScanResult((data) => {
  // data: { cookie, uid, bmId, reason }
  const idx = bmCookieList.findIndex(c => c.cookie === data.cookie)
  if (idx > -1 && data.bmId) bmCookieList[idx].bmId = data.bmId
  renderBMCookieTable()
})

window.api.onBMScanDone(() => {
  bmRunning = false
  $('btn-bm-stop').style.display = 'none'
  const found = bmCookieList.filter(c => c.bmId).length
  appendBMLog(`=== QUÉT BM HOÀN TẤT: ${found}/${bmCookieList.length} cookie có BM ID ===`, 'live')
  showToast(`🔍 Quét xong: ${found} cookie có BM!`, 3000)
})

if ($('btn-close-invite')) {
  $('btn-close-invite').onclick = () => { $('modal-invite').style.display = 'none' }
}

if ($('btn-copy-invite')) {
  $('btn-copy-invite').onclick = async () => {
    const text = $('invite-output').value || ''
    if (!text) { showToast('⚠️ Chưa có link để copy'); return }
    await navigator.clipboard.writeText(text)
    showToast('📋 Đã copy tất cả link mời!')
  }
}

if ($('btn-export-invite')) {
  $('btn-export-invite').onclick = async () => {
    if (!inviteResults.length) { showToast('⚠️ Chưa có kết quả để xuất'); return }
    const res = await window.api.exportInviteResults(inviteResults)
    if (res && res.success) showToast(`✅ Đã xuất ${res.count} link mời!`, 3500)
    else if (res && res.error) showToast(`❌ ${res.error}`, 3500)
  }
}

window.api.onInviteResult((data) => {
  // data: { cookie, uid, status: 'success'|'failed'|'error', bmId, email, inviteLink, reason }
  const ok = data.status === 'success' || data.status === 'SUCCESS'
  if (ok) {
    inviteResults.push({ ...data, status: 'success' })
    appendBMLog(`✅ [${data.uid || 'cookie'}] Link mời: ${data.inviteLink}`, 'live')
  } else {
    appendBMLog(`❌ [${data.uid || 'cookie'}] ${data.reason || 'Thất bại'}`, 'info')
  }
  // Cập nhật trạng thái dòng cookie + stats
  const idx = bmCookieList.findIndex(c => c.cookie === data.cookie)
  if (idx > -1) {
    bmCookieList[idx].bmStatus = ok ? 'success' : 'failed'
    bmCookieList[idx].bmId     = data.bmId || bmCookieList[idx].bmId
  }
  renderBMCookieTable()
  const success = bmCookieList.filter(c => c.bmStatus === 'success').length
  const failed  = bmCookieList.filter(c => ['failed','error'].includes(c.bmStatus)).length
  const running = bmCookieList.filter(c => c.bmStatus === 'running').length
  $('stat-bm-success').textContent = success
  $('stat-bm-fail').textContent    = failed
  $('stat-bm-running').textContent = running
})

window.api.onInviteDone((data) => {
  bmRunning = false
  $('btn-bm-stop').style.display = 'none'
  appendBMLog(`=== HOÀN TẤT TẠO LINK MỜI: ${data.finished}/${(data.results || []).length} thành công ===`, 'live')

  const ok = inviteResults.filter(r => r.inviteLink)
  if (!ok.length) { showToast('⚠️ Không tạo được link mời nào, xem log!', 4000); return }

  $('invite-output').value = ok.map(inviteLine).join('\n')
  $('modal-invite').style.display = 'flex'
  showToast(`✅ Đã tạo ${ok.length} link mời!`, 3500)
})

// ==================== REG TIKTOK ====================
let ttCookieList = []  // [{ uid, cookie, ttStatus: pending|running|success|failed, ttCookie, reason, selected }]
let ttRunning    = false

function appendTTLog(msg, type = 'sys') {
  const box = $('tt-console-box')
  if (!box) return
  const line = document.createElement('div')
  if (msg.includes('thành công') || msg.includes('OK') || msg.includes('✅')) {
    line.className = 'log-entry live'
  } else if (msg.includes('❌') || msg.includes('⚠') || msg.includes('lỗi')) {
    line.className = 'log-entry ckpt'
  } else {
    line.className = `log-entry ${type}`
  }
  const time = new Date().toLocaleTimeString('vi-VN')
  line.textContent = `[${time}] ${msg}`
  box.appendChild(line)
  box.scrollTop = box.scrollHeight
}

function ttUidFromCookie(cookieStr) {
  const m = String(cookieStr || '').match(/c_user=(\d+)/)
  return m ? m[1] : ''
}

function renderTTTable() {
  const tbody = $('tt-cookie-body')
  if (!tbody) return
  $('tt-cookie-badge').textContent = `${ttCookieList.length} cookie`
  $('stat-tt-total').textContent   = ttCookieList.length

  if (!ttCookieList.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có cookie. Dán cookie FB vào ô trên rồi bấm "Nạp cookie"</td></tr>`
    return
  }

  tbody.innerHTML = ttCookieList.map((c, i) => {
    const statusLabel = {
      pending: '<span class="bm-status-pending">⏳ Chờ</span>',
      running: '<span class="bm-status-running">⚙ Đang chạy</span>',
      success: '<span class="bm-status-success">✅ OK</span>',
      failed:  `<span class="bm-status-failed" title="${(c.reason || '').replace(/"/g, '&quot;')}">❌ Thất bại</span>`,
    }[c.ttStatus] || ''
    const checked = c.selected !== false ? 'checked' : ''
    const uidShort = c.uid ? c.uid.substring(0, 16) : '—'
    const ttCell = c.ttCookie
      ? `<span class="bmid-cell" data-ttcookie="${encodeURIComponent(c.ttCookie)}" style="color:var(--accent);cursor:pointer" title="Bấm để copy cookie TikTok">${c.ttCookie.substring(0, 24)}...</span>`
      : '<span style="color:var(--text-muted)">—</span>'
    return `<tr>
      <td><input type="checkbox" class="tt-chk" data-idx="${i}" ${checked}/></td>
      <td>${i + 1}</td>
      <td>${uidShort}</td>
      <td>${ttCell}</td>
      <td>${statusLabel}</td>
    </tr>`
  }).join('')

  tbody.querySelectorAll('.tt-chk').forEach(el => {
    el.onchange = () => { const idx = +el.dataset.idx; if (ttCookieList[idx]) ttCookieList[idx].selected = el.checked }
  })
  tbody.querySelectorAll('.bmid-cell').forEach(el => {
    el.onclick = async () => {
      await navigator.clipboard.writeText(decodeURIComponent(el.dataset.ttcookie || ''))
      showToast('📋 Đã copy cookie TikTok!', 1500)
    }
  })
}

function ttUpdateStats() {
  const success = ttCookieList.filter(c => c.ttStatus === 'success').length
  const failed  = ttCookieList.filter(c => c.ttStatus === 'failed').length
  const running = ttCookieList.filter(c => c.ttStatus === 'running').length
  $('stat-tt-success').textContent = success
  $('stat-tt-fail').textContent    = failed
  $('stat-tt-running').textContent = running
}

// ── Nạp cookie từ ô textarea ──
if ($('btn-tt-import')) {
  $('btn-tt-import').onclick = () => {
    const raw = ($('tt-cookie-input').value || '').trim()
    if (!raw) { showToast('⚠️ Chưa dán cookie nào!'); return }

    let entries = []
    if (raw.indexOf('\t') !== -1) {
      // Netscape: cả khối là 1 cookie
      entries.push(raw)
    } else {
      entries = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.indexOf('=') !== -1 && l.length > 30)
    }
    if (!entries.length) { showToast('⚠️ Không đọc được cookie nào!'); return }

    let added = 0
    entries.forEach(cookieStr => {
      const exists = ttCookieList.some(c => c.cookie === cookieStr)
      if (!exists) {
        ttCookieList.push({
          uid: ttUidFromCookie(cookieStr),
          cookie: cookieStr,
          ttStatus: 'pending',
          ttCookie: '',
          reason: '',
          selected: true,
        })
        added++
      }
    })

    if (!added) { showToast('⚠️ Tất cả cookie đã có trong danh sách rồi!'); return }
    $('tt-cookie-input').value = ''
    renderTTTable()
    ttUpdateStats()
    showToast(`✅ Đã nạp ${added} cookie!`, 2500)
  }
}

// ── Chọn tất cả / Bỏ chọn ──
if ($('btn-tt-sel-all'))  $('btn-tt-sel-all').onclick  = () => { ttCookieList.forEach(c => c.selected = true);  renderTTTable() }
if ($('btn-tt-sel-none')) $('btn-tt-sel-none').onclick = () => { ttCookieList.forEach(c => c.selected = false); renderTTTable() }
if ($('tt-chk-all')) {
  $('tt-chk-all').onchange = () => { ttCookieList.forEach(c => c.selected = $('tt-chk-all').checked); renderTTTable() }
}

// ── Xóa tất cả ──
if ($('btn-tt-clear')) {
  $('btn-tt-clear').onclick = () => {
    if (ttRunning) { showToast('⚠️ Đang chạy, bấm Dừng trước!'); return }
    ttCookieList = []
    renderTTTable()
    ttUpdateStats()
    $('tt-console-box').innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa tất cả.</div>'
    showToast('🗑 Đã xóa toàn bộ danh sách')
  }
}

// ── Bắt đầu / Dừng ──
if ($('btn-tt-start')) {
  $('btn-tt-start').onclick = async () => {
    if (ttRunning) return
    const selected = ttCookieList.filter(c => c.selected !== false && c.ttStatus !== 'running' && c.cookie)
    if (!selected.length) { showToast('⚠️ Chưa chọn cookie nào!'); return }

    ttRunning = true
    $('btn-tt-stop').style.display = ''
    appendTTLog(`=== Bắt đầu Reg TikTok cho ${selected.length} cookie ===`, 'info')
    const r = await window.api.startTikTok({
      showBrowser: $('tt-show-browser').checked,
      proxy: ($('tt-proxy-input') ? $('tt-proxy-input').value.trim() : ''),
      cookies: selected
    })
    if (r && r.error) {
      ttRunning = false
      $('btn-tt-stop').style.display = 'none'
      showToast(`⚠️ ${r.error}`)
      appendTTLog(r.error, 'ckpt')
    }
  }
}
if ($('btn-tt-stop')) {
  $('btn-tt-stop').onclick = async () => {
    await window.api.stopTikTok()
    appendTTLog('⏹ Đã yêu cầu dừng...', 'info')
  }
}

// ── Xuất cookie TikTok ──
if ($('btn-tt-export')) {
  $('btn-tt-export').onclick = async () => {
    const okRows = ttCookieList.filter(c => c.ttCookie)
    if (!okRows.length) { showToast('⚠️ Chưa có cookie TikTok nào để xuất!'); return }
    const r = await window.api.exportTikTokResults(okRows)
    if (r && r.success) showToast(`💾 Đã xuất ${r.count} cookie!`, 2500)
    else if (r && r.error) showToast(`⚠️ ${r.error}`)
  }
}

if ($('btn-tt-clear-log')) {
  $('btn-tt-clear-log').onclick = () => {
    const box = $('tt-console-box')
    if (box) box.innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa log.</div>'
  }
}

// ── Listeners từ main ──
window.api.onTikTokLog((msg) => appendTTLog(msg))

window.api.onTikTokRunning((data) => {
  const idx = ttCookieList.findIndex(c => c.cookie === data.cookie)
  if (idx > -1) ttCookieList[idx].ttStatus = 'running'
  renderTTTable()
  ttUpdateStats()
})

window.api.onTikTokResult((data) => {
  const idx = ttCookieList.findIndex(c => c.cookie === data.cookie)
  if (idx > -1) {
    ttCookieList[idx].ttStatus = data.status === 'success' ? 'success' : 'failed'
    ttCookieList[idx].ttCookie = data.ttCookie || ''
    ttCookieList[idx].reason   = data.reason || ''
    if (data.uid && !ttCookieList[idx].uid) ttCookieList[idx].uid = data.uid
  }
  if (data.status === 'success') appendTTLog(`✅ [${data.uid || 'cookie'}] TikTok OK!`, 'live')
  else appendTTLog(`❌ [${data.uid || 'cookie'}] ${data.reason || 'Thất bại'}`, 'ckpt')
  renderTTTable()
  ttUpdateStats()
})

window.api.onTikTokDone((data) => {
  ttRunning = false
  $('btn-tt-stop').style.display = 'none'
  appendTTLog(`=== HOÀN TẤT REG TIKTOK: ${data.finished} cookie đã xử lý ===`, 'live')
  showToast('🏁 Reg TikTok hoàn tất!', 3000)
})

// ========================================================
// ── NUÔI FB TAB ──
// ========================================================
if ($('tab-btn-nuoi'))  $('tab-btn-nuoi').onclick  = () => switchTab('nuoi')
if ($('side-tab-nuoi')) $('side-tab-nuoi').onclick = () => switchTab('nuoi')

let nuoiRows = []
let nuoiStats = { total: 0, live: 0, ckpt: 0, err: 0, run: 0 }
let nuoiRunning = false

function appendNuoiLog(msg, type = 'sys') {
  const box = $('nuoi-console-box')
  if (!box) return
  const line = document.createElement('div')
  if (msg.includes('✅') || msg.includes('thành công') || msg.includes('LIVE') || msg.includes('🏁')) {
    line.className = 'log-entry live'
  } else if (msg.includes('❌') || msg.includes('⚠') || msg.includes('checkpoint') || msg.includes('CHECKPOINT') || msg.includes('lỗi') || msg.includes('Lỗi')) {
    line.className = 'log-entry ckpt'
  } else {
    line.className = `log-entry ${type}`
  }
  const time = new Date().toLocaleTimeString('vi-VN')
  line.textContent = `[${time}] ${msg}`
  box.appendChild(line)
  box.scrollTop = box.scrollHeight
}

function nuoiUpdateStats() {
  $('stat-nuoi-total').textContent = nuoiStats.total
  $('stat-nuoi-live').textContent  = nuoiStats.live
  $('stat-nuoi-ckpt').textContent  = nuoiStats.ckpt
  $('stat-nuoi-err').textContent   = nuoiStats.err
  $('stat-nuoi-run').textContent   = nuoiStats.run
  $('nuoi-badge').textContent      = `${nuoiRows.length} nick`
}

function renderNuoiTable() {
  const tbody = $('nuoi-results-body')
  if (!tbody) return
  if (!nuoiRows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có kết quả. Dán tài khoản/cookie vào ô trên rồi bấm "Bắt Đầu Nuôi".</td></tr>'
    return
  }
  tbody.innerHTML = nuoiRows.map((r, i) => {
    const badge = r.status === 'LIVE' ? '<span class="status-badge badge-live">✓ LIVE</span>'
      : r.status === 'CHECKPOINT' ? '<span class="status-badge badge-ckpt">⚠ CHECKPOINT</span>'
      : r.status === 'DIE' ? '<span class="status-badge badge-err">✗ DIE</span>'
      : '<span class="status-badge badge-err">✗ LỖI</span>'
    return `<tr>
      <td>${i + 1}</td>
      <td class="col-uid-val" title="${r.cookie ? r.cookie.slice(0, 120) + '…' : ''}">${r.uid || '<i style="color:var(--text-muted)">(cookie trần)</i>'}</td>
      <td>${badge}</td>
      <td>${r.like || 0}</td>
      <td>${r.friend || 0}</td>
      <td>${r.group || 0}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis" title="${(r.note || '').replace(/"/g, '&quot;')}">${r.note || ''}</td>
    </tr>`
  }).join('')
}

function nuoiUpdateImportCount() {
  const el = $('nuoi-import-count')
  if (el) el.textContent = loadedEntries.length
}

$('btn-nuoi-start').onclick = async () => {
  if (nuoiRunning) return
  if (!loadedEntries.length) {
    showToast('⚠️ Chưa nạp cookie nào — dùng menu bên trái (Chọn thư mục / file / Dán cookie trực tiếp)', 3000)
    return
  }
  const entries = loadedEntries.map(e => ({ cookie: e.cookie, raw: e.raw || '' }))
  const proxyText = $('nuoi-proxy-input').value.trim()
  const minutes = parseInt($('nuoi-minutes').value, 10) || 15
  const concurrency = parseInt($('nuoi-concurrency').value, 10) || 1
  const showBrowser = $('nuoi-show-browser').checked

  nuoiRunning = true
  $('btn-nuoi-start').style.display = 'none'
  $('btn-nuoi-stop').style.display = ''
  appendNuoiLog(`🚀 Gửi yêu cầu nuôi ${entries.length} tài khoản...`, 'info')

  const res = await window.api.startNuoi({ entries, proxyText, minutes, concurrency, showBrowser })
  if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 4000)
    appendNuoiLog(`❌ ${res.error}`, 'ckpt')
    nuoiRunning = false
    $('btn-nuoi-start').style.display = ''
    $('btn-nuoi-stop').style.display = 'none'
  }
}

$('btn-nuoi-stop').onclick = async () => {
  appendNuoiLog('⏹ Đang yêu cầu dừng nuôi...', 'info')
  await window.api.stopNuoi()
  showToast('⏹ Đã gửi lệnh dừng')
}

$('btn-nuoi-export').onclick = async () => {
  const res = await window.api.exportNuoiResults(nuoiRows)
  if (res && res.success) showToast(`✅ Đã xuất ${res.count} nick Live!`, 3000)
  else if (res && res.error) showToast(`⚠️ ${res.error}`, 3000)
}

$('btn-nuoi-clear').onclick = () => {
  nuoiRows = []
  nuoiStats = { total: 0, live: 0, ckpt: 0, err: 0, run: 0 }
  renderNuoiTable()
  nuoiUpdateStats()
}

$('btn-nuoi-clear-log').onclick = () => {
  const box = $('nuoi-console-box')
  if (box) box.innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa nhật ký.</div>'
}

$('btn-nuoi-loadproxy').onclick = async () => {
  const res = await window.api.pickProxyFile()
  if (res && res.content) {
    $('nuoi-proxy-input').value = res.content
    showToast('📂 Đã nạp file proxy', 2500)
  } else if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 3000)
  }
}

// ── Hàng chờ nuôi tự động từ Reg (LIVE + proxy riêng) ──
let nuoiQueue = []
function renderNuoiQueue() {
  const tbody = $('nuoi-queue-body')
  if (!tbody) return
  const badge = $('nuoi-queue-badge')
  if (badge) badge.textContent = nuoiQueue.length + ' via'
  if (!nuoiQueue.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7" style="text-align:center;color:var(--text-muted);padding:18px">Chưa có via nào được đẩy sang từ Auto Reg. Via LIVE sẽ tự động xuất hiện ở đây.</td></tr>'
    return
  }
  tbody.innerHTML = nuoiQueue.map((q, i) => {
    const st = q.status === 'CHỜ' ? '<span style="color:#d29922">CHỜ</span>'
      : q.status === 'ĐANG NUÔI' ? '<span style="color:#58a6ff">ĐANG NUÔI</span>'
      : q.status === 'LIVE' ? '<span class="status-badge live">LIVE ✓</span>'
      : q.status === 'CHECKPOINT' ? '<span class="status-badge ckpt">CKPT ⚠</span>'
      : '<span class="status-badge err">' + (q.status || 'LỖI') + '</span>'
    return '<tr>' +
      '<td class="num-cell">' + (i + 1) + '</td>' +
      '<td class="uid-cell">' + (q.uid || '—') + '</td>' +
      '<td style="font-size:11.5px;color:#8b949e">' + (q.email || '—') + '</td>' +
      '<td style="font-family:monospace;font-size:11px;max-width:150px;word-break:break-all">' + (q.proxyDisplay || 'IP nhà') + '</td>' +
      '<td>' + st + '</td>' +
      '<td style="font-size:11.5px">' + (q.note || '—') + '</td>' +
      '<td><button class="copy-btn" data-quid="' + (q.uid || '') + '">🗑 Xóa</button></td>' +
      '</tr>'
  }).join('')
  tbody.querySelectorAll('.copy-btn').forEach(b => {
    b.onclick = async () => { await window.api.removeNuoiQueueItem(b.dataset.quid) }
  })
}
window.api.onNuoiQueue((list) => { nuoiQueue = list || []; renderNuoiQueue() })
;(async () => { try { nuoiQueue = await window.api.getNuoiQueue() || []; renderNuoiQueue() } catch {} })()
if ($('btn-nuoi-queue-clear')) $('btn-nuoi-queue-clear').onclick = async () => { await window.api.clearNuoiQueue(); showToast('🗑 Đã xóa toàn bộ hàng chờ nuôi', 2000) }
if ($('btn-nuoi-queue-clear-done')) $('btn-nuoi-queue-clear-done').onclick = async () => { await window.api.clearNuoiQueue('LIVE'); await window.api.clearNuoiQueue('CHECKPOINT'); await window.api.clearNuoiQueue('ERROR'); showToast('🧹 Đã xóa các via đã xử lý xong', 2000) }
if ($('btn-nuoi-queue-start')) $('btn-nuoi-queue-start').onclick = async () => { await window.api.startNuoiQueue(); showToast('▶ Đã bật chạy hàng chờ nuôi', 2000) }

window.api.onNuoiLog((msg) => appendNuoiLog(msg))

window.api.onNuoiResult((row) => {
  nuoiRows.unshift(row)
  nuoiStats.total++
  if (row.status === 'LIVE') nuoiStats.live++
  else if (row.status === 'CHECKPOINT') nuoiStats.ckpt++
  else nuoiStats.err++
  renderNuoiTable()
  nuoiUpdateStats()
})

window.api.onNuoiDone((data) => {
  nuoiRunning = false
  $('btn-nuoi-start').style.display = ''
  $('btn-nuoi-stop').style.display = 'none'
  appendNuoiLog(`=== HOÀN TẤT NUÔI: ${data.live}/${data.finished} nick LIVE ===`, 'live')
  showToast('🏁 Nuôi FB hoàn tất!', 3000)
})

// ==================== GIẢI CHECKPOINT (nạp cookie -> mở theo luồng -> tự giải) ====================
if ($('side-tab-ckpt')) $('side-tab-ckpt').onclick = () => switchTab('ckpt')

let ckptRows = []
let ckptStats = { total: 0, solved: 0, fail: 0, err: 0, run: 0 }
let ckptRunning = false

function appendCkptLog(msg, type) {
  const box = $('ckpt-console-box')
  if (!box) return
  const div = document.createElement('div')
  div.className = 'log-entry' + (type ? ' ' + type : '')
  const time = new Date().toLocaleTimeString('vi-VN')
  div.textContent = `[${time}] ${msg}`
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
}

function ckptUpdateImportCount() {
  const el = $('ckpt-import-count')
  if (el) el.textContent = loadedEntries.length
}

// ==================== THÊM THÔNG TIN PROFILE (avatar + current city + home town) ====================
let profileRows = []
let profileStats = { total: 0, solved: 0, fail: 0, err: 0, run: 0 }
let profileRunning = false
let profilePhotoDir = ''

if ($('side-tab-profile')) $('side-tab-profile').onclick = () => switchTab('profile')
if ($('tab-btn-profile')) $('tab-btn-profile').onclick = () => switchTab('profile')

function profileUpdateImportCount() {
  const el = $('profile-import-count')
  if (el) el.textContent = loadedEntries.length
}

function profileUpdateStats() {
  $('profile-stat-total').textContent = profileStats.total
  $('profile-stat-solved').textContent = profileStats.solved
  $('profile-stat-fail').textContent = profileStats.fail
  $('profile-stat-err').textContent = profileStats.err
  $('profile-stat-run').textContent = profileStats.run
  $('profile-badge').textContent = `${profileStats.solved} hoàn thành`
}

function appendProfileLog(msg, type) {
  const box = $('profile-console-box')
  if (!box) return
  const div = document.createElement('div')
  div.className = 'log-entry' + (type ? ' ' + type : '')
  const time = new Date().toLocaleTimeString('vi-VN')
  div.textContent = `[${time}] ${msg}`
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
}

function renderProfileTable() {
  const tbody = $('profile-results-body')
  if (!tbody) return
  if (!profileRows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có kết quả. Nạp cookie bằng menu bên trái rồi bấm "Bắt Đầu Thêm".</td></tr>'
    $('profile-badge').textContent = '0 nick'
    return
  }
  $('profile-badge').textContent = `${profileRows.length} nick`
  tbody.innerHTML = profileRows.map((r, i) => {
    const st = r.status || 'ERROR'
    const stCls = st === 'SOLVED' ? 'status-live' : (st === 'FAIL' || st === 'CHECKPOINT' || st === 'DIE') ? 'status-ckpt' : 'status-err'
    const stTxt = st === 'SOLVED' ? 'HOÀN THÀNH ✓' : st === 'CHECKPOINT' ? 'CHECKPOINT ⚠' : st === 'DIE' ? 'COOKIE CHẾT ✗' : st === 'FAIL' ? 'KHÔNG ĐƯỢC ⚠' : 'LỖI ✗'
    return `<tr>
      <td>${i + 1}</td>
      <td class="uid-cell" title="${r.uid || ''}">${r.uid || '—'}</td>
      <td><span class="${stCls}">${stTxt}</span></td>
      <td title="${(r.note || '').replace(/"/g, '&quot;')}">${r.note || '—'}</td>
      <td><button class="copy-btn" data-copy="${r.cookie || ''}" title="Copy cookie">Copy</button></td>
    </tr>`
  }).join('')
}

$('btn-profile-photodir').onclick = async () => {
  try {
    const res = await window.api.pickProfilePhotoDir()
    if (res && res.path) {
      profilePhotoDir = res.path
      $('profile-photodir-label').textContent = `${res.path} (${res.count} ảnh)`
      $('profile-photodir-label').style.color = 'var(--text-green, #3fb950)'
      showToast(`📂 Đã chọn thư mục ảnh (${res.count} ảnh)`, 2500)
    }
  } catch (e) { showToast(`⚠️ ${e.message}`, 3000) }
}

$('btn-profile-loadproxy').onclick = async () => {
  const res = await window.api.pickProxyFile()
  if (res && res.content) {
    $('profile-proxy-input').value = res.content
    showToast('📂 Đã nạp file proxy', 2500)
  } else if (res && res.error) showToast(`⚠️ ${res.error}`, 3000)
}

$('btn-profile-start').onclick = async () => {
  if (profileRunning) return
  if (!loadedEntries.length) {
    showToast('⚠️ Chưa nạp cookie nào — dùng menu bên trái (Chọn thư mục / file / Dán cookie trực tiếp)', 3000)
    return
  }
  const entries = loadedEntries.map(e => ({ cookie: e.cookie, raw: e.raw || '' }))
  const proxyText = $('profile-proxy-input').value.trim()
  const concurrency = parseInt($('profile-concurrency').value, 10) || 1
  const showBrowser = $('profile-show-browser').checked

  profileRunning = true
  $('btn-profile-start').style.display = 'none'
  $('btn-profile-stop').style.display = ''
  appendProfileLog(`🚀 Gửi yêu cầu thêm Avatar cho ${entries.length} nick...`, 'info')

  const res = await window.api.startProfileInfo({ entries, proxyText, concurrency, showBrowser, photoDir: profilePhotoDir })
  if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 4000)
    appendProfileLog(`❌ ${res.error}`, 'ckpt')
    profileRunning = false
    $('btn-profile-start').style.display = ''
    $('btn-profile-stop').style.display = 'none'
  }
}

$('btn-profile-stop').onclick = async () => {
  appendProfileLog('⏹ Đang yêu cầu dừng...', 'info')
  await window.api.stopProfileInfo()
  showToast('⏹ Đã gửi lệnh dừng')
}

$('btn-profile-clear').onclick = () => {
  profileRows = []
  profileStats = { total: 0, solved: 0, fail: 0, err: 0, run: 0 }
  renderProfileTable()
  profileUpdateStats()
}

$('btn-profile-clear-log').onclick = () => {
  const box = $('profile-console-box')
  if (box) box.innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa nhật ký.</div>'
}

window.api.onProfileLog((msg) => appendProfileLog(msg))

window.api.onProfileRunning && window.api.onProfileRunning((data) => {
  profileStats.run++
  profileUpdateStats()
})

window.api.onProfileResult((row) => {
  profileRows.unshift(row)
  profileStats.total++
  if (profileStats.run > 0) profileStats.run--
  if (row.status === 'SOLVED') profileStats.solved++
  else if (row.status === 'FAIL' || row.status === 'CHECKPOINT' || row.status === 'DIE') profileStats.fail++
  else profileStats.err++
  renderProfileTable()
  profileUpdateStats()
})

window.api.onProfileDone(() => {
  profileRunning = false
  $('btn-profile-start').style.display = ''
  $('btn-profile-stop').style.display = 'none'
  appendProfileLog('=== HOÀN TẤT THÊM AVATAR ===', 'live')
  showToast('🏁 Thêm Profile hoàn tất!', 3000)
})

function renderCkptTable() {
  const tbody = $('ckpt-results-body')
  if (!tbody) return
  if (!ckptRows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có kết quả. Nạp cookie checkpoint bằng menu bên trái rồi bấm "Bắt Đầu Giải".</td></tr>'
    $('ckpt-badge').textContent = '0 nick'
    return
  }
  tbody.innerHTML = ckptRows.map((r, i) => {
    const st = r.status === 'SOLVED' || r.status === 'NO_CKPT' ? '<span class="status-badge live">' + (r.status === 'SOLVED' ? 'ĐÃ GIẢI' : 'KO CẦN') + '</span>'
      : r.status === 'PENDING_REVIEW' ? '<span class="status-badge" style="color:#58a6ff;border:1px solid #58a6ff66">CHỜ DUYỆT ⏳</span>'
      : r.status === 'STILL_CHECKPOINT' ? '<span class="status-badge ckpt">KẸT ⚠</span>'
      : '<span class="status-badge err" title="' + (r.note || '').replace(/"/g, '') + '">' + (r.status === 'DIE' ? 'DIE' : 'LỖI') + '</span>'
    const copyStr = ((r.uid || '') + '|' + (r.email || '') + '|' + (r.pass || '') + '|' + (r.twofa || '') + '|' + (r.cookie || '')).replace(/"/g, '')
    return '<tr>' +
      '<td class="num-cell">' + (i + 1) + '</td>' +
      '<td class="uid-cell">' + (r.uid || '-') + '</td>' +
      '<td>' + st + '</td>' +
      '<td style="font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (r.note || '').replace(/"/g, '') + '">' + (r.note || '—') + '</td>' +
      '<td><button class="copy-btn" data-copy="' + copyStr + '">Copy</button></td>' +
      '</tr>'
  }).join('')
  const solved = ckptRows.filter(r => r.status === 'SOLVED' || r.status === 'NO_CKPT').length
  $('ckpt-badge').textContent = solved + ' đã giải'
  tbody.querySelectorAll('.copy-btn').forEach(b => {
    b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); b.textContent = '✓'; setTimeout(() => b.textContent = 'Copy', 1200) }
  })
}

function ckptUpdateStats() {
  $('stat-ckpt-total').textContent = ckptStats.total
  $('stat-ckpt-solved').textContent = ckptStats.solved
  $('stat-ckpt-fail').textContent = ckptStats.fail
  $('stat-ckpt-err').textContent = ckptStats.err
  $('stat-ckpt-run').textContent = ckptStats.run
}

let ckptPhotoDir = ''

$('btn-ckpt-photodir').onclick = async () => {
  try {
    const res = await window.api.pickCkptPhotoFolder()
    if (res && res.canceled) return
    if (res && res.path) {
      ckptPhotoDir = res.path
      $('ckpt-photodir-label').textContent = res.path + ' (' + res.count + ' ảnh)'
      $('ckpt-photodir-label').style.color = '#3fb950'
      showToast(`📂 Đã chọn thư mục ${res.count} ảnh xác minh`, 2500)
    } else {
      showToast('⚠️ Không chọn được thư mục: ' + JSON.stringify(res).substring(0, 80), 4000)
    }
  } catch (e) {
    showToast('❌ Lỗi chọn thư mục ảnh: ' + e.message, 5000)
    appendCkptLog('❌ Lỗi chọn thư mục ảnh: ' + e.message)
  }
}

$('btn-ckpt-start').onclick = async () => {
  if (ckptRunning) return
  if (!loadedEntries.length) {
    showToast('⚠️ Chưa nạp cookie nào — dùng menu bên trái (Chọn thư mục / file / Dán cookie trực tiếp)', 3000)
    return
  }
  const entries = loadedEntries.map(e => ({ cookie: e.cookie, raw: e.raw || '' }))
  const proxyText = $('ckpt-proxy-input').value.trim()
  const concurrency = parseInt($('ckpt-concurrency').value, 10) || 1
  const showBrowser = $('ckpt-show-browser').checked

  ckptRunning = true
  $('btn-ckpt-start').style.display = 'none'
  $('btn-ckpt-stop').style.display = ''
  appendCkptLog(`🔓 Gửi yêu cầu giải checkpoint ${entries.length} nick (${concurrency} luồng)${ckptPhotoDir ? ' | ảnh xác minh: ' + ckptPhotoDir : ''}...`)

  const res = await window.api.startCkpt({ entries, proxyText, concurrency, showBrowser, photoDir: ckptPhotoDir })
  if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 4000)
    appendCkptLog(`❌ ${res.error}`)
    ckptRunning = false
    $('btn-ckpt-start').style.display = ''
    $('btn-ckpt-stop').style.display = 'none'
  }
}

$('btn-ckpt-stop').onclick = async () => {
  appendCkptLog('⏹ Đang yêu cầu dừng giải checkpoint...')
  await window.api.stopCkpt()
  showToast('⏹ Đã gửi lệnh dừng')
}

$('btn-ckpt-export').onclick = async () => {
  const res = await window.api.exportCkptResults(ckptRows)
  if (res && res.success) showToast(`✅ Đã xuất ${res.count} nick đã giải!`, 3000)
  else if (res && res.error) showToast(`⚠️ ${res.error}`, 3000)
}

$('btn-ckpt-clear').onclick = () => {
  ckptRows = []
  ckptStats = { total: 0, solved: 0, fail: 0, err: 0, run: 0 }
  renderCkptTable()
  ckptUpdateStats()
}

$('btn-ckpt-clear-log').onclick = () => {
  const box = $('ckpt-console-box')
  if (box) box.innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa nhật ký.</div>'
}

$('btn-ckpt-loadproxy').onclick = async () => {
  const res = await window.api.pickProxyFile()
  if (res && res.content) {
    $('ckpt-proxy-input').value = res.content
    showToast('📂 Đã nạp file proxy', 2500)
  } else if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 3000)
  }
}

// ── Cấu hình AI đọc captcha: nạp / lưu / xem usage token của key ──
;(async function ckptLoadAiConfig() {
  try {
    const cfg = await window.api.getCkptAiConfig()
    if (cfg && $('ckpt-ai-key')) {
      $('ckpt-ai-key').value = cfg.key || ''
      $('ckpt-ai-model').value = cfg.model || ''
      $('ckpt-ai-enabled').checked = cfg.enabled !== false
    }
  } catch {}
})()

if ($('btn-ckpt-ai-save')) $('btn-ckpt-ai-save').onclick = async () => {
  const res = await window.api.saveCkptAiConfig({
    key: $('ckpt-ai-key').value.trim(),
    model: $('ckpt-ai-model').value.trim(),
    enabled: $('ckpt-ai-enabled').checked
  })
  if (res && res.success) showToast('✅ Đã lưu cấu hình AI — chạy tiếp dùng key/model mới ngay', 3000)
  else showToast(`⚠️ ${(res && res.error) || 'Lỗi lưu cấu hình AI'}`, 3500)
}

if ($('btn-ckpt-ai-usage')) $('btn-ckpt-ai-usage').onclick = async () => {
  const el = $('ckpt-ai-usage-display')
  if (el) el.textContent = '⏳ Đang hỏi OpenRouter...'
  try {
    const res = await window.api.getCkptAiUsage()
    const d = (res && res.remote) || {}
    const l = (res && res.local) || {}
    const today = new Date().toISOString().slice(0, 10)
    const td = (l.byDay && l.byDay[today]) || { calls: 0, prompt: 0, completion: 0, errors429: 0 }
    const totK = (((l.promptTokens || 0) + (l.completionTokens || 0)) / 1000).toFixed(1)
    const tdK = (((td.prompt || 0) + (td.completion || 0)) / 1000).toFixed(1)
    let barHtml = ''
    if (typeof d.usage === 'number' && d.limit) {
      const pct = Math.min(100, Math.round(100 * d.usage / d.limit))
      barHtml = `<div style="background:#0d1117;border-radius:4px;height:8px;margin-top:5px;overflow:hidden"><div style="width:${pct}%;height:8px;background:${pct >= 80 ? '#f85149' : (pct >= 50 ? '#d29922' : '#3fb950')}"></div></div>`
    }
    if (d.error) {
      if (el) el.innerHTML = `⚠️ Key: ${d.error}<br>App đã gọi AI: <b>${l.totalCalls || 0} lần</b> · ${totK}K tokens (hôm nay ${td.calls || 0} lần / ${tdK}K tokens${td.errors429 ? `, ⚠ ${td.errors429} lần rate-limit` : ''})`
      return
    }
    const usedTxt = typeof d.usage === 'number' ? `$${d.usage.toFixed(4)}` : '?'
    const limitTxt = (d.limit == null) ? 'không giới hạn credit (free)' : `$${Number(d.limit).toFixed(2)}`
    const rl = d.rate_limit ? `${d.rate_limit.requests} request/${d.rate_limit.interval}` : '?'
    if (el) el.innerHTML =
      `Key: đã dùng <b>${usedTxt}</b> / ${limitTxt}${d.limit ? ` (${Math.min(100, Math.round(100 * d.usage / d.limit))}%)` : ''} · ` +
      `Free tier: ${d.is_free_tier ? '✔' : '✖'} · Giới hạn tốc độ: ${rl}` +
      `<br>App đã gọi AI: <b>${l.totalCalls || 0} lần</b> · ${totK}K tokens — hôm nay: ${td.calls || 0} lần / ${tdK}K tokens${(l.errors429 || 0) ? ` · ⚠ ${l.errors429} lần rate-limit (429)` : ''}` +
      barHtml
  } catch (e) {
    if (el) el.textContent = `⚠️ Lỗi: ${e.message}`
  }
}

window.api.onCkptLog((msg) => appendCkptLog(msg))

window.api.onCkptAccountResult((row) => {
  ckptRows.unshift(row)
  ckptStats.total++
  if (row.status === 'SOLVED' || row.status === 'NO_CKPT') ckptStats.solved++
  else if (row.status === 'STILL_CHECKPOINT') ckptStats.fail++
  else ckptStats.err++
  renderCkptTable()
  ckptUpdateStats()
})

window.api.onCkptDone(() => {
  ckptRunning = false
  $('btn-ckpt-start').style.display = ''
  $('btn-ckpt-stop').style.display = 'none'
  appendCkptLog('=== HOÀN TẤT PHIÊN GIẢI CHECKPOINT ===', 'live')
  showToast('🏁 Giải Checkpoint hoàn tất!', 3000)
})

// Recheck 2h: FB duyệt xong chưa — cập nhật row + log
window.api.onCkptRecheckResult((p) => {
  const row = ckptRows.find(r => r.uid === p.uid)
  if (row) {
    row.status = p.status === 'SOLVED' ? 'SOLVED' : (p.status === 'DIE' ? 'DIE' : 'STILL_CHECKPOINT')
    row.note = p.note || row.note
    if (p.cookie) row.cookie = p.cookie
  } else {
    ckptRows.unshift({ uid: p.uid, status: p.status === 'SOLVED' ? 'SOLVED' : (p.status === 'DIE' ? 'DIE' : 'STILL_CHECKPOINT'), note: p.note || 'recheck 2h', email: p.email, pass: p.pass, twofa: p.twofa, cookie: p.cookie })
  }
  if (p.status === 'SOLVED') { ckptStats.solved++; ckptStats.fail = Math.max(0, ckptStats.fail - 1) }
  renderCkptTable()
  ckptUpdateStats()
  appendCkptLog(`🔔 Recheck 2h ${p.uid || ''}: ${p.status === 'SOLVED' ? '✅ ĐÃ GIẢI — nick vào được feed' : '❌ ' + (p.note || p.status)}`, p.status === 'SOLVED' ? 'live' : 'ckpt')
  if (p.status === 'SOLVED') showToast(`✅ ${p.uid}: FB đã duyệt — checkpoint đã giải!`, 4000)
})

// ==================== AUTHENTICATION (nạp cookie -> đổi thông tin) ====================
if ($('tab-btn-auth'))  $('tab-btn-auth').onclick  = () => switchTab('auth')
if ($('side-tab-auth')) $('side-tab-auth').onclick = () => switchTab('auth')

let authRows = []
let authStats = { total: 0, live: 0, ckpt: 0, err: 0, run: 0 }
let authRunning = false

function appendAuthLog(msg, type) {
  const box = $('auth-console-box')
  if (!box) return
  const div = document.createElement('div')
  div.className = 'log-entry ' + (type || '')
  const time = new Date().toLocaleTimeString('vi-VN')
  div.textContent = `[${time}] ${msg}`
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
}

function authUpdateStats() {
  $('stat-auth-total').textContent = authStats.total
  $('stat-auth-live').textContent  = authStats.live
  $('stat-auth-ckpt').textContent  = authStats.ckpt
  $('stat-auth-err').textContent   = authStats.err
  $('stat-auth-run').textContent   = authStats.run
  $('auth-badge').textContent      = `${authRows.length} nick`
}

function renderAuthTable() {
  const tbody = $('auth-results-body')
  if (!tbody) return
  if (!authRows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có kết quả. Nạp cookie bằng menu bên trái rồi bấm "Bắt Đầu Đổi Thông Tin".</td></tr>'
    return
  }
  tbody.innerHTML = authRows.map((r, i) => {
    const cls = r.status === 'LIVE' ? 'live' : r.status === 'CHECKPOINT' ? 'ckpt' : r.status === 'DIE' ? 'die' : 'err'
    const statusTxt = r.status === 'LIVE' ? (r.live ? 'Đổi OK ✓' : 'Live chưa đổi') : r.status
    return `<tr>
      <td>${i + 1}</td>
      <td>${r.uid || '-'}</td>
      <td><span class="status-badge ${cls}">${statusTxt}</span></td>
      <td>${r.newEmail || '-'}</td>
      <td style="font-family:monospace;letter-spacing:1px">${r.twofa || '-'}</td>
      <td>${r.deletedOld ? '✓' : '-'}</td>
      <td>${(r.note || '').replace(/</g, '&lt;')}</td>
    </tr>`
  }).join('')
}

function authUpdateImportCount() {
  const el = $('auth-import-count')
  if (el) el.textContent = loadedEntries.length
}

$('btn-auth-start').onclick = async () => {
  if (authRunning) return
  if (!loadedEntries.length) {
    showToast('⚠️ Chưa nạp cookie nào — dùng menu bên trái (Chọn thư mục / file / Dán cookie trực tiếp)', 3000)
    return
  }
  const entries = loadedEntries.map(e => ({ cookie: e.cookie, raw: e.raw || '' }))
  const proxyText = $('auth-proxy-input').value.trim()
  const concurrency = parseInt($('auth-concurrency').value, 10) || 1
  const showBrowser = $('auth-show-browser').checked
  const emailProvider = $('auth-email-provider').value

  authRunning = true
  authStats.run = entries.length
  authUpdateStats()
  $('btn-auth-start').style.display = 'none'
  $('btn-auth-stop').style.display = ''
  appendAuthLog(`🚀 Gửi yêu cầu đổi thông tin ${entries.length} tài khoản...`, 'info')

  const res = await window.api.startAuth({ entries, proxyText, concurrency, showBrowser, emailProvider })
  if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 4000)
    appendAuthLog(`❌ ${res.error}`, 'ckpt')
    authRunning = false
    authStats.run = 0
    authUpdateStats()
    $('btn-auth-start').style.display = ''
    $('btn-auth-stop').style.display = 'none'
  }
}

$('btn-auth-stop').onclick = async () => {
  appendAuthLog('⏹ Đang yêu cầu dừng...', 'info')
  await window.api.stopAuth()
  showToast('⏹ Đã gửi lệnh dừng')
}

$('btn-auth-export').onclick = async () => {
  const res = await window.api.exportAuthResults(authRows)
  if (res && res.success) showToast(`✅ Đã xuất ${res.count} nick đã đổi thông tin!`, 3000)
  else if (res && res.error) showToast(`⚠️ ${res.error}`, 3000)
}

$('btn-auth-clear').onclick = () => {
  authRows = []
  authStats = { total: 0, live: 0, ckpt: 0, err: 0, run: authRunning ? authStats.run : 0 }
  renderAuthTable()
  authUpdateStats()
}

$('btn-auth-clear-log').onclick = () => {
  const box = $('auth-console-box')
  if (box) box.innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa nhật ký.</div>'
}

$('btn-auth-loadproxy').onclick = async () => {
  const res = await window.api.pickProxyFile()
  if (res && res.content) {
    $('auth-proxy-input').value = res.content
    showToast('📂 Đã nạp file proxy', 2500)
  } else if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 3000)
  }
}

window.api.onAuthLog((msg) => appendAuthLog(msg))

window.api.onAuthResult((row) => {
  authRows.unshift(row)
  authStats.total++
  if (row.status === 'LIVE') authStats.live++
  else if (row.status === 'CHECKPOINT') authStats.ckpt++
  else authStats.err++
  renderAuthTable()
  authUpdateStats()
})

window.api.onAuthDone((data) => {
  authRunning = false
  authStats.run = 0
  authUpdateStats()
  $('btn-auth-start').style.display = ''
  $('btn-auth-stop').style.display = 'none'
  appendAuthLog(`=== HOÀN TẤT AUTHENTICATION: ${data.changed}/${data.finished} nick đổi thông tin thành công ===`, 'live')
  showToast('🏁 Authentication hoàn tất!', 3000)
})

// ═══════════════ TEMP MAIL: đọc hòm thư temp lấy OTP ═══════════════
const TM_PROVIDER_NAMES = {
  auto: 'Tự động', tempmailapi: 'TempMailAPI', mailtd: 'Mail.td',
  mailtm: 'Mail.tm', tempmailid: 'TempMail.id', tempmailg: 'TempMailG'
}
let tmTimer = null
let tmFetching = false
let tmLastMails = [] // [{id, subject, otp}] — để đánh dấu thư mới về

if ($('side-tab-tempmail')) $('side-tab-tempmail').onclick = () => switchTab('tempmail')

function tmSetStatus(msg, color) {
  const el = $('tempmail-status')
  if (!el) return
  el.textContent = msg
  el.style.color = color || ''
}

function tmRenderMails(emails, isNewBatch) {
  const box = $('tempmail-mails')
  if (!box) return
  $('tempmail-mail-count').textContent = `${emails.length} thư`
  if (!emails.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--text-muted,#9aa4b2);padding:28px;font-size:13px">Hòm thư trống — chưa có thư nào về.</div>'
    return
  }
  box.innerHTML = emails.map((m, i) => {
    const isNew = isNewBatch && tmLastMails.length && !tmLastMails.some(o => String(o.id) === String(m.id))
    const otpHtml = m.otp
      ? `<button class="tm-copy-otp action-btn green" data-otp="${m.otp}" title="Bấm copy mã OTP" style="padding:5px 12px;font-size:13px;font-weight:700;letter-spacing:2px">${m.otp} 📋</button>`
      : '<span style="font-size:12px;color:var(--text-muted,#9aa4b2)">không thấy mã</span>'
    const subj = String(m.subject || '(không tiêu đề)').replace(/</g, '&lt;')
    const from = String(m.from || '').replace(/</g, '&lt;')
    const prev = String(m.preview || '').replace(/</g, '&lt;')
    return `<div style="background:#0d1117;border:1px solid ${isNew ? '#2ea043' : '#2a2f3a'};border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600;color:#e6e6e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${isNew ? '🆕 ' : ''}${subj}</div>
          <div style="font-size:11px;color:var(--text-muted,#9aa4b2);margin-top:2px">${from}</div>
        </div>
        <div style="flex-shrink:0">${otpHtml}</div>
      </div>
      ${prev ? `<div style="font-size:11px;color:#8b949e;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${prev}</div>` : ''}
    </div>`
  }).join('')
  box.querySelectorAll('.tm-copy-otp').forEach(btn => {
    btn.onclick = () => {
      navigator.clipboard.writeText(btn.dataset.otp).then(() => {
        btn.textContent = btn.dataset.otp + ' ✓'
        showToast(`📋 Đã copy OTP ${btn.dataset.otp}`)
        setTimeout(() => { btn.textContent = btn.dataset.otp + ' 📋' }, 1500)
      }).catch(() => showToast('⚠️ Không copy được', 2000))
    }
  })
}

async function tmFetch(quiet) {
  if (tmFetching) return
  const input = $('tempmail-input').value.trim()
  if (!input) { if (!quiet) showToast('⚠️ Dán email temp (hoặc token hòm thư) vào ô trước', 3000); return }
  tmFetching = true
  const btn = $('btn-tempmail-fetch')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang đọc...' }
  if (!quiet) tmSetStatus('đang tải...', '#f0883e')
  try {
    const res = await window.api.tempmailFetch({ input, provider: $('tempmail-provider').value })
    if (res && res.success) {
      tmSetStatus(`${TM_PROVIDER_NAMES[res.provider] || res.provider} • ${res.count} thư • ${new Date().toLocaleTimeString('vi-VN')}`, '#3fb950')
      tmRenderMails(res.emails || [], true)
      tmLastMails = (res.emails || []).map(m => ({ id: m.id }))
    } else {
      tmSetStatus('lỗi', '#f85149')
      tmRenderMails([], false)
      if (!quiet) showToast(`⚠️ ${res && res.error || 'Lỗi đọc hòm thư'}`, 5000)
    }
  } catch (e) {
    tmSetStatus('lỗi', '#f85149')
    if (!quiet) showToast(`⚠️ ${e.message}`, 4000)
  } finally {
    tmFetching = false
    if (btn) { btn.disabled = false; btn.textContent = '📬 Lấy Thư' }
  }
}

if ($('btn-tempmail-fetch')) $('btn-tempmail-fetch').onclick = () => tmFetch(false)
if ($('tempmail-autorefresh')) {
  $('tempmail-autorefresh').onchange = (e) => {
    if (tmTimer) { clearInterval(tmTimer); tmTimer = null }
    if (e.target.checked) {
      tmFetch(true)
      tmTimer = setInterval(() => tmFetch(true), 8000)
      showToast('🔄 Tự làm mới mỗi 8s — BẬT', 2500)
    } else showToast('⏸ Tự làm mới — TẮT', 2000)
  }
}

// ═══════════════ REG PAGE: tạo Page từ cookie ═══════════════
let pageRows = []
let pageRunning = false
let pageNames = []

function appendPageLog(msg) {
  const box = $('page-console-box')
  if (!box) return
  const div = document.createElement('div')
  div.className = 'log-entry'
  const time = new Date().toLocaleTimeString('vi-VN')
  div.textContent = `[${time}] ${msg}`
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
}

function renderPageTable() {
  const tbody = $('page-results-body')
  if (!tbody) return
  if (!pageRows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">Chưa có kết quả. Nạp cookie bằng menu bên trái rồi bấm "Bắt Đầu Tạo Page".</td></tr>'
    $('page-badge').textContent = '0 page'
    return
  }
  tbody.innerHTML = pageRows.map((r, i) => {
    const cls = r.status === 'LIVE' ? 'live' : r.status === 'CHECKPOINT' ? 'ckpt' : r.status === 'DIE' ? 'die' : 'err'
    const link = r.pageUrl ? `<a href="${r.pageUrl}" style="color:#58a6ff;font-size:12px;word-break:break-all">${r.pageUrl.length > 55 ? r.pageUrl.substring(0, 55) + '…' : r.pageUrl}</a>` : '-'
    return `<tr>
      <td>${i + 1}</td>
      <td>${r.uid || '-'}</td>
      <td><span class="status-badge ${cls}">${r.status}</span></td>
      <td style="font-weight:600">${(r.pageName || '-').replace(/</g, '&lt;')}</td>
      <td>${link}</td>
      <td>${(r.note || '').replace(/</g, '&lt;')}</td>
    </tr>`
  }).join('')
  $('page-badge').textContent = `${pageRows.length} page`
}

if ($('side-tab-page')) $('side-tab-page').onclick = () => switchTab('page')

if ($('btn-page-loadnames')) {
  $('btn-page-loadnames').onclick = async () => {
    const res = await window.api.pickNamesFile()
    if (res && res.success) {
      pageNames = res.names || []
      $('page-names-badge').textContent = `${pageNames.length} tên từ file`
      showToast(`📂 Đã nạp ${pageNames.length} tên — mỗi cookie lấy 1 tên theo thứ tự`, 3000)
      appendPageLog(`📂 Nạp file tên: ${pageNames.length} tên (cookie #1 lấy "${pageNames[0] || '—'}", cookie #2 lấy "${pageNames[1] || '—'}", ...)`)
    } else if (res && res.error) showToast(`⚠️ ${res.error}`, 3000)
  }
}

$('btn-page-start').onclick = async () => {
  if (pageRunning) return
  if (!loadedEntries.length) {
    showToast('⚠️ Chưa nạp cookie nào — dùng menu bên trái (Chọn thư mục / file / Dán cookie trực tiếp)', 3000)
    return
  }
  const entries = loadedEntries.map(e => ({ cookie: e.cookie, raw: e.raw || '' }))
  const manualName = $('page-name-input').value.trim()
  if (!pageNames.length && !manualName) {
    showToast('⚠️ Nạp file tên (.txt) hoặc nhập tên Page trước', 3500)
    return
  }
  const concurrency = parseInt($('page-concurrency').value, 10) || 1
  const showBrowser = $('page-show-browser').checked
  const proxyText = $('page-proxy-input').value.trim()

  pageRunning = true
  $('btn-page-start').style.display = 'none'
  $('btn-page-stop').style.display = ''
  appendPageLog(`🚀 Gửi yêu cầu tạo Page cho ${entries.length} cookie...`)

  const res = await window.api.startPage({ entries, names: pageNames, manualName, concurrency, showBrowser, proxyText })
  if (res && res.error) {
    showToast(`⚠️ ${res.error}`, 4000)
    appendPageLog(`❌ ${res.error}`, 'ckpt')
    pageRunning = false
    $('btn-page-start').style.display = ''
    $('btn-page-stop').style.display = 'none'
  }
}

$('btn-page-stop').onclick = async () => {
  appendPageLog('⏹ Đang yêu cầu dừng...', 'info')
  await window.api.stopPage()
  showToast('⏹ Đã gửi lệnh dừng')
}

if ($('btn-page-clear-log')) {
  $('btn-page-clear-log').onclick = () => {
    const box = $('page-console-box')
    if (box) box.innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa nhật ký.</div>'
  }
}

window.api.onPageLog((msg) => appendPageLog(msg))

window.api.onPageResult((row) => {
  pageRows.unshift(row)
  renderPageTable()
})

window.api.onPageDone((data) => {
  pageRunning = false
  $('btn-page-start').style.display = ''
  $('btn-page-stop').style.display = 'none'
  appendPageLog(`=== HOÀN TẤT REG PAGE: ${data.created}/${data.finished} page tạo thành công ===`, 'live')
  showToast('🏁 REG PAGE hoàn tất!', 3000)
})

// ═══════════════ AUTO REG FB v2 — GMAIL (dot/plus + IMAP) ═══════════════
const regv2Accounts = []
const regv2Stats = { total: 0, live: 0, ckpt: 0, err: 0 }
let regv2Running = false

function appendRegV2Log(msg) {
  const box = $('regv2-console-box')
  if (!box) return
  const div = document.createElement('div')
  div.className = 'log-entry'
  const time = new Date().toLocaleTimeString('vi-VN')
  div.textContent = `[${time}] ${msg}`
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
}

function renderRegV2Table() {
  const tbody = $('regv2-results-body')
  if (!tbody) return
  if (!regv2Accounts.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9" style="text-align:center;color:var(--text-muted);padding:30px">Chưa có tài khoản nào được tạo trong phiên này</td></tr>'
    $('regv2-live-badge').textContent = '0 Live'
    return
  }
  tbody.innerHTML = regv2Accounts.map((a, i) => {
    const st = a.status === 'LIVE' ? '<span class="status-badge live">LIVE</span>'
      : a.status === 'CHECKPOINT' ? '<span class="status-badge ckpt">CKPT</span>'
      : a.status === 'ĐANG REG' ? '<span class="status-badge" style="color:#58a6ff" title="' + (a.error || '').replace(/"/g, '') + '">⏳ Đang reg</span>'
      : '<span class="status-badge err" title="' + ((a.error || '').replace(/"/g, '')) + '">' + (a.status || 'LỖI') + '</span>'
    const sed = a.status !== 'LIVE' ? '—'
      : a.sedding === 'PASS' ? '<span style="color:#3fb950;font-weight:600">PASS ✓</span>'
      : a.sedding === 'DEAD' ? '<span style="color:#f85149;font-weight:600">DEAD ✗</span>'
      : '<span style="color:#8b949e">đang gửi…</span>'
    const copyStr = ((a.uid || '') + '|' + (a.password || '') + (a.twoFaKey ? '|' + a.twoFaKey : '')).replace(/"/g, '')
    return '<tr>' +
      '<td class="num-cell">' + (i + 1) + '</td>' +
      '<td>' + st + '</td>' +
      '<td class="uid-cell">' + (a.uid || '-') + '</td>' +
      '<td style="font-size:12px"><b>' + (a.name || '-') + '</b><br><span style="color:#8b949e">' + (a.email || '-') + '</span></td>' +
      '<td style="font-family:monospace;font-size:12px">' + (a.password || '-') + '</td>' +
      '<td style="font-family:monospace;font-size:11px" title="' + (a.twoFaKey || 'chưa bật 2FA') + '">' + (a.twoFaKey ? '🔐 ' + a.twoFaKey : '—') + '</td>' +
      '<td style="font-family:monospace;font-size:11px;max-width:120px;word-break:break-all" title="' + (a.proxy || '').replace(/"/g, '') + '">' + (a.proxy || '—') + '</td>' +
      '<td>' + sed + '</td>' +
      '<td><button class="copy-btn" data-copy="' + copyStr + '">Copy</button></td>' +
      '</tr>'
  }).join('')
  const live = regv2Accounts.filter(a => a.status === 'LIVE').length
  $('regv2-live-badge').textContent = live + ' Live'
  tbody.querySelectorAll('.copy-btn').forEach(b => {
    b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); b.textContent = '✓'; setTimeout(() => b.textContent = 'Copy', 1200) }
  })
}

function regv2UpdateStats() {
  $('stat-regv2-total').textContent = regv2Stats.total
  $('stat-regv2-live').textContent = regv2Stats.live
  $('stat-regv2-ckpt').textContent = regv2Stats.ckpt
  $('stat-regv2-err').textContent = regv2Stats.err
}

$('btn-regv2-start').onclick = async () => {
  if (regv2Running) return
  // Cookie Gmail nạp từ IMPORT bên trái — mỗi cookie = 1 Gmail = 1 nick
  const gmailCookies = loadedEntries.map(e => e.cookie).filter(Boolean)
  if (!gmailCookies.length) {
    showToast('⚠️ Nạp cookie Gmail qua menu IMPORT bên trái trước (Dán cookie trực tiếp / Chọn file)', 4000)
    return
  }
  const count = parseInt($('regv2-count').value, 10) || 1
  const concurrency = parseInt($('regv2-concurrency').value, 10) || 1
  const showBrowser = $('regv2-show-browser').checked
  const proxy = $('regv2-proxy').value.trim() || null
  const gmailVariant = $('regv2-variant').value

  regv2Running = true
  regv2Accounts.length = 0
  renderRegV2Table()
  $('btn-regv2-start').style.display = 'none'
  if ($('btn-regv2-forever')) $('btn-regv2-forever').style.display = 'none'
  $('btn-regv2-stop').style.display = ''
  appendRegV2Log(`🚀 Reg v2 (Cookie Gmail — ${gmailVariant}): ${count} nick | ${concurrency} luồng | ${gmailCookies.length} cookie Gmail`)

  const res = await window.api.startReg({
    count, mode: 'tempmail', emailProvider: 'gmail', domain: null,
    showBrowser, proxy, concurrency, continuous: false,
    regVia: 'web', variant: 'v2', gmailCookies, gmailVariant
  })
  if (res && res.error) {
    appendRegV2Log('❌ ' + res.error)
    showToast('⚠️ ' + res.error, 3000)
    regv2Running = false
    $('btn-regv2-start').style.display = ''
    $('btn-regv2-stop').style.display = 'none'
  }
}

$('btn-regv2-forever').onclick = async () => {
  if (regv2Running) return
  const gmailCookies = loadedEntries.map(e => e.cookie).filter(Boolean)
  if (!gmailCookies.length) {
    showToast('⚠️ Nạp cookie Gmail qua menu IMPORT bên trái trước (Dán cookie trực tiếp / Chọn file)', 4000)
    return
  }
  const concurrency = parseInt($('regv2-concurrency').value, 10) || 1
  const showBrowser = $('regv2-show-browser').checked
  const proxy = $('regv2-proxy').value.trim() || null
  const gmailVariant = $('regv2-variant').value

  regv2Running = true
  regv2Accounts.length = 0
  renderRegV2Table()
  $('btn-regv2-start').style.display = 'none'
  $('btn-regv2-forever').style.display = 'none'
  $('btn-regv2-stop').style.display = ''
  appendRegV2Log(`♾️ REG LIÊN TỤC v2: ${gmailCookies.length} cookie Gmail — mỗi luồng giữ 1 cookie riêng, reg liên tục (gmail variant bị xóa khỏi FB sau mỗi nick nên cookie dùng lại được). Hết cookie sống hoặc bấm Dừng sẽ dừng.`)

  const res = await window.api.startReg({
    count: 9999, mode: 'tempmail', emailProvider: 'gmail', domain: null,
    showBrowser, proxy, concurrency, continuous: true,
    regVia: 'web', variant: 'v2', gmailCookies, gmailVariant
  })
  if (res && res.error) {
    appendRegV2Log('❌ ' + res.error)
    showToast('⚠️ ' + res.error, 3000)
    regv2Running = false
    $('btn-regv2-start').style.display = ''
    $('btn-regv2-forever').style.display = ''
    $('btn-regv2-stop').style.display = 'none'
  }
}

$('btn-regv2-stop').onclick = async () => {
  appendRegV2Log('⏹ Đang dừng...')
  await window.api.stopReg()
}

if ($('btn-regv2-clear')) $('btn-regv2-clear').onclick = () => {
  const b = $('regv2-console-box'); if (b) b.innerHTML = '<div class="log-entry sys">[Hệ thống] Đã xóa nhật ký.</div>'
}

function regv2UpdateCookieCount() { const el = $('regv2-cookie-count'); if (el) el.textContent = loadedEntries.length }
regv2UpdateCookieCount()
restoreImportedCookies()
window.api.onRegV2Log((msg) => { regv2UpdateCookieCount(); appendRegV2Log(msg) })
window.api.onRegV2AccountResult((acc) => {
  // 28-10: LIVE bằng proxy tĩnh -> tự xóa proxy đã dùng khỏi ô Proxy (1 proxy = 1 via)
  if (acc.status === 'LIVE' && acc.proxy && acc.proxy !== 'IP nhà') {
    const box = $('regv2-proxy')
    if (box) {
      const lines = box.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      const kept = lines.filter(l => !(l === acc.proxy || l.startsWith(acc.proxy + ':') || l.startsWith(acc.proxy + ' ')))
      if (kept.length !== lines.length) {
        box.value = kept.join('\n')
        appendRegV2Log(`🗑 Proxy ${acc.proxy} đã dùng cho via LIVE ${acc.uid || ''} — tự xóa khỏi ô Proxy`)
      }
    }
  }
  regv2Accounts.unshift({ ...acc })
  regv2Stats.total++
  if (acc.status === 'LIVE') regv2Stats.live++
  else if (acc.status === 'CHECKPOINT') regv2Stats.ckpt++
  else regv2Stats.err++
  renderRegV2Table()
  regv2UpdateStats()
})
// 28-10: trạng thái gửi VietSeeding (PASS/DEAD) — cập nhật cột Seeding theo uid
window.api.onRegV2Sedding((d) => {
  const row = regv2Accounts.find(a => a.uid === d.uid)
  if (!row) return
  row.sedding = d.st
  renderRegV2Table()
})
window.api.onRegV2Done((data) => {
  regv2Running = false
  $('btn-regv2-start').style.display = ''
  if ($('btn-regv2-forever')) $('btn-regv2-forever').style.display = ''
  $('btn-regv2-stop').style.display = 'none'
  const live = regv2Accounts.filter(a => a.status === 'LIVE').length
  appendRegV2Log(`=== HOÀN TẤT REG v2: ${live}/${data.total} nick LIVE ===`, 'live')
  showToast('🏁 Reg v2 hoàn tất!', 3000)
})

$('btn-regv2-export').onclick = async () => {
  const live = regv2Accounts.filter(a => a.status === 'LIVE')
  if (!live.length) { showToast('⚠️ Chưa có nick LIVE nào để xuất', 3000); return }
  const res = await window.api.exportRegV2(regv2Accounts)
  if (res && res.success) showToast('💾 Đã xuất ' + res.count + ' nick LIVE!', 3000)
  else if (res && res.error) showToast(`⚠️ ${res.error}`, 3500)
}

// Phát hiện "process cũ + UI mới": update file mà process cũ chưa tắt hẳn (single-instance
// lock mở lại cửa sổ cũ, renderer load mới từ đĩa nhưng main process vẫn code cũ -> thiếu
// IPC handler mới). Báo đậm để user tắt app trong Task Manager rồi mở lại.
;(() => {
  const RENDERER_BUILD_ID = 20261025.34
  const warnStale = () => {
    console.error('[BUILD] Main process cũ hơn UI — cần tắt hẳn app (Task Manager > FB-Cookie-Checker.exe) rồi mở lại!')
    showToast('🛑 APP ĐANG CHẠY TIẾN TRÌNH CŨ! Tắt FB-Cookie-Checker.exe trong Task Manager rồi mở lại app', 12000)
    setTimeout(() => showToast('🛑 Tiến trình cũ thiếu tính năng mới — tắt hẳn app (Task Manager) rồi mở lại!', 12000), 12500)
  }
  window.api.buildInfo()
    .then(id => { if (!(Number(id) >= RENDERER_BUILD_ID)) warnStale() })
    .catch(warnStale)
})()
