const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('authBridge', {
  verify:         (pwd)    => ipcRenderer.invoke('auth:verify', pwd),
  verifyMaster:   (pwd)    => ipcRenderer.invoke('auth:verifyMaster', pwd),
  changePassword: (newPwd) => ipcRenderer.invoke('auth:changePassword', newPwd),
  unlock:         ()       => ipcRenderer.send('auth:unlock'),
})
