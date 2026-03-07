const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const net = require('net')

// 数据目录
const DATA_DIR = path.join(os.homedir(), '.openclaw-deployer')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const CONFIG_FILE = path.join(DATA_DIR, 'gui-config.json')

let mainWindow

function getScriptsDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'scripts')
  return path.join(__dirname, 'scripts')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 580,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'OpenClaw 部署工具',
    backgroundColor: '#0a0e1a',
    show: false
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.setMenuBarVisibility(false)
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

// ============================================================
// 系统检测
// ============================================================
ipcMain.handle('system:detect', async () => {
  const info = {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    totalMemoryGB: Math.round(os.totalmem() / (1024 ** 3) * 10) / 10,
    freeMemoryGB: Math.round(os.freemem() / (1024 ** 3) * 10) / 10,
    cpuCores: os.cpus().length,
    nodeVersion: process.versions.node,
    hasNode: false,
    nodeSystemVersion: null,
    diskFreeGB: null,
    port18789InUse: false,
  }
  try {
    const v = execSync('node --version', { encoding: 'utf8', timeout: 5000 }).trim()
    info.hasNode = true; info.nodeSystemVersion = v
  } catch {}
  try {
    if (process.platform === 'win32') {
      const w = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /format:value', { encoding: 'utf8', timeout: 5000 })
      const m = w.match(/FreeSpace=(\d+)/); if (m) info.diskFreeGB = Math.round(parseInt(m[1]) / (1024 ** 3))
    } else if (process.platform === 'darwin') {
      info.diskFreeGB = parseInt(execSync("df -g / | tail -1 | awk '{print $4}'", { encoding: 'utf8', timeout: 5000 }), 10)
    } else {
      info.diskFreeGB = parseInt(execSync("df -BG / | tail -1 | awk '{print $4}'", { encoding: 'utf8', timeout: 5000 }).replace('G', ''), 10)
    }
  } catch {}
  try {
    if (process.platform !== 'win32') execSync('lsof -i :18789 -sTCP:LISTEN', { encoding: 'utf8', timeout: 3000 })
    else execSync('netstat -an | findstr ":18789"', { encoding: 'utf8', timeout: 3000 })
    info.port18789InUse = true
  } catch {}
  return info
})

// ============================================================
// 运维管理
// ============================================================
ipcMain.handle('ops:status', async () => {
  const isRunning = await new Promise((resolve) => {
    const s = new net.Socket()
    s.setTimeout(2000)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.on('timeout', () => { s.destroy(); resolve(false) })
    s.connect(18789, '127.0.0.1')
  })
  return { running: isRunning }
})

ipcMain.handle('ops:stop', async () => {
  try {
    if (process.platform === 'win32') {
      execSync('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :18789\') do taskkill /F /PID %a', { shell: true, timeout: 10000 })
    } else {
      execSync("lsof -ti :18789 | xargs kill -9 2>/dev/null; true", { shell: true, timeout: 10000 })
    }
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('ops:restart', async () => {
  try {
    if (process.platform === 'win32') {
      try { execSync('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :18789\') do taskkill /F /PID %a', { shell: true, timeout: 10000 }) } catch {}
    } else {
      try { execSync("lsof -ti :18789 | xargs kill -9 2>/dev/null; true", { shell: true, timeout: 10000 }) } catch {}
    }
    await new Promise(r => setTimeout(r, 1200))
    const opts = { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }
    spawn('openclaw', ['gateway', '--port', '18789'], opts).unref()
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('ops:getLogs', async () => {
  try {
    const logDir = path.join(os.homedir(), '.openclaw', 'logs')
    if (!fs.existsSync(logDir)) return { logs: '暂无日志文件' }
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse()
    if (!files.length) return { logs: '暂无日志文件' }
    const content = fs.readFileSync(path.join(logDir, files[0]), 'utf8')
    return { logs: content.split('\n').slice(-120).join('\n') }
  } catch (e) { return { logs: `读取日志失败: ${e.message}` } }
})

ipcMain.handle('ops:uninstall', async () => {
  try {
    if (process.platform === 'win32') {
      try { execSync('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :18789\') do taskkill /F /PID %a', { shell: true, timeout: 10000 }) } catch {}
    } else {
      try { execSync("lsof -ti :18789 | xargs kill -9 2>/dev/null; true", { shell: true, timeout: 10000 }) } catch {}
    }
    execSync('npm uninstall -g openclaw @qingchencloud/openclaw-zh', { encoding: 'utf8', timeout: 60000 })
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

// ============================================================
// 配置持久化
// ============================================================
ipcMain.handle('config:save', async (_, config) => {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8'); return { success: true } }
  catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('config:load', async () => {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { config: null }
    return { config: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  } catch { return { config: null } }
})

// ============================================================
// 部署
// ============================================================
ipcMain.on('start-deploy', (event, opts) => {
  const { apiKey, testMode, modelProvider, apiBase, modelName, feishu } = opts
  const platform = os.platform()
  const scriptsDir = getScriptsDir()
  const stripAnsi = (s) => s.replace(/\x1B\[[0-9;]*m/g, '')

  const env = {
    ...process.env,
    GUI_MODE: '1',
    KIMI_API_KEY: apiKey,
    MODEL_API_KEY: apiKey,
    MODEL_PROVIDER: modelProvider || 'moonshot',
    MODEL_API_BASE: apiBase || 'https://api.moonshot.cn/v1',
    MODEL_NAME: modelName || 'kimi-k2-5',
    TEST_MODE: testMode ? 'true' : 'false',
    ...(feishu ? { FEISHU_APP_ID: feishu.appId || '', FEISHU_APP_SECRET: feishu.appSecret || '' } : {})
  }

  let proc
  if (platform === 'darwin') {
    proc = spawn('bash', [path.join(scriptsDir, 'deploy_macos.command')], { env, shell: false })
  } else if (platform === 'win32') {
    proc = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsDir, 'deploy_windows.ps1')], { env, shell: false })
  } else {
    event.sender.send('log', '[错误] 不支持的操作系统'); event.sender.send('deploy-error', '不支持的操作系统'); return
  }

  proc.stdout.on('data', (data) => {
    stripAnsi(data.toString()).split('\n').forEach(line => {
      if (!line.trim()) return
      if (line.startsWith('DEPLOY_DONE:')) {
        const port = (line.match(/port=(\d+)/) || [])[1] || '18789'
        const token = (line.match(/token=([a-f0-9]+)/) || [])[1] || ''
        event.sender.send('deploy-done', { port, token })
      } else { event.sender.send('log', line) }
    })
  })
  proc.stderr.on('data', (data) => {
    stripAnsi(data.toString()).split('\n').forEach(line => { if (line.trim()) event.sender.send('log', line) })
  })
  proc.on('close', (code) => { if (code !== 0) event.sender.send('deploy-error', `脚本退出码: ${code}`) })
  proc.on('error', (err) => event.sender.send('deploy-error', err.message))
})

ipcMain.on('open-url', (_, url) => shell.openExternal(url))
