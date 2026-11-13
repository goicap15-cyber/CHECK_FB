const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Build info (phát hiện main process cũ sau update)
  buildInfo: () => ipcRenderer.invoke('app:buildinfo'),

  // Dialogs
  openFolder: () => ipcRenderer.invoke('dialog:folder'),
  openZip:    () => ipcRenderer.invoke('dialog:zip'),
  openFiles:  () => ipcRenderer.invoke('dialog:files'),
  parseDirectText: (text) => ipcRenderer.invoke('cookies:parseText', text),

  // File path helper for Drag & Drop
  getFilePath: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file)
      }
    } catch {}
    return file.path || ''
  },

  // Cookie checking
  checkCookies: (entries, concurrency, showBrowser) => ipcRenderer.invoke('cookies:check', { entries, concurrency, showBrowser }),
  abortCheck:   () => ipcRenderer.invoke('cookies:abort'),
  openCookieBrowser: (acc) => ipcRenderer.invoke('chk:openBrowser', acc),

  // Events (returns unsubscribe fn)
  onProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('check:progress', handler)
    return () => ipcRenderer.removeListener('check:progress', handler)
  },
  onComplete: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('check:complete', handler)
    return () => ipcRenderer.removeListener('check:complete', handler)
  },

  // Drop path helpers (drag & drop)
  _dropPath: (p) => ipcRenderer.invoke('dialog:dropPath', p),
  _dropZip:  (p) => ipcRenderer.invoke('dialog:dropZip2', p),

  // Export
  exportResults: (results, format) => ipcRenderer.invoke('results:export', { results, format }),
  exportLiveFolder: (results, filterStatus) => ipcRenderer.invoke('results:exportLiveFolder', results, filterStatus),

  // Auto Reg Facebook & TempMailMMO
  getRegDomains: (provider) => ipcRenderer.invoke('reg:getDomains', provider),
  testMail: (domain, provider) => ipcRenderer.invoke('reg:testMail', domain, provider),
  testSms: () => ipcRenderer.invoke('reg:testSms'),
  getSmsPrices: () => ipcRenderer.invoke('reg:getSmsPrices'),
  getApiKey: () => ipcRenderer.invoke('settings:getApiKey'),
  saveApiKey: (key) => ipcRenderer.invoke('settings:saveApiKey', key),
  getTempmailIdKey: () => ipcRenderer.invoke('settings:getTempmailIdKey'),
  saveTempmailIdKey: (key) => ipcRenderer.invoke('settings:saveTempmailIdKey', key),
  getSmsKey: () => ipcRenderer.invoke('settings:getSmsKey'),
  saveSmsKey: (key) => ipcRenderer.invoke('settings:saveSmsKey', key),
  getLdPath: () => ipcRenderer.invoke('settings:getLdPath'),
  saveLdPath: (dir) => ipcRenderer.invoke('settings:saveLdPath', dir),
  getMailTdKey: () => ipcRenderer.invoke('settings:getMailTdKey'),
  saveMailTdKey: (key) => ipcRenderer.invoke('settings:saveMailTdKey', key),
  getTempmailGKey: () => ipcRenderer.invoke('settings:getTempmailGKey'),
  saveTempmailGKey: (key) => ipcRenderer.invoke('settings:saveTempmailGKey', key),
  testLdplayer: () => ipcRenderer.invoke('reg:testLdplayer'),
  startReg: (opts) => ipcRenderer.invoke('reg:start', opts),
  stopReg: () => ipcRenderer.invoke('reg:stop'),
  toggleRegShowBrowser: (show) => ipcRenderer.invoke('reg:toggleShowBrowser', show),
  pickProxyFile: () => ipcRenderer.invoke('reg:pickProxyFile'),
  exportLiveReg: (accounts) => ipcRenderer.invoke('reg:exportLive', accounts),
  exportCkptReg: (accounts) => ipcRenderer.invoke('reg:exportCkpt', accounts),

  // Giải Checkpoint
  startCkpt: (opts) => ipcRenderer.invoke('fbckpt:start', opts),
  stopCkpt: () => ipcRenderer.invoke('fbckpt:stop'),
  exportCkptResults: (rows) => ipcRenderer.invoke('fbckpt:export', rows),
  pickCkptPhotoFolder: () => ipcRenderer.invoke('fbckpt:pickPhotoFolder'),

  // Thêm thông tin Profile
  pickProfilePhotoDir: () => ipcRenderer.invoke('fbprofile:pickPhotoDir'),
  startProfileInfo: (opts) => ipcRenderer.invoke('fbprofile:start', opts),
  stopProfileInfo: () => ipcRenderer.invoke('fbprofile:stop'),
  onProfileLog: (cb) => ipcRenderer.on('fbprofile:log', (e, msg) => cb(msg)),
  onProfileResult: (cb) => ipcRenderer.on('fbprofile:accountResult', (e, row) => cb(row)),
  onProfileRunning: (cb) => ipcRenderer.on('fbprofile:running', (e, data) => cb(data)),
  onProfileDone: (cb) => ipcRenderer.on('fbprofile:done', (e, d) => cb(d)),
  getCkptAiConfig: () => ipcRenderer.invoke('fbckpt:getAiConfig'),
  saveCkptAiConfig: (cfg) => ipcRenderer.invoke('fbckpt:saveAiConfig', cfg),
  getCkptAiUsage: () => ipcRenderer.invoke('fbckpt:aiUsage'),
  onCkptRecheckResult: (cb) => {
    const handler = (_, payload) => cb(payload)
    ipcRenderer.on('fbckpt:recheckResult', handler)
    return () => ipcRenderer.removeListener('fbckpt:recheckResult', handler)
  },
  onCkptLog: (cb) => {
    const handler = (_, msg) => cb(msg)
    ipcRenderer.on('fbckpt:log', handler)
    return () => ipcRenderer.removeListener('fbckpt:log', handler)
  },
  onCkptAccountResult: (cb) => {
    const handler = (_, row) => cb(row)
    ipcRenderer.on('fbckpt:accountResult', handler)
    return () => ipcRenderer.removeListener('fbckpt:accountResult', handler)
  },
  onCkptDone: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('fbckpt:done', handler)
    return () => ipcRenderer.removeListener('fbckpt:done', handler)
  },

  onRegLog: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('reg:log', handler)
    return () => ipcRenderer.removeListener('reg:log', handler)
  },
  exportRegV2: (rows) => ipcRenderer.invoke('regv2:export', rows),
  saveImportedCookies: (entries) => ipcRenderer.invoke('imported:save', entries),
  getImportedCookies: () => ipcRenderer.invoke('imported:get'),
  onRegV2Log: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('regv2:log', handler)
    return () => ipcRenderer.removeListener('regv2:log', handler)
  },
  onRegV2AccountResult: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('regv2:accountResult', handler)
    return () => ipcRenderer.removeListener('regv2:accountResult', handler)
  },
  onRegV2Done: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('regv2:done', handler)
    return () => ipcRenderer.removeListener('regv2:done', handler)
  },
  onRegAccountResult: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('reg:accountResult', handler)
    return () => ipcRenderer.removeListener('reg:accountResult', handler)
  },
  onRegDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('reg:done', handler)
    return () => ipcRenderer.removeListener('reg:done', handler)
  },

  // ── Account BM ──
  startBM: (opts) => ipcRenderer.invoke('bm:start', opts),
  stopBM:  ()     => ipcRenderer.invoke('bm:stop'),
  bmAccStart: (opts) => ipcRenderer.invoke('bmacc:start', opts),
  exportBMResults: (results) => ipcRenderer.invoke('bm:exportResults', results),

  // ── Reg TikTok ──
  startTikTok: (opts) => ipcRenderer.invoke('tiktok:start', opts),
  stopTikTok:  ()     => ipcRenderer.invoke('tiktok:stop'),
  exportTikTokResults: (results) => ipcRenderer.invoke('tiktok:export', results),
  onTikTokResult: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('tiktok:result', handler)
    return () => ipcRenderer.removeListener('tiktok:result', handler)
  },
  onTikTokRunning: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('tiktok:running', handler)
    return () => ipcRenderer.removeListener('tiktok:running', handler)
  },
  onTikTokDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('tiktok:done', handler)
    return () => ipcRenderer.removeListener('tiktok:done', handler)
  },
  onTikTokLog: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('tiktok:log', handler)
    return () => ipcRenderer.removeListener('tiktok:log', handler)
  },

  // ── Invite link BM ──
  scanBM: (opts) => ipcRenderer.invoke('bm:scan', opts),
  onBMScanResult: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('bm:scanResult', handler)
    return () => ipcRenderer.removeListener('bm:scanResult', handler)
  },
  onBMScanDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('bm:scanDone', handler)
    return () => ipcRenderer.removeListener('bm:scanDone', handler)
  },
  startBMInvite: (opts) => ipcRenderer.invoke('bminvite:start', opts),
  exportInviteResults: (results) => ipcRenderer.invoke('bminvite:export', results),
  onInviteResult: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('bminvite:result', handler)
    return () => ipcRenderer.removeListener('bminvite:result', handler)
  },
  onInviteDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('bminvite:done', handler)
    return () => ipcRenderer.removeListener('bminvite:done', handler)
  },

  onBMLog: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('bm:log', handler)
    return () => ipcRenderer.removeListener('bm:log', handler)
  },
  onBMResult: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('bm:result', handler)
    return () => ipcRenderer.removeListener('bm:result', handler)
  },
  onBMDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('bm:done', handler)
    return () => ipcRenderer.removeListener('bm:done', handler)
  },
  onBMRunning: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('bm:running', handler)
    return () => ipcRenderer.removeListener('bm:running', handler)
  },

  // ── Nuôi FB ──
  startNuoi: (opts) => ipcRenderer.invoke('fbnuoi:start', opts),
  stopNuoi:  ()     => ipcRenderer.invoke('fbnuoi:stop'),
  exportNuoiResults: (rows) => ipcRenderer.invoke('fbnuoi:export', rows),
  getNuoiQueue: () => ipcRenderer.invoke('fbnuoi:queueGet'),
  onRegV2Sedding: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('regv2:sedding', handler)
    return () => ipcRenderer.removeListener('regv2:sedding', handler)
  },
  removeNuoiQueueItem: (uid) => ipcRenderer.invoke('fbnuoi:queueRemove', uid),
  clearNuoiQueue: (filterStatus) => ipcRenderer.invoke('fbnuoi:queueClear', filterStatus),
  startNuoiQueue: () => ipcRenderer.invoke('fbnuoi:queueStart'),
  onNuoiQueue: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('fbnuoi:queue', handler)
    return () => ipcRenderer.removeListener('fbnuoi:queue', handler)
  },
  onNuoiLog: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('fbnuoi:log', handler)
    return () => ipcRenderer.removeListener('fbnuoi:log', handler)
  },
  onNuoiResult: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('fbnuoi:result', handler)
    return () => ipcRenderer.removeListener('fbnuoi:result', handler)
  },
  onNuoiDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('fbnuoi:done', handler)
    return () => ipcRenderer.removeListener('fbnuoi:done', handler)
  },

  // ── Authentication (nạp cookie -> đổi thông tin) ──
  startAuth: (opts) => ipcRenderer.invoke('auth:start', opts),
  stopAuth:  ()     => ipcRenderer.invoke('auth:stop'),
  exportAuthResults: (rows) => ipcRenderer.invoke('auth:export', rows),

  // ── Temp Mail: đọc hòm thư temp lấy OTP ──
  tempmailFetch: (args) => ipcRenderer.invoke('tempmail:fetch', args),

  // ── REG PAGE: tạo Page từ cookie ──
  startPage: (opts) => ipcRenderer.invoke('page:start', opts),
  stopPage: () => ipcRenderer.invoke('page:stop'),
  pickNamesFile: () => ipcRenderer.invoke('page:pickNamesFile'),
  onPageLog: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('page:log', handler)
    return () => ipcRenderer.removeListener('page:log', handler)
  },
  onPageResult: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('page:result', handler)
    return () => ipcRenderer.removeListener('page:result', handler)
  },
  onPageDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('page:done', handler)
    return () => ipcRenderer.removeListener('page:done', handler)
  },
  onAuthLog: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('auth:log', handler)
    return () => ipcRenderer.removeListener('auth:log', handler)
  },
  onAuthResult: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('auth:result', handler)
    return () => ipcRenderer.removeListener('auth:result', handler)
  },
  onAuthDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('auth:done', handler)
    return () => ipcRenderer.removeListener('auth:done', handler)
  },

  // Window controls
  minimize: () => ipcRenderer.send('win:min'),
  maximize: () => ipcRenderer.send('win:max'),
  close:    () => ipcRenderer.send('win:close'),
})
