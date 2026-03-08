const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const { spawn, exec } = require('child_process')
const fs = require('fs')
const os = require('os')
const net = require('net')
const crypto = require('crypto')

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
}

const DATA_DIR = path.join(os.homedir(), '.openclaw-deployer')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    title: 'OpenClaw 一键部署器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0a0e1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.setMenuBarVisibility(false)
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (deviceApproveInterval) clearInterval(deviceApproveInterval)
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
app.on('before-quit', () => {
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(
        `wmic process where "ParentProcessId=${process.pid}" call terminate`,
        { timeout: 3000 }
      )
    }
  } catch {}
})

// ============================================================
// 系统检测
// ============================================================
ipcMain.handle('system:detect', async () => {
  const info = {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    totalMemory: Math.round(os.totalmem() / (1024 ** 3) * 10) / 10,
    freeMemory: Math.round(os.freemem() / (1024 ** 3) * 10) / 10,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    cpuCores: os.cpus().length,
    nodeVersion: process.versions.node,
    hasDocker: false,
    hasDockerCompose: false,
    hasNode: false,
    nodeSystemVersion: null,
    diskFreeGB: null,
    port18789InUse: false,
  }
  try { require('child_process').execSync('docker --version', { encoding: 'utf8', timeout: 5000 }); info.hasDocker = true } catch {}
  try { require('child_process').execSync('docker compose version', { encoding: 'utf8', timeout: 5000 }); info.hasDockerCompose = true } catch {
    try { require('child_process').execSync('docker-compose --version', { encoding: 'utf8', timeout: 5000 }); info.hasDockerCompose = true } catch {}
  }
  try { const v = require('child_process').execSync('node --version', { encoding: 'utf8', timeout: 5000 }).trim(); info.hasNode = true; info.nodeSystemVersion = v } catch {}
  try {
    if (process.platform === 'win32') {
      const w = require('child_process').execSync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /format:value', { encoding: 'utf8', timeout: 5000 })
      const m = w.match(/FreeSpace=(\d+)/); if (m) info.diskFreeGB = Math.round(parseInt(m[1]) / (1024 ** 3))
    } else if (process.platform === 'darwin') {
      info.diskFreeGB = parseInt(require('child_process').execSync("df -g / | tail -1 | awk '{print $4}'", { encoding: 'utf8', timeout: 5000 }), 10)
    } else {
      info.diskFreeGB = parseInt(require('child_process').execSync("df -BG / | tail -1 | awk '{print $4}'", { encoding: 'utf8', timeout: 5000 }).replace('G', ''), 10)
    }
  } catch {}
  try {
    if (process.platform === 'win32') {
      const out = require('child_process').execSync('netstat -an | findstr ":18789"', { encoding: 'utf8', timeout: 5000 })
      if (out.includes('LISTENING')) info.port18789InUse = true
    } else if (process.platform === 'darwin') {
      require('child_process').execSync('lsof -i :18789 -sTCP:LISTEN', { encoding: 'utf8', timeout: 5000 }); info.port18789InUse = true
    } else {
      require('child_process').execSync('ss -tlnp | grep 18789', { encoding: 'utf8', timeout: 5000 }); info.port18789InUse = true
    }
  } catch {}
  return info
})

// ============================================================
// 部署前预检
// ============================================================
ipcMain.handle('deploy:preflight', async (_event, config) => {
  const issues = []
  try {
    if (process.platform === 'win32') {
      const w = await execPromise('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /format:value', 5000)
      const m = w.match(/FreeSpace=(\d+)/); if (m) { const gb = parseInt(m[1]) / (1024 ** 3); if (gb < 2) issues.push(`磁盘空间不足：仅剩 ${gb.toFixed(1)} GB`) }
    } else {
      const df = await execPromise("df -BG / | tail -1 | awk '{print $4}'", 5000)
      const gb = parseInt(df.replace('G', ''), 10); if (gb < 2) issues.push(`磁盘空间不足：仅剩 ${gb} GB`)
    }
  } catch {}
  if (config.target === 'local') {
    try {
      await new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', (e) => { if (e.code === 'EADDRINUSE') reject(e); else resolve() })
        server.once('listening', () => { server.close(); resolve() })
        server.listen(18789, '0.0.0.0')
      })
    } catch { issues.push('端口 18789 已被占用，请先停止旧的 OpenClaw 实例') }
  }
  try { await httpHead('https://docker.1panel.live/v2/', 5000) } catch {
    try { await httpHead('https://hub.rat.dev/v2/', 5000) } catch {
      issues.push('无法连接到 Docker 镜像源，请检查网络或配置代理')
    }
  }
  const hasAnyKey = (config.llms || []).some(m => m.apiKey && String(m.apiKey).trim())
  const hasProvider = (config.llms || []).some(m => m.provider)
  if (hasProvider && !hasAnyKey) issues.push('请至少配置一个有效的模型 API Key')

  // 检测旧版 openclaw 残留（仅 nodejs 模式）
  const warnings = []
  if (config.mode === 'nodejs' && config.target === 'local') {
    let hasOldClaw = false
    try { await execPromise('openclaw --version', 5000); hasOldClaw = true } catch {}
    if (!hasOldClaw) {
      // Windows: 检查 openclaw.cmd
      if (process.platform === 'win32') {
        try {
          const npmBin = (await execPromise('npm bin -g', 5000)).trim()
          const cmdPath = path.join(npmBin, 'openclaw.cmd')
          if (fs.existsSync(cmdPath)) hasOldClaw = true
        } catch {}
      }
    }
    if (hasOldClaw) warnings.push({ code: 'OLD_OPENCLAW', message: '检测到已安装的旧版 OpenClaw，继续安装可能导致版本冲突。建议先卸载旧版再继续。' })

    // 检测 GitHub 443 连通性（仅在没有离线包时才需要）
    const bundledName = config.imageChoice === 'official' ? 'bundled-official' : 'bundled-zh'
    const bundledBin = path.join(process.resourcesPath || path.join(__dirname, '..', 'resources'), bundledName, 'node_modules', '.bin', process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw')
    const hasBundled = fs.existsSync(bundledBin)
    if (!hasBundled) {
      const githubOk = await new Promise(resolve => {
        const s = new net.Socket(); s.setTimeout(5000)
        s.on('connect', () => { s.destroy(); resolve(true) })
        s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false) })
        s.connect(443, 'github.com')
      })
      if (!githubOk) {
        issues.push('当前网络无法访问 GitHub（github.com:443 不可达）。OpenClaw 的部分依赖来自 GitHub Git 仓库，必须能访问 GitHub 才能安装。请检查代理/VPN 后重试。')
      }
    }
  }

  return { ok: issues.length === 0, issues, warnings: warnings || [] }
})

// ============================================================
// 部署执行
// ============================================================
let deployCancelled = false
let deployInProgress = false
let activeChildProcess = null
let needsSudoDocker = false
let useWslDocker = false
let wslDistroName = ''
let deviceApproveInterval = null

const DOCKER_IMAGE_OFFICIAL = 'alpine/openclaw:latest'
const DOCKER_IMAGE_ZH = '1186258278/openclaw-zh:latest'
const DOCKER_IMAGE_CN_IM = 'justlikemaki/openclaw-docker-cn-im:latest'

function getDockerImage(config) {
  const choice = config?.imageChoice || 'hanhua'
  if (choice === 'official') return DOCKER_IMAGE_OFFICIAL
  if (choice === 'cn-im') return DOCKER_IMAGE_CN_IM
  return DOCKER_IMAGE_ZH
}

function getNodePackage(imageChoice) {
  if (imageChoice === 'official') return 'openclaw@latest'
  return '@qingchencloud/openclaw-zh@latest'
}

function getContainerDataDir(config) {
  const choice = config?.imageChoice
  if (choice === 'official' || choice === 'cn-im') return '/home/node/.openclaw'
  return '/root/.openclaw'
}

ipcMain.handle('deploy:start', async () => ({ started: true }))
ipcMain.handle('deploy:cancel', async () => {
  deployCancelled = true; deployInProgress = false
  if (activeChildProcess) { try { activeChildProcess.kill('SIGTERM') } catch {}; activeChildProcess = null }
  return { cancelled: true }
})

ipcMain.on('deploy:execute', (event, config) => {
  if (deployInProgress) {
    event.sender.send('deploy:error', { step: 'mutex', error: '部署正在进行中', diagnosis: '请等待当前部署完成或取消后再试。' })
    return
  }
  deployInProgress = true
  deployCancelled = false; needsSudoDocker = false; useWslDocker = false; wslDistroName = ''

  const logFile = path.join(DATA_DIR, `deploy-${new Date().toISOString().slice(0, 10)}.log`)
  const logStream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' })
  let logStreamClosed = false
  logStream.write(`\n${'='.repeat(60)}\n[${new Date().toISOString()}] 部署开始 mode=${config.mode} target=${config.target}\n${'='.repeat(60)}\n`)

  const safeCloseLog = () => {
    if (!logStreamClosed) { logStreamClosed = true; logStream.write(`[${new Date().toLocaleTimeString('zh-CN')}] === 部署结束 ===\n`); logStream.end() }
  }

  const origSend = event.sender.send.bind(event.sender)
  event.sender.send = (channel, ...args) => {
    if (channel === 'deploy:log' || channel === 'deploy:error') {
      const ts = new Date().toLocaleTimeString('zh-CN')
      const msg = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0])
      if (!logStreamClosed) logStream.write(`[${ts}] ${msg}\n`)
    }
    if (channel === 'deploy:complete' || channel === 'deploy:error') { safeCloseLog(); deployInProgress = false }
    origSend(channel, ...args)
  }

  const steps = buildDeploySteps(config)
  executeSteps(event, steps, config).catch(err => {
    safeCloseLog(); deployInProgress = false
    try { event.sender.send('deploy:error', { step: 'unexpected', error: err.message || '未知错误', diagnosis: '部署引擎发生未预期异常，请重试。' }) } catch {}
  })
})

