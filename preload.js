const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  startDeploy: (opts) => ipcRenderer.send('start-deploy', opts),
  onLog: (cb) => ipcRenderer.on('log', (_, msg) => cb(msg)),
  onDone: (cb) => ipcRenderer.on('deploy-done', (_, info) => cb(info)),
  onError: (cb) => ipcRenderer.on('deploy-error', (_, msg) => cb(msg)),
  openUrl: (url) => ipcRenderer.send('open-url', url)
})
