const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  system: {
    detect: () => ipcRenderer.invoke('system:detect'),
  },
  deploy: {
    start: (config) => ipcRenderer.invoke('deploy:start', config),
    execute: (config) => ipcRenderer.send('deploy:execute', config),
    cancel: () => ipcRenderer.invoke('deploy:cancel'),
    preflight: (config) => ipcRenderer.invoke('deploy:preflight', config),
    onProgress: (cb) => ipcRenderer.on('deploy:progress', (_e, data) => cb(data)),
    onLog: (cb) => ipcRenderer.on('deploy:log', (_e, data) => cb(data)),
    onError: (cb) => ipcRenderer.on('deploy:error', (_e, data) => cb(data)),
    onComplete: (cb) => ipcRenderer.on('deploy:complete', (_e, data) => cb(data)),
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('deploy:progress')
      ipcRenderer.removeAllListeners('deploy:log')
      ipcRenderer.removeAllListeners('deploy:error')
      ipcRenderer.removeAllListeners('deploy:complete')
    },
  },
  manage: {
    status: (config) => ipcRenderer.invoke('manage:status', config),
    restart: (config) => ipcRenderer.invoke('manage:restart', config),
    stop: (config) => ipcRenderer.invoke('manage:stop', config),
    update: (config) => ipcRenderer.invoke('manage:update', config),
    uninstall: (config) => ipcRenderer.invoke('manage:uninstall', config),
    exportConfig: () => ipcRenderer.invoke('manage:exportConfig'),
    exportLogs: () => ipcRenderer.invoke('manage:exportLogs'),
    approveDevices: (config) => ipcRenderer.invoke('manage:approveDevices', config),
  },
  plugins: {
    list: (config) => ipcRenderer.invoke('plugins:list', config),
    install: (config, name) => ipcRenderer.invoke('plugins:install', config, name),
    uninstall: (config, name) => ipcRenderer.invoke('plugins:uninstall', config, name),
    setClawhubAllowed: (config) => ipcRenderer.invoke('plugins:setClawhubAllowed', config),
  },
  clawhub: {
    install: (config, skillName) => ipcRenderer.invoke('clawhub:install', config, skillName),
  },
  config: {
    save: (config) => ipcRenderer.invoke('config:save', config),
    load: () => ipcRenderer.invoke('config:load'),
  },
  deployState: {
    save: (state) => ipcRenderer.invoke('deployState:save', state),
    load: () => ipcRenderer.invoke('deployState:load'),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
})