// ============================================================
// 构建部署步骤
// ============================================================
function buildDeploySteps(config) {
  const steps = []
  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'

  if (config.target === 'local') {
    if (config.mode === 'docker') {
      steps.push(
        { id: 'check_docker', label: '检测并配置 Docker 环境', action: 'ensureDockerLocal' },
        { id: 'config_mirror', label: '配置国内镜像源', action: 'configDockerMirror' },
        { id: 'pull_image', label: getPullLabel(config), action: 'pullDockerImageLocal' },
        { id: 'stop_old', label: '停止旧容器（如果有）', cmd: `docker rm -f openclaw 2>${nullDev} || echo ok` },
        { id: 'run_container', label: '启动 OpenClaw 容器', action: 'runDockerContainer' },
      )
      if (config.imageChoice === 'cn-im') steps.push({ id: 'doctor_fix', label: '修复中国 IM 镜像配置', action: 'doctorFixDocker' })
      steps.push(
        { id: 'wait_init', label: '等待容器初始化', action: 'waitForReady' },
        { id: 'onboard', label: '自动配置网关 + 模型', action: 'onboardDocker' },
        { id: 'wait_onboard', label: '等待网关配置生效', action: 'waitForReady' },
        { id: 'config_ui', label: '配置控制台访问', action: 'configGatewayDocker' },
        { id: 'restart', label: '重启应用新配置', cmd: 'docker restart openclaw' },
        { id: 'wait_ready', label: '等待服务就绪', action: 'waitForReady' },
        { id: 'approve_device', label: '自动批准设备', action: 'approveDeviceDocker' },
      )
    } else {
      steps.push(
        { id: 'check_node', label: '检测并配置 Node.js 环境', action: 'ensureNodeLocal' },
        { id: 'install_openclaw', label: '安装 OpenClaw（离线包）', action: 'installOpenclawNode' },
        { id: 'start_gateway', label: '启动网关服务', action: 'startGatewayLocal' },
        { id: 'wait_init', label: '等待网关初始化', action: 'waitForReady' },
        { id: 'onboard', label: '自动配置网关 + 模型', action: 'onboardLocal' },
        { id: 'wait_ready', label: '等待服务就绪', action: 'waitForReady' },
      )
    }
  }

  if (config.target === 'ssh') {
    if (config.mode === 'docker') {
      steps.push(
        { id: 'ssh_connect', label: '连接远程服务器', action: 'sshConnect' },
        { id: 'ssh_check_docker', label: '检测并配置远程 Docker', action: 'ensureDockerSsh' },
        { id: 'ssh_config_mirror', label: '配置远程镜像源', action: 'sshConfigDockerMirror' },
        { id: 'ssh_pull', label: getPullLabel(config) + '（远程）', action: 'pullDockerImageSsh' },
        { id: 'ssh_stop_old', label: '停止旧容器', sshCmd: 'docker rm -f openclaw 2>/dev/null; echo ok' },
        { id: 'ssh_run', label: '启动 OpenClaw 容器', action: 'sshRunDockerContainer' },
      )
      if (config.imageChoice === 'cn-im') steps.push({ id: 'ssh_doctor_fix', label: '修复中国 IM 镜像配置（远程）', action: 'sshDoctorFixDocker' })
      steps.push(
        { id: 'ssh_wait_init', label: '等待容器初始化', action: 'sshWaitForReady' },
        { id: 'ssh_onboard', label: '自动配置远程网关', action: 'sshOnboardDocker' },
        { id: 'ssh_wait', label: '等待服务就绪', action: 'sshWaitForReady' },
      )
    } else {
      steps.push(
        { id: 'ssh_connect', label: '连接远程服务器', action: 'sshConnect' },
        { id: 'ssh_install_node', label: '安装 Node.js 22', sshCmd: 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm install 22' },
        { id: 'ssh_npm_mirror', label: '配置 npm 镜像', sshCmd: 'npm config set registry https://registry.npmmirror.com' },
        { id: 'ssh_install', label: '安装 OpenClaw（远程）', sshCmd: `npm install -g ${getNodePackage(config.imageChoice)}` },
        { id: 'ssh_start', label: '启动网关', sshCmd: 'openclaw gateway --allow-unconfigured --bind lan --port 18789 &' },
        { id: 'ssh_wait', label: '等待服务就绪', action: 'sshWaitForReady' },
        { id: 'ssh_onboard_local', label: '自动配置远程网关 + 模型', action: 'sshOnboardLocal' },
      )
    }
  }

  if (config.feishu) {
    if (config.target === 'local') {
      if (config.mode === 'docker') {
        steps.push({ id: 'feishu_config', label: '配置飞书通道', action: 'configFeishuDocker' }, { id: 'feishu_restart', label: '重启应用飞书通道', cmd: 'docker restart openclaw' })
      } else {
        steps.push({ id: 'feishu_install', label: '安装飞书插件', cmd: 'openclaw plugins install @openclaw/feishu' }, { id: 'feishu_config', label: '配置飞书通道', action: 'configFeishuLocal' }, { id: 'feishu_restart', label: '重启网关服务', cmd: 'openclaw gateway restart' })
      }
    } else {
      if (config.mode === 'docker') {
        steps.push({ id: 'ssh_feishu_config', label: '配置远程飞书通道', action: 'sshConfigFeishuDocker' }, { id: 'ssh_feishu_restart', label: '重启远程应用', sshCmd: 'docker restart openclaw' })
      } else {
        steps.push({ id: 'ssh_feishu_install', label: '安装飞书插件', sshCmd: 'openclaw plugins install @openclaw/feishu' }, { id: 'ssh_feishu_config', label: '配置飞书通道', action: 'sshConfigFeishuLocal' }, { id: 'ssh_feishu_restart', label: '重启网关服务', sshCmd: 'openclaw gateway restart' })
      }
    }
  }

  return steps
}

function getPullLabel(config) {
  const choice = config?.imageChoice || 'hanhua'
  if (choice === 'official') return '拉取 OpenClaw 官方镜像'
  if (choice === 'cn-im') return '拉取 OpenClaw 中国 IM 整合版镜像'
  return '拉取 OpenClaw 汉化版镜像'
}

// ============================================================
// 执行步骤
// ============================================================
async function executeSteps(event, steps, config) {
  let sshConn = null
  const env = {}
  if (config.proxy) { env.HTTP_PROXY = config.proxy; env.HTTPS_PROXY = config.proxy; env.ALL_PROXY = config.proxy }

  for (let i = 0; i < steps.length; i++) {
    if (deployCancelled) {
      event.sender.send('deploy:log', '⚠ 部署已被用户取消')
      event.sender.send('deploy:error', { step: 'cancelled', error: '部署已取消', diagnosis: '您可以随时重新开始部署。' })
      if (sshConn) sshConn.end()
      return
    }
    const step = steps[i]
    const progress = Math.round((i / steps.length) * 100)
    event.sender.send('deploy:progress', { step: step.id, label: step.label, progress, status: 'running' })

    try {
      if (step.action === 'sshConnect') {
        sshConn = await sshConnect(config.ssh)
        event.sender.send('deploy:log', `✓ 已连接到 ${config.ssh.host}`)
      } else if (step.action === 'ensureDockerLocal') {
        await ensureDockerLocal(event, env)
      } else if (step.action === 'ensureNodeLocal') {
        await ensureNodeLocal(event, env)
      } else if (step.action === 'ensureGitLocal') {
        await ensureGitLocal(event, env)
      } else if (step.action === 'configDockerMirror') {
        await configDockerMirror(event, env)
        event.sender.send('deploy:log', '✓ Docker 镜像源已配置')
      } else if (step.action === 'pullDockerImageLocal') {
        await pullImageWithMirrorFallback(getDockerImage(config), event, env)
        event.sender.send('deploy:log', '✓ 镜像拉取完成')
      } else if (step.action === 'runDockerContainer') {
        await execPromise(buildDockerRunCmd(config), 300000, env)
        event.sender.send('deploy:log', '✓ OpenClaw 容器已启动')
        if (config.imageChoice !== 'cn-im') {
          await new Promise(r => setTimeout(r, 5000))
          for (const cfg of ['gateway.bind lan', 'gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true']) {
            try { await execPromise(dockerCmd(`docker exec openclaw openclaw config set ${cfg}`), 10000) } catch {}
          }
          try { await execPromise(dockerCmd('docker restart openclaw'), 30000); await new Promise(r => setTimeout(r, 5000)) } catch {}
        }
      } else if (step.action === 'doctorFixDocker') {
        try { await execPromise(dockerCmd('docker exec openclaw openclaw config set gateway.mode local'), 10000) } catch {}
        try { await execPromise(dockerCmd('docker exec openclaw openclaw doctor --fix'), 30000) } catch {}
        event.sender.send('deploy:log', '✓ 中国 IM 配置修复完成')
      } else if (step.action === 'waitForReady') {
        await waitForPort(18789, config.target === 'ssh' ? config.ssh.host : '127.0.0.1')
        event.sender.send('deploy:log', '✓ 服务已就绪')
      } else if (step.action === 'onboardDocker') {
        await runOnboard(config, event, env, 'docker')
      } else if (step.action === 'onboardLocal') {
        await runOnboard(config, event, env, 'local')
      } else if (step.action === 'configGatewayDocker') {
        await configGatewayDocker(config, event, env)
      } else if (step.action === 'approveDeviceDocker') {
        try {
          await execPromise(dockerCmd('docker exec openclaw openclaw devices approve --latest 2>/dev/null || echo ok'), 10000)
          event.sender.send('deploy:log', '✓ 设备自动批准完成')
        } catch { event.sender.send('deploy:log', '⚠ 设备批准可能需要手动操作') }
      } else if (step.action === 'installOpenclawNode') {
        await installOpenclawNode(config, event, env)
      } else if (step.action === 'startGatewayLocal') {
        startNodeLocalGateway(env)
        event.sender.send('deploy:log', '✓ 网关已启动')
      } else if (step.action === 'ensureDockerSsh') {
        if (sshConn) await ensureDockerSsh(sshConn, event, env)
      } else if (step.action === 'sshConfigDockerMirror') {
        if (sshConn) {
          const mirrors = await getFastestMirror(env)
          await sshExec(sshConn, `sudo mkdir -p /etc/docker && echo '${JSON.stringify({ "registry-mirrors": mirrors })}' | sudo tee /etc/docker/daemon.json && sudo systemctl restart docker`, env)
          event.sender.send('deploy:log', '✓ 远程 Docker 镜像源已配置')
        }
      } else if (step.action === 'pullDockerImageSsh') {
        if (sshConn) { await pullImageWithMirrorFallbackSsh(sshConn, getDockerImage(config), event, env); event.sender.send('deploy:log', '✓ 远程镜像拉取完成') }
      } else if (step.action === 'sshRunDockerContainer') {
        if (sshConn) { await sshExec(sshConn, buildDockerRunCmdSsh(config), env); event.sender.send('deploy:log', '✓ 远程 OpenClaw 容器已启动') }
      } else if (step.action === 'sshDoctorFixDocker') {
        if (sshConn) {
          try { await sshExec(sshConn, 'docker exec openclaw openclaw doctor --fix', env) } catch {}
          try { await sshExec(sshConn, 'docker exec openclaw openclaw config set gateway.mode local', env) } catch {}
          await sshExec(sshConn, 'docker restart openclaw', env)
          await new Promise(r => setTimeout(r, 8000))
          event.sender.send('deploy:log', '✓ 远程容器已重启')
        }
      } else if (step.action === 'sshWaitForReady') {
        if (sshConn) { await sshExec(sshConn, 'for i in $(seq 1 30); do curl -s http://127.0.0.1:18789 > /dev/null && break; sleep 2; done', env); event.sender.send('deploy:log', '✓ 远程服务已就绪') }
      } else if (step.action === 'sshOnboardDocker') {
        if (sshConn) await runOnboardSsh(config, sshConn, event, env, 'docker')
      } else if (step.action === 'sshOnboardLocal') {
        if (sshConn) await runOnboardSsh(config, sshConn, event, env, 'local')
      } else if (step.action === 'configFeishuDocker') {
        await configFeishu(config, event, env, 'docker')
      } else if (step.action === 'configFeishuLocal') {
        await configFeishu(config, event, env, 'local')
      } else if (step.action === 'sshConfigFeishuDocker') {
        if (sshConn) await configFeishuSsh(config, sshConn, event, env, 'docker')
      } else if (step.action === 'sshConfigFeishuLocal') {
        if (sshConn) await configFeishuSsh(config, sshConn, event, env, 'local')
      } else if (step.sshCmd && sshConn) {
        const out = await sshExec(sshConn, step.sshCmd, env)
        event.sender.send('deploy:log', `✓ ${step.label}: ${out.substring(0, 200)}`)
      } else if (step.cmd) {
        const actualCmd = step.cmd.startsWith('docker ') ? dockerCmd(step.cmd) : step.cmd
        const out = await execPromise(actualCmd, 300000, env)
        event.sender.send('deploy:log', `✓ ${step.label}: ${out.substring(0, 200)}`)
      }

      event.sender.send('deploy:progress', { step: step.id, label: step.label, progress: Math.round(((i + 1) / steps.length) * 100), status: 'done' })
    } catch (err) {
      const diagnosis = diagnoseError(err, step)
      event.sender.send('deploy:progress', { step: step.id, label: step.label, progress, status: 'error' })
      event.sender.send('deploy:error', { step: step.id, error: err.message, diagnosis })
      if (sshConn) sshConn.end()
      return
    }
  }

  // 获取 Dashboard URL 和 token
  const host = config.target === 'ssh' ? config.ssh.host : '127.0.0.1'
  let dashboardUrl = `http://${host}:18789`
  let token = ''
  try {
    if (config.mode === 'docker') {
      try {
        let out = ''
        if (config.target === 'ssh' && sshConn) out = await sshExec(sshConn, 'docker exec openclaw openclaw dashboard --no-open 2>&1 || echo ""', env)
        else out = await execPromise(dockerCmd('docker exec openclaw openclaw dashboard --no-open 2>&1 || echo ""'))
        const m = out.match(/https?:\/\/[^\s]+/)
        if (m) { dashboardUrl = m[0].replace('127.0.0.1', host).replace('localhost', host); const tm = dashboardUrl.match(/#token=([\w-]+)/); if (tm) token = tm[1] }
      } catch {}
      if (!token) {
        try {
          const readCmd = 'docker exec openclaw sh -c "cat /home/node/.openclaw/openclaw.json 2>/dev/null || cat /root/.openclaw/openclaw.json 2>/dev/null || echo \'{}\'"'
          let cfgJson = config.target === 'ssh' && sshConn ? await sshExec(sshConn, readCmd, env) : await execPromise(dockerCmd(readCmd))
          const parsed = JSON.parse(cfgJson.trim() || '{}')
          const t = parsed?.gateway?.auth?.token; if (t) { token = t; dashboardUrl = `http://${host}:18789/#token=${token}` }
        } catch {}
      }
    } else {
      try {
        const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
        if (fs.existsSync(cfgPath)) { const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); const t = parsed?.gateway?.auth?.token; if (t) { token = t; dashboardUrl = `http://${host}:18789/#token=${token}` } }
      } catch {}
    }
    event.sender.send('deploy:log', `✓ Dashboard 地址: ${dashboardUrl}`)
  } catch {}

  if (token) { try { fs.writeFileSync(path.join(DATA_DIR, 'gateway-token.txt'), token, 'utf8') } catch {} }
  if (sshConn) sshConn.end()

  event.sender.send('deploy:complete', { url: dashboardUrl, token })

  if (config.mode === 'docker') {
    if (deviceApproveInterval) clearInterval(deviceApproveInterval)
    deviceApproveInterval = setInterval(async () => {
      try { await execPromise(dockerCmd('docker exec openclaw openclaw devices approve --latest 2>/dev/null || true'), 5000) } catch {}
    }, 30000)
    execPromise(dockerCmd('docker exec openclaw openclaw devices approve --latest 2>/dev/null || true'), 5000).catch(() => {})
  }
}

// ============================================================
// 运维管理
// ============================================================
ipcMain.handle('manage:status', async (_e, config) => {
  try {
    const host = config?.target === 'ssh' ? config.ssh?.host : '127.0.0.1'
    const running = await new Promise(resolve => {
      const s = new net.Socket(); s.setTimeout(2000)
      s.on('connect', () => { s.destroy(); resolve(true) })
      s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false) })
      s.connect(18789, host || '127.0.0.1')
    })
    return { running }
  } catch { return { running: false } }
})

