const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const os = require('os')

let mainWindow

// 打包后 scripts 在 resources/scripts，开发时在 __dirname/scripts
function getScriptsDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scripts')
  }
  return path.join(__dirname, 'scripts')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 560,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'OpenClaw 安装器'
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

// ============================================================
// 部署逻辑
// ============================================================
ipcMain.on('start-deploy', (event, { apiKey, testMode }) => {
  const platform = os.platform()
  const scriptsDir = getScriptsDir()

  let proc
  const env = {
    ...process.env,
    GUI_MODE: '1',
    KIMI_API_KEY: apiKey,
    TEST_MODE: testMode ? 'true' : 'false'
  }

  if (platform === 'darwin') {
    const scriptPath = path.join(scriptsDir, 'deploy_macos.command')
    proc = spawn('bash', [scriptPath], { env, shell: false })
  } else if (platform === 'win32') {
    const scriptPath = path.join(scriptsDir, 'deploy_windows.ps1')
    proc = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath
    ], { env, shell: false })
  } else {
    event.sender.send('log', '[错误] 不支持的操作系统')
    event.sender.send('deploy-error', '不支持的操作系统')
    return
  }

  // 去除 ANSI 颜色码
  const stripAnsi = (str) => str.replace(/\x1B\[[0-9;]*m/g, '')

  proc.stdout.on('data', (data) => {
    const lines = stripAnsi(data.toString()).split('\n')
    lines.forEach(line => {
      if (!line.trim()) return
      // 检测完成信号
      if (line.startsWith('DEPLOY_DONE:')) {
        const portMatch = line.match(/port=(\d+)/)
        const tokenMatch = line.match(/token=([a-f0-9]+)/)
        const port = portMatch ? portMatch[1] : '18789'
        const token = tokenMatch ? tokenMatch[1] : ''
        event.sender.send('deploy-done', { port, token })
      } else {
        event.sender.send('log', line)
      }
    })
  })

  proc.stderr.on('data', (data) => {
    const lines = stripAnsi(data.toString()).split('\n')
    lines.forEach(line => {
      if (line.trim()) event.sender.send('log', line)
    })
  })

  proc.on('close', (code) => {
    if (code !== 0) {
      event.sender.send('deploy-error', `脚本退出码: ${code}`)
    }
  })

  proc.on('error', (err) => {
    event.sender.send('deploy-error', err.message)
  })
})

ipcMain.on('open-url', (_, url) => {
  const { shell } = require('electron')
  shell.openExternal(url)
})
