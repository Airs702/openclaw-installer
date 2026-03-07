const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 部署
  startDeploy: (opts) => ipcRenderer.send('start-deploy', opts),
  onLog: (cb) => ipcRenderer.on('log', (_, msg) => cb(msg)),
  onDone: (cb) => ipcRenderer.on('deploy-done', (_, info) => cb(info)),
  onError: (cb) => ipcRenderer.on('deploy-error', (_, msg) => cb(msg)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),

  // 系统检测
  detectSystem: () => ipcRenderer.invoke('system:detect'),

  // 运维管理
  opsStatus: () => ipcRenderer.invoke('ops:status'),
  opsStop: () => ipcRenderer.invoke('ops:stop'),
  opsRestart: () => ipcRenderer.invoke('ops:restart'),
  opsGetLogs: () => ipcRenderer.invoke('ops:getLogs'),
  opsUninstall: () => ipcRenderer.invoke('ops:uninstall'),

  // 配置持久化
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  loadConfig: () => ipcRenderer.invoke('config:load'),

  // 打开外部链接
  openUrl: (url) => ipcRenderer.send('open-url', url)
})