ipcMain.handle('manage:restart', async (_e, config) => {
  try {
    if (config?.mode === 'docker') {
      await execPromise(dockerCmd('docker restart openclaw'), 30000)
    } else {
      killPids(getPidsOnPort(18789)); await new Promise(r => setTimeout(r, 1200)); startNodeLocalGateway({})
    }
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('manage:stop', async (_e, config) => {
  try {
    if (config?.mode === 'docker') await execPromise(dockerCmd('docker stop openclaw'), 30000)
    else killPids(getPidsOnPort(18789))
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('manage:update', async (_e, config) => {
  try {
    if (config?.mode === 'docker') {
      await execPromise(dockerCmd(`docker pull ${getDockerImage(config)}`), 300000)
      await execPromise(dockerCmd('docker stop openclaw'), 30000).catch(() => {})
      await execPromise(dockerCmd('docker rm openclaw'), 10000).catch(() => {})
      await execPromise(buildDockerRunCmd(config), 300000)
    } else {
      await execPromise(`npm install -g ${getNodePackage(config?.imageChoice)}`, 300000)
    }
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('manage:uninstall', async (_e, config) => {
  try {
    if (config?.mode === 'docker') {
      await execPromise(dockerCmd('docker stop openclaw'), 30000).catch(() => {})
      await execPromise(dockerCmd('docker rm openclaw'), 10000).catch(() => {})
      await execPromise(dockerCmd('docker volume rm openclaw-data'), 10000).catch(() => {})
    } else {
      killPids(getPidsOnPort(18789))
      await execPromise('npm uninstall -g openclaw @qingchencloud/openclaw-zh', 60000).catch(() => {})
    }
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('manage:exportConfig', async () => {
  try {
    const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
    if (!fs.existsSync(cfgPath)) return { success: false, error: '配置文件不存在' }
    return { success: true, content: fs.readFileSync(cfgPath, 'utf8') }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('manage:exportLogs', async () => {
  try {
    const logDir = path.join(DATA_DIR)
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse()
    if (!files.length) return { success: true, content: '暂无日志' }
    return { success: true, content: fs.readFileSync(path.join(logDir, files[0]), 'utf8') }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('manage:approveDevices', async (_e, config) => {
  try {
    if (config?.mode === 'docker') await execPromise(dockerCmd('docker exec openclaw openclaw devices approve --latest'), 10000)
    else await execPromise('openclaw devices approve --latest', 10000)
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

// ============================================================
// Agent 心跳监测
// ============================================================
ipcMain.handle('manage:agents', async (_e, config) => {
  const host = config?.target === 'ssh' ? (config.ssh?.host || '127.0.0.1') : '127.0.0.1'
  const base = `http://${host}:18789`
  const token = config?.token || ''
  const headers = token ? { Authorization: `Bearer ${token}` } : {}

  function httpGet(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const mod = require('http')
      const req = mod.get(url, { headers, timeout: timeoutMs }, res => {
        let body = ''
        res.on('data', d => { body += d })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }) }
          catch { resolve({ status: res.statusCode, data: body }) }
        })
      })
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.on('error', reject)
    })
  }

  try {
    // 先检查服务是否在线
    const health = await httpGet(`${base}/api/health`, 3000).catch(() => null)
    if (!health || health.status >= 500) return { online: false, agents: [] }

    // 拉取 agents 列表
    const agentsRes = await httpGet(`${base}/api/agents`, 4000).catch(() => null)
    if (!agentsRes || agentsRes.status !== 200) return { online: true, agents: [] }

    const list = Array.isArray(agentsRes.data) ? agentsRes.data
      : Array.isArray(agentsRes.data?.agents) ? agentsRes.data.agents
      : Array.isArray(agentsRes.data?.data) ? agentsRes.data.data : []

    const now = Date.now()
    const agents = list.map(a => {
      const lastActive = a.lastActiveAt || a.last_active_at || a.updatedAt || a.updated_at || null
      const lastActiveMs = lastActive ? new Date(lastActive).getTime() : null
      const idleSec = lastActiveMs ? Math.floor((now - lastActiveMs) / 1000) : null
      // 超过 5 分钟无活动视为可能超时
      const status = a.status || (idleSec !== null && idleSec > 300 ? 'idle' : 'active')
      return {
        id: a.id || a.agentId || a.name,
        name: a.name || a.id || '未命名',
        status,
        idleSec,
        lastActive,
        model: a.model || a.llm || null,
        task: a.currentTask || a.task || a.description || null,
      }
    })

    return { online: true, agents }
  } catch (e) {
    return { online: false, agents: [], error: e.message }
  }
})

// ============================================================
// 技能插件
// ============================================================
ipcMain.handle('plugins:list', async (_e, config) => {
  try {
    let out = ''
    if (config?.mode === 'docker') out = await execPromise(dockerCmd('docker exec openclaw openclaw plugins list --json 2>/dev/null || echo "[]"'), 15000)
    else out = await execPromise('openclaw plugins list --json 2>/dev/null || echo "[]"', 15000)
    const list = JSON.parse(out.trim() || '[]')
    return { success: true, list: Array.isArray(list) ? list : [] }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('plugins:install', async (_e, config, name) => {
  try {
    if (config?.mode === 'docker') await execPromise(dockerCmd(`docker exec openclaw openclaw plugins install ${name}`), 120000)
    else await execPromise(`openclaw plugins install ${name}`, 120000)
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('plugins:uninstall', async (_e, config, name) => {
  try {
    if (config?.mode === 'docker') await execPromise(dockerCmd(`docker exec openclaw openclaw plugins uninstall ${name}`), 60000)
    else await execPromise(`openclaw plugins uninstall ${name}`, 60000)
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('plugins:setClawhubAllowed', async (_e, config) => {
  try {
    if (config?.mode === 'docker') await execPromise(dockerCmd('docker exec openclaw openclaw config set plugins.allow \'["clawhub2gateway"]\''), 10000)
    else await execPromise('openclaw config set plugins.allow \'["clawhub2gateway"]\'', 10000)
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('clawhub:install', async (_e, config, skillName) => {
  try {
    if (config?.mode === 'docker') await execPromise(dockerCmd(`docker exec openclaw npx clawhub@latest install ${skillName}`), 120000)
    else await execPromise(`npx clawhub@latest install ${skillName}`, 120000)
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

// ============================================================
// 配置 & 部署状态持久化
// ============================================================
const CONFIG_FILE = path.join(DATA_DIR, 'gui-config.json')
const DEPLOY_STATE_FILE = path.join(DATA_DIR, 'last-deploy.json')

ipcMain.handle('config:save', async (_, config) => {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8'); return { success: true } }
  catch (e) { return { success: false, error: e.message } }
})
ipcMain.handle('config:load', async () => {
  try { return { config: fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : null } }
  catch { return { config: null } }
})
ipcMain.handle('deployState:save', async (_, state) => {
  try { fs.writeFileSync(DEPLOY_STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); return { success: true } }
  catch (e) { return { success: false, error: e.message } }
})
ipcMain.handle('deployState:load', async () => {
  try { return fs.existsSync(DEPLOY_STATE_FILE) ? JSON.parse(fs.readFileSync(DEPLOY_STATE_FILE, 'utf8')) : null }
  catch { return null }
})

ipcMain.handle('shell:openExternal', async (_, url) => { shell.openExternal(url) })

// ============================================================
// 工具函数
// ============================================================
function execPromise(cmd, timeout = 300000, env = {}) {
  return new Promise((resolve, reject) => {
    const mergedEnv = { ...process.env, ...env }
    if (process.platform === 'darwin') mergedEnv.PATH = `/opt/homebrew/bin:/usr/local/bin:${mergedEnv.PATH || ''}`
    let actualCmd = cmd
    if (process.platform === 'win32' && !cmd.includes('-- bash -c')) {
      actualCmd = cmd.replace(/2>\/dev\/null/g, '2>nul').replace(/>\/dev\/null/g, '>nul').replace(/\|\|\s*true\b/g, '|| ver>nul')
      actualCmd = `chcp 65001 >nul & ${actualCmd}`
    }
    exec(actualCmd, { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env: mergedEnv, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve(stdout || stderr || '')
    })
  })
}

function execStream(cmd, event, env = {}) {
  return new Promise((resolve, reject) => {
    const mergedEnv = { ...process.env, ...env }
    if (process.platform === 'darwin') mergedEnv.PATH = `/opt/homebrew/bin:/usr/local/bin:${mergedEnv.PATH || ''}`
    let actualCmd = cmd
    if (process.platform === 'win32' && !cmd.includes('-- bash -c')) {
      actualCmd = cmd.replace(/2>\/dev\/null/g, '2>nul').replace(/>\/dev\/null/g, '>nul').replace(/\|\|\s*true\b/g, '|| ver>nul')
      actualCmd = `chcp 65001 >nul & ${actualCmd}`
    }
    const cp = exec(actualCmd, { maxBuffer: 50 * 1024 * 1024, env: mergedEnv, windowsHide: true })
    activeChildProcess = cp
    let lastSend = Date.now()
    const logsRingBuffer = []
    const sendLog = (data) => {
      const str = data.toString().trim(); if (!str) return
      const lines = str.split(/[\r\n]+/)
      lines.forEach(l => { logsRingBuffer.push(l); if (logsRingBuffer.length > 15) logsRingBuffer.shift() })
      const now = Date.now()
      if (now - lastSend > 500 || str.includes('Downloaded') || str.includes('Pull complete')) {
        event.sender.send('deploy:log', `  | ${lines[lines.length - 1]}`); lastSend = now
      }
    }
    cp.stdout.on('data', sendLog); cp.stderr.on('data', sendLog)
    cp.on('close', (code) => {
      activeChildProcess = null
      if (deployCancelled) return reject(new Error('部署已取消'))
      if (code === 0) resolve()
      else reject(new Error(`命令退出码 ${code}。\n最近日志:\n${logsRingBuffer.join('\n')}`))
    })
    cp.on('error', (err) => { activeChildProcess = null; reject(err) })
  })
}

function dockerCmd(cmd) {
  if (needsSudoDocker && process.platform === 'linux') return `sudo ${cmd}`
  if (useWslDocker && process.platform === 'win32' && wslDistroName) {
    const needsBash = /[|><;&$`]/.test(cmd)
    if (needsBash) return `wsl -d ${wslDistroName} -- bash -c "${cmd.replace(/"/g, '\\"')}"`
    return `wsl -d ${wslDistroName} -- ${cmd}`
  }
  return cmd
}

function buildDockerRunCmd(config) {
  const image = getDockerImage(config)
  const dataDir = getContainerDataDir(config)
  if (config.imageChoice === 'cn-im') {
    const llm = config.llm || {}
    const baseUrl = String(llm.baseUrl || '').replace(/"/g, '\\"')
    const apiKey = String(llm.apiKey || '').replace(/"/g, '\\"')
    const modelId = String(llm.modelId || llm.model || 'gpt-4o').replace(/"/g, '\\"')
    const envVars = `-e BASE_URL="${baseUrl}" -e API_KEY="${apiKey}" -e MODEL_ID="${modelId}" -e API_PROTOCOL=openai-completions -e OPENCLAW_GATEWAY_BIND=lan -e OPENCLAW_GATEWAY_PORT=18789 -e OPENCLAW_GATEWAY_MODE=local`
    return dockerCmd(`docker run -d --name openclaw -p 18789:18789 -p 18790:18790 -v openclaw-data:${dataDir} ${envVars} --restart unless-stopped ${image} openclaw gateway run --bind lan --port 18789 --allow-unconfigured`)
  }
  return dockerCmd(`docker run -d --name openclaw -p 18789:18789 -v openclaw-data:${dataDir} --restart unless-stopped ${image} openclaw gateway run --allow-unconfigured`)
}

function buildDockerRunCmdSsh(config) {
  const image = getDockerImage(config)
  const dataDir = getContainerDataDir(config)
  return `docker run -d --name openclaw -p 18789:18789 -v openclaw-data:${dataDir} --restart unless-stopped ${image} openclaw gateway run --allow-unconfigured`
}

function buildOnboardArgs(config) {
  const args = ['--non-interactive', '--accept-risk', '--mode local', '--gateway-bind lan', '--gateway-auth token', '--skip-channels', '--skip-skills', '--no-install-daemon']
  const first = config.llms?.[0] ?? config.llm
  if (first?.provider && first?.apiKey) {
    const providerMap = {
      deepseek:     { authChoice: 'custom-api-key', extra: ['--custom-base-url https://api.deepseek.com/v1', '--custom-model-id deepseek-chat', '--custom-compatibility openai'] },
      qwen:         { authChoice: 'custom-api-key', extra: ['--custom-base-url https://dashscope.aliyuncs.com/compatible-mode/v1', '--custom-model-id qwen-plus', '--custom-compatibility openai'] },
      kimi:         { authChoice: 'custom-api-key', extra: ['--custom-base-url https://api.moonshot.cn/v1', '--custom-model-id kimi-k2.5', '--custom-compatibility openai'] },
      moonshot:     { authChoice: 'moonshot-api-key', extra: [] },
      shengsuanyun: { authChoice: 'shengsuanyun-api-key', extra: [] },
      anthropic:    { authChoice: 'custom-api-key', extra: ['--custom-base-url https://api.anthropic.com', '--custom-compatibility anthropic'] },
      custom:       { authChoice: 'custom-api-key', extra: [] },
    }
    const m = providerMap[first.provider] || providerMap.custom
    args.push(`--auth-choice ${m.authChoice}`)
    if (m.authChoice === 'moonshot-api-key') args.push(`--moonshot-api-key "${first.apiKey}"`)
    else { args.push(`--custom-api-key "${first.apiKey}"`); if (first.baseUrl) args.push(`--custom-base-url "${first.baseUrl}"`); if (first.modelId) args.push(`--custom-model-id "${first.modelId}"`) }
    m.extra.forEach(a => args.push(a))
  } else { args.push('--auth-choice skip') }
  return args.join(' ')
}

async function runOnboard(config, event, env, mode) {
  const onboardArgs = buildOnboardArgs(config)
  const prefix = mode === 'docker' ? dockerCmd('docker exec openclaw openclaw') : 'openclaw'
  try { await execPromise(`${prefix} onboard ${onboardArgs}`, 60000) } catch {}
  await writeExtraModels(config, event, env, mode)
  try {
    await execPromise(`${prefix} plugins install @2en/clawhub2gateway`, 60000)
    event.sender.send('deploy:log', '✓ 已安装 ClawHub 插件')
    try { await execPromise(`${prefix} config set plugins.allow '["clawhub2gateway"]'`, 10000) } catch {}
  } catch (err) { event.sender.send('deploy:log', `⚠ ClawHub 插件安装跳过: ${(err.message || '').substring(0, 80)}`) }
  await new Promise(r => setTimeout(r, 5000))
  event.sender.send('deploy:log', '✓ 网关自动配置完成（onboard）')
}

async function runOnboardSsh(config, sshConn, event, env, mode) {
  const onboardArgs = buildOnboardArgs(config)
  const prefix = mode === 'docker' ? 'docker exec openclaw openclaw' : 'openclaw'
  try { await sshExec(sshConn, `${prefix} onboard ${onboardArgs}`, env) } catch {}
  await new Promise(r => setTimeout(r, 5000))
  event.sender.send('deploy:log', '✓ 远程网关配置完成')
}

async function writeExtraModels(config, event, env, mode) {
  const rest = (config.llms || []).slice(1)
  for (let i = 0; i < rest.length; i++) {
    const pid = `custom-${i + 2}`
    const models = [{ id: rest[i].modelId || 'default', baseUrl: rest[i].baseUrl || '', apiKey: rest[i].apiKey || '', modelId: rest[i].modelId || '', contextWindow: 65536, maxTokens: 8192 }]
    try {
      const escaped = JSON.stringify(models).replace(/'/g, "'\\''")
      const prefix = mode === 'docker' ? dockerCmd('docker exec openclaw openclaw') : 'openclaw'
      await execPromise(`${prefix} config set 'models.providers.${pid}.models' '${escaped}'`, 10000, env)
      event.sender.send('deploy:log', `✓ 已写入额外模型 provider: ${pid}`)
    } catch (err) { event.sender.send('deploy:log', `⚠ 写入 ${pid} 失败: ${err.message || ''}`) }
  }
}

async function configGatewayDocker(config, event, env) {
  event.sender.send('deploy:log', '⏳ 等待网关服务响应...')
  await waitForPort(18789, config.target === 'ssh' ? config.ssh.host : '127.0.0.1')
  await new Promise(r => setTimeout(r, 5000))
  if (config.imageChoice === 'cn-im') { event.sender.send('deploy:log', '⏳ 中国 IM 整合版镜像启动较慢，请稍候...'); await new Promise(r => setTimeout(r, 15000)) }
  const maxRetries = config.imageChoice === 'cn-im' ? 16 : 12
  const retryDelay = config.imageChoice === 'cn-im' ? 5000 : 4000
  let success = false
  for (let i = 0; i < maxRetries; i++) {
    try {
      await dockerExecWithRetry('openclaw config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true', event, env, { label: '开启控制台访问', timeoutMs: 15000, maxRetries: 1 })
      success = true; break
    } catch (err) {
      const short = (err?.message || '').slice(0, 140)
      event.sender.send('deploy:log', `⏳ 控制服务尚未就绪，${retryDelay / 1000}s 后重试 (${i + 1}/${maxRetries})... ${short ? `原因: ${short}` : ''}`)
      await new Promise(r => setTimeout(r, retryDelay))
    }
  }
  if (!success) throw new Error('无法配置网关控制台访问权限，控制服务未就绪。')
  for (const cfg of ['gateway.auth.autoApproveDevices true', 'gateway.pairingRequired false', 'gateway.auth.requireDeviceApproval false']) {
    try { await execPromise(dockerCmd(`docker exec openclaw openclaw config set ${cfg}`), 5000) } catch {}
  }
  event.sender.send('deploy:log', '✓ 控制台访问已开启')
}

async function configFeishu(config, event, env, mode) {
  await waitForPort(18789, '127.0.0.1'); await new Promise(r => setTimeout(r, 3000))
  const prefix = mode === 'docker' ? dockerCmd('docker exec openclaw openclaw') : 'openclaw'
  for (const cmd of buildFeishuCmds(config, prefix)) {
    let ok = false
    for (let i = 0; i < 5; i++) { try { await execPromise(cmd, 15000, env); ok = true; break } catch { await new Promise(r => setTimeout(r, 2000)) } }
    if (!ok) throw new Error(`飞书配置写入失败: ${cmd}`)
  }
  event.sender.send('deploy:log', '✓ 飞书通道已配置（WebSocket 模式）')
}

async function configFeishuSsh(config, sshConn, event, env, mode) {
  await sshExec(sshConn, 'for i in $(seq 1 30); do curl -s http://127.0.0.1:18789 > /dev/null && break; sleep 2; done', env)
  await new Promise(r => setTimeout(r, 3000))
  const prefix = mode === 'docker' ? 'docker exec openclaw openclaw' : 'openclaw'
  for (const cmd of buildFeishuCmds(config, prefix)) {
    let ok = false
    for (let i = 0; i < 5; i++) { try { await sshExec(sshConn, cmd, env); ok = true; break } catch { await new Promise(r => setTimeout(r, 2000)) } }
    if (!ok) throw new Error(`远程飞书配置写入失败: ${cmd}`)
  }
  event.sender.send('deploy:log', '✓ 远程飞书通道已配置（WebSocket 模式）')
}

function buildFeishuCmds(config, prefix) {
  const f = config.feishu; if (!f) return []
  const esc = v => `'${String(v).replace(/'/g, "'\\''")}'`
  const cmds = [
    `${prefix} config set channels.feishu.appId ${esc(f.appId)}`,
    `${prefix} config set channels.feishu.appSecret ${esc(f.appSecret)}`,
    `${prefix} config set channels.feishu.domain feishu`,
    `${prefix} config set channels.feishu.connectionMode websocket`,
    `${prefix} config set channels.feishu.dmPolicy open`,
    `${prefix} config set channels.feishu.enabled true`,
  ]
  if (f.encryptKey) cmds.push(`${prefix} config set channels.feishu.encryptKey ${esc(f.encryptKey)}`)
  if (f.verificationToken) cmds.push(`${prefix} config set channels.feishu.verificationToken ${esc(f.verificationToken)}`)
  return cmds
}

async function dockerExecWithRetry(cmdInside, event, env = {}, opts = {}) {
  const maxRetries = opts.maxRetries ?? 10; const retryDelay = opts.retryDelayMs ?? 4000
  const label = opts.label ?? '执行命令'; const timeoutMs = opts.timeoutMs ?? 15000
  for (let i = 0; i < maxRetries; i++) {
    await waitForContainerRunning('openclaw', event, 60000, env)
    try { return await execPromise(dockerCmd(`docker exec openclaw ${cmdInside}`), timeoutMs, env) }
    catch (err) {
      const msg = (err?.message || '').trim().slice(0, 160)
      event?.sender?.send?.('deploy:log', `⏳ ${label} 尚未成功，${retryDelay / 1000}s 后重试 (${i + 1}/${maxRetries})... ${msg ? `原因: ${msg}` : ''}`)
      await new Promise(r => setTimeout(r, retryDelay))
    }
  }
  throw new Error(`${label} 多次重试仍失败`)
}

async function waitForContainerRunning(name, event, timeoutMs = 60000, env = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const out = await execPromise(dockerCmd(`docker ps --filter name=^${name}$ --format "{{.Status}}"`), 8000, env)
      if ((out || '').trim().toLowerCase().includes('up')) return true
    } catch {}
    await new Promise(r => setTimeout(r, 2000))
  }
  return false
}

async function waitForPort(port, host = '127.0.0.1', maxWait = 60000) {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      await new Promise((resolve, reject) => {
        const s = new net.Socket(); s.setTimeout(2000)
        s.once('connect', () => { s.destroy(); resolve() })
        s.once('error', reject); s.once('timeout', () => { s.destroy(); reject(new Error('timeout')) })
        s.connect(port, host)
      }); return
    } catch { await new Promise(r => setTimeout(r, 2000)) }
  }
  throw new Error(`端口 ${port} 在 ${maxWait / 1000}s 内未就绪`)
}

function httpHead(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http')
    const req = mod.request(url, { method: 'HEAD', timeout }, res => resolve(res.statusCode))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject); req.end()
  })
}

function getPidsOnPort(port) {
  const { execSync } = require('child_process'); const pids = new Set()
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port}"`, { encoding: 'utf8', timeout: 5000 })
      out.split(/\r?\n/).filter(l => l.toUpperCase().includes('LISTENING')).forEach(l => { const p = parseInt(l.trim().split(/\s+/).pop(), 10); if (!isNaN(p) && p > 0) pids.add(p) })
    } else if (process.platform === 'darwin') {
      execSync(`lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 }).split(/\s+/).forEach(s => { const p = parseInt(s, 10); if (!isNaN(p) && p > 0) pids.add(p) })
    } else {
      const out = execSync(`ss -tlnp 2>/dev/null | grep ":${port}" || true`, { encoding: 'utf8', timeout: 5000 })
      const m = out.match(/pid=(\d+)/g); if (m) m.forEach(x => { const p = parseInt(x.replace('pid=', ''), 10); if (!isNaN(p)) pids.add(p) })
    }
  } catch {}
  return Array.from(pids)
}

function killPids(pids) {
  if (!pids?.length) return
  for (const pid of pids) {
    try { if (process.platform === 'win32') require('child_process').execSync(`taskkill /PID ${pid} /F`, { timeout: 5000 }); else process.kill(pid, 'SIGTERM') } catch {}
  }
}

function startNodeLocalGateway(env = {}) {
  const mergedEnv = { ...process.env, ...env }
  if (process.platform === 'win32') exec('start /B openclaw gateway --allow-unconfigured --port 18789', { windowsHide: true, env: mergedEnv })
  else spawn('openclaw', ['gateway', '--allow-unconfigured', '--port', '18789'], { detached: true, stdio: 'ignore', env: mergedEnv }).unref()
}

function diagnoseError(err, step) {
  const msg = err?.message || ''
  if (msg.includes('docker') && msg.includes('not found')) return 'Docker 未安装或未在 PATH 中。请先安装 Docker Desktop 并确保已启动。'
  if (msg.includes('Cannot connect to the Docker daemon')) return 'Docker 引擎未运行。请启动 Docker Desktop 后重试。'
  if (msg.includes('pull access denied') || msg.includes('manifest unknown')) return '镜像拉取失败，所有镜像源均不可用。请检查网络连接或配置代理。'
  if (msg.includes('port is already allocated') || msg.includes('address already in use')) return '端口 18789 已被占用。请先停止旧的 OpenClaw 实例，或在运维管理中停止服务。'
  if ((msg.includes('github.com') || msg.includes('libsignal') || msg.includes('whiskeysockets')) && (msg.includes('443') || msg.includes('connect') || msg.includes('Failed'))) return '无法访问 GitHub（github.com:443 不可达）。OpenClaw 的部分依赖来自 GitHub Git 仓库，请开启代理/VPN 后重试。'
  if (msg.includes('ECONNREFUSED') && !msg.includes('github')) return 'SSH 连接失败。请检查服务器地址、端口、用户名和密码是否正确。'
  if (msg.includes('ssh') && (msg.includes('auth') || msg.includes('Authentication'))) return 'SSH 认证失败。请检查用户名和密码/密钥是否正确。'
  if (msg.includes('npm') && msg.includes('ENOTFOUND')) return 'npm 安装失败，无法访问 npm 镜像源。请检查网络连接。'
  if (msg.includes('openclaw') && msg.includes('not found')) return 'OpenClaw 未安装或未在 PATH 中。请重新运行部署。'
  if (msg.includes('EEXIST') || msg.includes('already exists') || (msg.includes('openclaw') && msg.includes('npm'))) return '检测到旧版 OpenClaw 命令残留，导致新版本无法安装。请点击"卸载旧版后继续"按钮清理后重试。'
  if (msg.includes('EPERM') || msg.includes('permission denied') || msg.includes('Access is denied')) return '权限不足。Windows 用户请以管理员身份运行本程序，或在 npm 全局目录权限设置中允许当前用户写入。'
  if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) return '网络超时。请检查网络连接，或在配置页面设置代理后重试。'
  return '请查看上方日志了解详情，或重试部署。'
}

// ============================================================
// 卸载旧版 openclaw
// ============================================================
ipcMain.handle('deploy:uninstall-old', async () => {
  const results = []
  const packages = ['openclaw', '@qingchencloud/openclaw-zh']
  for (const pkg of packages) {
    try {
      await execPromise(`npm uninstall -g ${pkg}`, 30000)
      results.push(`✓ 已卸载 ${pkg}`)
    } catch (e) {
      const msg = e?.message || ''
      if (!msg.includes('not found') && !msg.includes('does not exist')) {
        results.push(`⚠ 卸载 ${pkg} 时出错：${msg.split('\n')[0]}`)
      }
    }
  }
  return { ok: true, results }
})

// ============================================================
// Docker 环境安装
// ============================================================
async function ensureDockerLocal(event, env = {}) {
  if (process.platform === 'darwin') ensureMacBrewPath(env)

  if (process.platform === 'win32') {
    try {
      const wslList = await execPromise('wsl -l -q', 5000, env)
      const distros = wslList.split(/[\r\n]+/).map(s => s.replace(/\0/g, '').trim()).filter(Boolean)
      for (const distro of distros) {
        try { await execPromise(`wsl -d ${distro} -- docker info`, 10000, env); event.sender.send('deploy:log', `✓ 在 WSL (${distro}) 中检测到可用的 Docker`); useWslDocker = true; wslDistroName = distro; break } catch {}
      }
    } catch {}
    if (!useWslDocker) {
      const winDockerPaths = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin'), path.join(process.env.LOCALAPPDATA || '', 'Docker', 'resources', 'bin')].filter(p => fs.existsSync(path.join(p, 'docker.exe')))
      if (winDockerPaths.length > 0) process.env.PATH = `${winDockerPaths[0]};${process.env.PATH}`
    }
  }

  if (!useWslDocker) {
    let hasDocker = false
    try { await execPromise('docker --version', 5000, env); hasDocker = true; event.sender.send('deploy:log', '✓ Docker CLI 已安装') } catch {}
    if (!hasDocker) {
      if (process.platform === 'darwin') {
        await ensureHomebrewMac(event, env)
        event.sender.send('deploy:log', '⏳ 正在安装 Docker (Colima + Docker CLI)...')
        await execStream('brew install docker colima', event, env)
        event.sender.send('deploy:log', '✓ Docker CLI 已安装')
      } else if (process.platform === 'linux') {
        event.sender.send('deploy:log', '⏳ 正在安装 Docker...')
        await execStream('curl -fsSL https://get.docker.com | sh', event, env)
        needsSudoDocker = true
        event.sender.send('deploy:log', '✓ Docker 已安装')
      } else {
        throw new Error('未检测到 Docker，请先安装 Docker Desktop：https://www.docker.com/products/docker-desktop')
      }
    }
  }

  // 确保引擎运行
  if (!useWslDocker) {
    let engineRunning = false
    try { await Promise.race([execPromise('docker info', 300000, env), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))]); engineRunning = true } catch {}
    if (!engineRunning) {
      if (process.platform === 'darwin') {
        let hasColima = false
        try { await execPromise('colima version', 5000, env); hasColima = true } catch {}
        if (hasColima) {
          event.sender.send('deploy:log', '⏳ 启动 Colima 虚拟机...')
          try { await execStream('colima start --cpu 2 --memory 4', event, env); event.sender.send('deploy:log', '✓ Colima 已启动') }
          catch { await execPromise('colima delete -f 2>/dev/null; colima start --cpu 2 --memory 4', 300000, env); event.sender.send('deploy:log', '✓ Colima 重置并启动成功') }
        } else {
          event.sender.send('deploy:log', '⏳ 尝试启动 Docker Desktop...')
          try { await execPromise('open -a Docker', 10000, env) } catch {}
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 4000))
            try { await execPromise('docker info', 5000, env); engineRunning = true; break } catch {}
          }
          if (!engineRunning) throw new Error('Docker Desktop 启动超时，请手动启动后重试。')
        }
      } else if (process.platform === 'win32') {
        event.sender.send('deploy:log', '⏳ 尝试启动 Docker Desktop...')
        const ddPath = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe')
        try { if (fs.existsSync(ddPath)) await execPromise(`start "" "${ddPath}"`, 10000, env) } catch {}
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 4000))
          try { await execPromise('docker info', 5000, env); engineRunning = true; break } catch {}
        }
        if (!engineRunning) throw new Error('Docker Desktop 启动超时，请手动启动后重试。')
      }
    }
  }
  event.sender.send('deploy:log', '✓ Docker 环境就绪')
}

async function ensureDockerSsh(sshConn, event, env = {}) {
  try { await sshExec(sshConn, 'docker --version', env); event.sender.send('deploy:log', '✓ 远程 Docker 已安装') }
  catch {
    event.sender.send('deploy:log', '⏳ 远程未检测到 Docker，正在安装...')
    await sshExecStream(sshConn, 'curl -fsSL https://get.docker.com | sh', event, env)
    event.sender.send('deploy:log', '✓ 远程 Docker 已安装')
  }
  try { await sshExec(sshConn, 'docker info', env) }
  catch { await sshExec(sshConn, 'sudo systemctl start docker && sudo systemctl enable docker', env) }
  event.sender.send('deploy:log', '✓ 远程 Docker 引擎就绪')
}

async function ensureNodeLocal(event, env = {}) {
  if (process.platform === 'darwin') ensureMacBrewPath(env)
  let hasNode = false; let nodeVer = 0
  try { const v = await execPromise('node --version', 5000, env); hasNode = true; nodeVer = parseInt(v.trim().replace('v', '').split('.')[0], 10) } catch {}
  if (hasNode && nodeVer >= 18) { event.sender.send('deploy:log', `✓ Node.js 已安装 (v${nodeVer})`); return }
  event.sender.send('deploy:log', hasNode ? `⚠ Node.js 版本过低 (v${nodeVer})，需要 v18+，正在升级...` : '⏳ 未检测到 Node.js，正在安装...')
  if (process.platform === 'darwin') {
    await ensureHomebrewMac(event, env)
    await execStream('brew install node@22 && brew link --overwrite node@22', event, env)
    ensureMacBrewPath(env)
  } else if (process.platform === 'linux') {
    await execStream('curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs', event, env)
  } else if (process.platform === 'win32') {
    const msi = path.join(os.tmpdir(), 'node-v22.msi')
    await execStream(`powershell -Command "Invoke-WebRequest -Uri 'https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-x64.msi' -OutFile '${msi}'"`, event, env)
    await execPromise(`msiexec /i "${msi}" /quiet /norestart ADDLOCAL=ALL`, 300000, env)
    env.PATH = `${env.PATH || process.env.PATH};${process.env.ProgramFiles}\\nodejs`
  }
  event.sender.send('deploy:log', '✓ Node.js 已安装')
}

async function ensureGitLocal(event, env = {}) {
  try { await execPromise('git --version', 5000, env); event.sender.send('deploy:log', '✓ Git 已安装'); return } catch {}
  event.sender.send('deploy:log', '⏳ 未检测到 Git，正在安装...')
  if (process.platform === 'darwin') { await ensureHomebrewMac(event, env); await execStream('brew install git', event, env) }
  else if (process.platform === 'linux') { await execStream('sudo apt-get install -y git || sudo yum install -y git', event, env) }
  event.sender.send('deploy:log', '✓ Git 已安装')
}

async function installOpenclawNode(config, event, env = {}) {
  // 根据 imageChoice 选择对应的离线包目录
  const isOfficial = config.imageChoice === 'official'
  const bundledName = isOfficial ? 'bundled-official' : 'bundled-zh'
  const bundledDir = path.join(process.resourcesPath || path.join(__dirname, '..', 'resources'), bundledName)
  const bundledBin = path.join(bundledDir, 'node_modules', '.bin')
  const bundledOpenclawBin = path.join(bundledBin, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw')

  if (fs.existsSync(bundledOpenclawBin)) {
    const label = isOfficial ? 'OpenClaw 官方版' : 'OpenClaw 汉化版'
    event.sender.send('deploy:log', `⏳ 正在从离线包安装 ${label}（无需网络）...`)

    const globalNpmBin = await execPromise('npm bin -g', 8000, env).then(s => s.trim()).catch(() => {
      if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'npm')
      return path.join(os.homedir(), '.npm-global', 'bin')
    })

    if (!fs.existsSync(globalNpmBin)) fs.mkdirSync(globalNpmBin, { recursive: true })

    // 找到 openclaw.mjs 入口文件
    const pkgSubDir = isOfficial
      ? path.join(bundledDir, 'node_modules', 'openclaw')
      : path.join(bundledDir, 'node_modules', '@qingchencloud', 'openclaw-zh')
    const openclawMjs = path.join(pkgSubDir, 'openclaw.mjs')

    if (process.platform === 'win32') {
      const cmdContent = `@echo off\nnode "${openclawMjs}" %*\n`
      const ps1Content = `#!/usr/bin/env pwsh\nnode "${openclawMjs}" @args\n`
      fs.writeFileSync(path.join(globalNpmBin, 'openclaw.cmd'), cmdContent, 'utf8')
      fs.writeFileSync(path.join(globalNpmBin, 'openclaw.ps1'), ps1Content, 'utf8')
    } else {
      const wrapperPath = path.join(globalNpmBin, 'openclaw')
      fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec node "${openclawMjs}" "$@"\n`, 'utf8')
      fs.chmodSync(wrapperPath, 0o755)
    }

    env.NODE_PATH = path.join(bundledDir, 'node_modules')

    event.sender.send('deploy:log', `✓ ${label} 离线安装完成`)
    return
  }

  // 回退：bundled 不存在（开发环境），走在线安装
  event.sender.send('deploy:log', '⚠ 未找到离线包，尝试在线安装...')
  const pkg = getNodePackage(config.imageChoice)

  // git 依赖重写 + 镜像加速
  const gitRewriteCmds = [
    'git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"',
    'git config --global url."https://github.com/".insteadOf "git@github.com:"',
  ]
  const githubOk = await new Promise(resolve => {
    const s = new net.Socket(); s.setTimeout(4000)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false) })
    s.connect(443, 'github.com')
  })
  if (!githubOk) {
    event.sender.send('deploy:log', '⚠ github.com 不可达，尝试镜像站...')
    for (const m of ['https://hub.nuaa.cf/', 'https://ghproxy.com/https://github.com/']) {
      const host = new URL(m).hostname
      const ok = await new Promise(resolve => {
        const s = new net.Socket(); s.setTimeout(3000)
        s.on('connect', () => { s.destroy(); resolve(true) })
        s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false) })
        s.connect(443, host)
      })
      if (ok) { gitRewriteCmds.push(`git config --global url."${m}".insteadOf "https://github.com/"`); event.sender.send('deploy:log', `✓ 使用镜像：${m}`); break }
    }
  }
  for (const cmd of gitRewriteCmds) await execPromise(cmd, 8000, env).catch(() => {})
  await execPromise('npm config set registry https://registry.npmmirror.com', 5000, env).catch(() => {})

  event.sender.send('deploy:log', `⏳ 正在在线安装 ${pkg}...`)
  await execStream(`npm install -g ${pkg}`, event, env)
  event.sender.send('deploy:log', `✓ ${pkg} 安装完成`)
}

function ensureMacBrewPath(env = {}) {
  const brewDirs = ['/opt/homebrew/bin', '/usr/local/bin']
  let currentPath = env.PATH || process.env.PATH || ''
  const parts = currentPath.split(':').filter(Boolean)
  let changed = false
  for (const dir of brewDirs) { try { if (fs.existsSync(dir) && !parts.includes(dir)) { parts.unshift(dir); changed = true } } catch {} }
  if (changed) env.PATH = parts.join(':')
  return env
}

async function ensureHomebrewMac(event, env = {}) {
  if (process.platform !== 'darwin') return
  ensureMacBrewPath(env)
  try { await execPromise('brew --version', 15000, env); return } catch {}
  event.sender.send('deploy:log', '⏳ 未检测到 Homebrew，正在使用国内 Gitee 镜像安装...')
  const script = ['set -e', 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"', 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://gitee.com/ineo6/homebrew-install/raw/master/install.sh)" || true', 'eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null || true)"'].join('\n')
  const tmp = path.join(os.tmpdir(), 'install-homebrew.sh')
  try { fs.writeFileSync(tmp, script, { mode: 0o755, encoding: 'utf8' }); await execStream(`bash "${tmp}"`, event, env) } finally { try { fs.unlinkSync(tmp) } catch {} }
  ensureMacBrewPath(env)
  await execPromise('brew --version', 30000, env)
  event.sender.send('deploy:log', '✓ Homebrew 已安装')
}

// ============================================================
// Docker 镜像源
// ============================================================
const DOCKER_MIRRORS = [
  'https://docker.1panel.live', 'https://hub.rat.dev', 'https://docker.m.daocloud.io',
  'https://mirror.ccs.tencentyun.com', 'https://dockerhub.icu', 'https://docker.nju.edu.cn',
]

async function getFastestMirror(env = {}) {
  const results = await Promise.allSettled(DOCKER_MIRRORS.map(async m => {
    const start = Date.now(); await httpHead(`${m}/v2/`, 5000); return { mirror: m, ms: Date.now() - start }
  }))
  const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value).sort((a, b) => a.ms - b.ms)
  return ok.length > 0 ? ok.slice(0, 3).map(r => r.mirror) : DOCKER_MIRRORS.slice(0, 3)
}

async function configDockerMirror(event, env = {}) {
  event.sender.send('deploy:log', '⏳ 正在测速并选择最佳 Docker 镜像源...')
  const mirrors = await getFastestMirror(env)
  event.sender.send('deploy:log', `✓ 最佳镜像源: ${mirrors[0]}`)
  const mirrorConfig = JSON.stringify({ "registry-mirrors": mirrors })
  if (process.platform === 'darwin') {
    const dockerConfigDir = path.join(os.homedir(), '.docker')
    fs.mkdirSync(dockerConfigDir, { recursive: true })
    const daemonPath = path.join(dockerConfigDir, 'daemon.json')
    let existing = {}
    try { existing = JSON.parse(fs.readFileSync(daemonPath, 'utf8')) } catch {}
    existing['registry-mirrors'] = mirrors
    fs.writeFileSync(daemonPath, JSON.stringify(existing, null, 2), 'utf8')
    try { await execPromise('pkill -HUP dockerd 2>/dev/null || true', 5000, env) } catch {}
  } else if (process.platform === 'linux') {
    await execPromise(`sudo mkdir -p /etc/docker && echo '${mirrorConfig}' | sudo tee /etc/docker/daemon.json && sudo systemctl restart docker`, 30000, env)
  } else if (process.platform === 'win32') {
    const dockerConfigDir = path.join(os.homedir(), '.docker')
    fs.mkdirSync(dockerConfigDir, { recursive: true })
    const daemonPath = path.join(dockerConfigDir, 'daemon.json')
    let existing = {}
    try { existing = JSON.parse(fs.readFileSync(daemonPath, 'utf8')) } catch {}
    existing['registry-mirrors'] = mirrors
    fs.writeFileSync(daemonPath, JSON.stringify(existing, null, 2), 'utf8')
  }
}

async function pullImageWithMirrorFallback(image, event, env = {}) {
  const mirrors = await getFastestMirror(env)
  for (const mirror of mirrors) {
    const mirrorImage = `${mirror.replace('https://', '')}/${image}`
    event.sender.send('deploy:log', `⏳ 尝试从 ${mirror} 拉取镜像...`)
    try {
      await execStream(dockerCmd(`docker pull ${mirrorImage}`), event, env)
      await execPromise(dockerCmd(`docker tag ${mirrorImage} ${image}`), 10000, env)
      event.sender.send('deploy:log', `✓ 镜像拉取成功（来源: ${mirror}）`); return
    } catch { event.sender.send('deploy:log', `⚠ ${mirror} 拉取失败，尝试下一个...`) }
  }
  event.sender.send('deploy:log', '⏳ 镜像源均失败，尝试直接拉取...')
  await execStream(dockerCmd(`docker pull ${image}`), event, env)
}

async function pullImageWithMirrorFallbackSsh(sshConn, image, event, env = {}) {
  const mirrors = await getFastestMirror(env)
  for (const mirror of mirrors) {
    const mirrorImage = `${mirror.replace('https://', '')}/${image}`
    event.sender.send('deploy:log', `⏳ 远程尝试从 ${mirror} 拉取镜像...`)
    try {
      await sshExecStream(sshConn, `docker pull ${mirrorImage} && docker tag ${mirrorImage} ${image}`, event, env)
      event.sender.send('deploy:log', `✓ 远程镜像拉取成功（来源: ${mirror}）`); return
    } catch { event.sender.send('deploy:log', `⚠ ${mirror} 拉取失败，尝试下一个...`) }
  }
  await sshExecStream(sshConn, `docker pull ${image}`, event, env)
}

// ============================================================
// SSH
// ============================================================
let Client
try { Client = require('ssh2').Client } catch { Client = null }

function sshConnect(sshConfig) {
  return new Promise((resolve, reject) => {
    if (!Client) return reject(new Error('ssh2 模块未安装，请运行 npm install'))
    const conn = new Client()
    conn.on('ready', () => resolve(conn))
    conn.on('error', reject)
    const opts = { host: sshConfig.host, port: sshConfig.port || 22, username: sshConfig.username }
    if (sshConfig.privateKey) opts.privateKey = sshConfig.privateKey; else opts.password = sshConfig.password
    conn.connect(opts)
  })
}

function sshExec(conn, command, env = {}, timeout = 600000) {
  return new Promise((resolve, reject) => {
    let envPrefix = ''
    for (const [k, v] of Object.entries(env)) { if (v) envPrefix += `export ${k}='${v}'; ` }
    const fullCmd = envPrefix ? `${envPrefix}${command}` : command
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`SSH 命令超时 (${timeout / 1000}s): ${command.substring(0, 80)}`)) } }, timeout)
    conn.exec(fullCmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err) }
      let out = ''
      stream.on('data', d => { out += d.toString() }); stream.stderr.on('data', d => { out += d.toString() })
      stream.on('close', code => {
        if (settled) return; settled = true; clearTimeout(timer)
        if (code !== 0 && code !== null) return reject(new Error(`命令退出码 ${code}: ${out}`))
        resolve(out)
      })
    })
  })
}

function sshExecStream(conn, command, event, env = {}, timeout = 900000) {
  return new Promise((resolve, reject) => {
    let envPrefix = ''
    for (const [k, v] of Object.entries(env)) { if (v) envPrefix += `export ${k}='${v}'; ` }
    const fullCmd = envPrefix ? `${envPrefix}${command}` : command
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`SSH 流式命令超时 (${timeout / 1000}s)`)) } }, timeout)
    conn.exec(fullCmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err) }
      let lastSend = Date.now(); let out = ''
      const sendLog = data => {
        const str = data.toString().trim(); if (!str) return
        out += str + '\n'
        const now = Date.now()
        if (now - lastSend > 500 || str.includes('Downloaded') || str.includes('Pull complete')) {
          const lines = str.split('\n'); event.sender.send('deploy:log', `  | ${lines[lines.length - 1]}`); lastSend = now
        }
      }
      stream.on('data', sendLog); stream.stderr.on('data', sendLog)
      stream.on('close', code => {
        if (settled) return; settled = true; clearTimeout(timer)
        if (code !== 0 && code !== null) return reject(new Error(`命令退出码 ${code}: ${out}`))
        resolve()
      })
    })
  })
}
