// ============================================================
// 模型预设
// ============================================================
const MODEL_PRESETS = {
  moonshot:  { apiBase: 'https://api.moonshot.cn/v1',                        modelName: 'kimi-k2-5',                  hint: '在 platform.moonshot.cn 获取' },
  deepseek:  { apiBase: 'https://api.deepseek.com/v1',                       modelName: 'deepseek-chat',              hint: '在 platform.deepseek.com 获取' },
  qwen:      { apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelName: 'qwen-max',                   hint: '在 dashscope.aliyun.com 获取' },
  anthropic: { apiBase: 'https://api.anthropic.com/v1',                      modelName: 'claude-3-5-sonnet-20241022', hint: '在 console.anthropic.com 获取' },
  custom:    { apiBase: '',                                                    modelName: '',                           hint: '填写自定义 API 地址和密钥' },
}

// ============================================================
// 侧边栏导航
// ============================================================
function showTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
  document.getElementById('tab-' + tabId).classList.add('active')
  document.querySelector(`.nav-item[data-tab="${tabId}"]`).classList.add('active')
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const tab = item.dataset.tab
    showTab(tab)
    if (tab === 'ops') refreshOpsStatus()
  })
})

// ============================================================
// 系统检测
// ============================================================
async function detectSystem() {
  try {
    const info = await window.api.detectSystem()
    const platMap = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
    document.getElementById('sys-platform').textContent = `${platMap[info.platform] || info.platform} (${info.arch})`

    const nodeEl = document.getElementById('sys-node')
    if (info.hasNode) {
      nodeEl.textContent = info.nodeSystemVersion
      nodeEl.className = 'sys-val ok'
    } else {
      nodeEl.textContent = '未安装（将自动安装）'
      nodeEl.className = 'sys-val warn'
    }

    document.getElementById('sys-mem').textContent = `${info.freeMemoryGB} GB 可用 / ${info.totalMemoryGB} GB`

    const diskEl = document.getElementById('sys-disk')
    if (info.diskFreeGB !== null) {
      diskEl.textContent = `${info.diskFreeGB} GB 可用`
      diskEl.className = info.diskFreeGB < 2 ? 'sys-val warn' : 'sys-val ok'
    } else {
      diskEl.textContent = '未知'
    }

    const portEl = document.getElementById('sys-port')
    if (info.port18789InUse) {
      portEl.textContent = '已占用（将重启）'
      portEl.className = 'sys-val warn'
    } else {
      portEl.textContent = '空闲'
      portEl.className = 'sys-val ok'
    }
  } catch (e) { console.error('系统检测失败', e) }
}

detectSystem()

// ============================================================
// 模型选择
// ============================================================
function applyModelPreset(provider) {
  const preset = MODEL_PRESETS[provider] || MODEL_PRESETS.custom
  const isCustom = provider === 'custom'
  document.getElementById('api-base').value = preset.apiBase
  document.getElementById('model-name').value = preset.modelName
  document.getElementById('key-hint').textContent = preset.hint
  document.getElementById('api-base').readOnly = !isCustom
  document.getElementById('api-base').style.opacity = isCustom ? '1' : '0.6'
}

document.getElementById('model-provider').addEventListener('change', (e) => {
  applyModelPreset(e.target.value)
  saveCurrentConfig()
})

// ============================================================
// 飞书开关
// ============================================================
document.getElementById('feishu-enable').addEventListener('change', (e) => {
  document.getElementById('feishu-fields').classList.toggle('hidden', !e.target.checked)
})

// ============================================================
// API Key 显示/隐藏
// ============================================================
document.getElementById('btn-eye').addEventListener('click', () => {
  const input = document.getElementById('api-key')
  input.type = input.type === 'password' ? 'text' : 'password'
})

// ============================================================
// 配置持久化
// ============================================================
async function saveCurrentConfig() {
  const config = {
    modelProvider: document.getElementById('model-provider').value,
    apiBase: document.getElementById('api-base').value,
    modelName: document.getElementById('model-name').value,
    feishuEnabled: document.getElementById('feishu-enable').checked,
    feishuAppId: document.getElementById('feishu-app-id').value,
    testMode: document.getElementById('test-mode').checked,
  }
  await window.api.saveConfig(config)
}

async function loadSavedConfig() {
  const { config } = await window.api.loadConfig()
  if (!config) { applyModelPreset('moonshot'); return }
  if (config.modelProvider) {
    document.getElementById('model-provider').value = config.modelProvider
    applyModelPreset(config.modelProvider)
  }
  if (config.apiBase) document.getElementById('api-base').value = config.apiBase
  if (config.modelName) document.getElementById('model-name').value = config.modelName
  if (config.feishuEnabled) {
    document.getElementById('feishu-enable').checked = true
    document.getElementById('feishu-fields').classList.remove('hidden')
  }
  if (config.feishuAppId) document.getElementById('feishu-app-id').value = config.feishuAppId
  if (config.testMode) document.getElementById('test-mode').checked = true
}

loadSavedConfig()

// ============================================================
// 部署进度
// ============================================================
const progressMap = [
  { keywords: ['第一步', '检测 Node', 'Checking Node'],        pct: 10, step: 0, label: '检测 Node.js 环境...' },
  { keywords: ['第二步', '安装 Node', 'Installing Node'],      pct: 25, step: 1, label: '安装 Node.js...' },
  { keywords: ['第三步', 'npm 镜像', 'npm mirror'],            pct: 38, step: 1, label: '配置 npm 镜像...' },
  { keywords: ['第四步', '安装 OpenClaw', 'npm install'],      pct: 52, step: 1, label: '安装 OpenClaw...' },
  { keywords: ['第五步', '填写配置', '写入配置'],               pct: 65, step: 2, label: '写入配置文件...' },
  { keywords: ['第六步', '配置文件', 'openclaw.json'],         pct: 78, step: 2, label: '配置模型参数...' },
  { keywords: ['第七步', '启动 Gateway', 'gateway'],           pct: 88, step: 3, label: '启动 Gateway...' },
  { keywords: ['Gateway 启动成功', '部署完成', 'DEPLOY_DONE'], pct: 100, step: 3, label: '完成！' },
]

let currentStep = -1

function setDeployStep(stepIdx) {
  if (stepIdx <= currentStep) return
  currentStep = stepIdx
  for (let i = 0; i <= 3; i++) {
    const el = document.getElementById('sdot-' + i)
    if (i < stepIdx) el.className = 'step-dot done'
    else if (i === stepIdx) el.className = 'step-dot active'
    else el.className = 'step-dot'
  }
}

function updateProgress(line) {
  const bar = document.getElementById('progress-bar')
  const label = document.getElementById('progress-label')
  for (const entry of progressMap) {
    if (entry.keywords.some(k => line.includes(k))) {
      bar.style.width = entry.pct + '%'
      label.textContent = entry.label
      setDeployStep(entry.step)
      break
    }
  }
}

function classifyLine(line) {
  if (line.includes('[成功]') || line.includes('成功') || line.includes('✅')) return 'log-success'
  if (line.includes('[警告]') || line.includes('警告') || line.includes('⚠')) return 'log-warn'
  if (line.includes('[错误]') || line.includes('错误') || line.includes('❌')) return 'log-error'
  if (line.includes('>>>') || /第[一二三四五六七]步/.test(line)) return 'log-step'
  return ''
}

function appendLog(line) {
  const box = document.getElementById('log-box')
  const el = document.createElement('div')
  const cls = classifyLine(line)
  if (cls) el.className = cls
  el.textContent = line
  box.appendChild(el)
  box.scrollTop = box.scrollHeight
}

// ============================================================
// 开始部署
// ============================================================
let gwInfo = null
let deployModelLabel = ''

document.getElementById('btn-start-deploy').addEventListener('click', () => {
  const apiKey = document.getElementById('api-key').value.trim()
  const errEl = document.getElementById('config-error')
  const testMode = document.getElementById('test-mode').checked

  if (!testMode) {
    if (!apiKey) { errEl.textContent = 'API Key 不能为空'; return }
    if (!apiKey.startsWith('sk-') && !apiKey.startsWith('sk_')) {
      errEl.textContent = 'API Key 格式不对，应以 sk- 开头'; return
    }
  }
  errEl.textContent = ''
  saveCurrentConfig()

  const provider = document.getElementById('model-provider').value
  const apiBase = document.getElementById('api-base').value.trim()
  const modelName = document.getElementById('model-name').value.trim()
  const feishuEnabled = document.getElementById('feishu-enable').checked
  const feishu = feishuEnabled ? {
    appId: document.getElementById('feishu-app-id').value.trim(),
    appSecret: document.getElementById('feishu-app-secret').value.trim(),
  } : null

  const providerLabels = { moonshot: 'Kimi (Moonshot)', deepseek: 'DeepSeek', qwen: '通义千问', anthropic: 'Claude', custom: '自定义' }
  deployModelLabel = `${providerLabels[provider] || provider} · ${modelName}`

  startDeploy({ apiKey: testMode ? 'sk-test-placeholder' : apiKey, testMode, modelProvider: provider, apiBase, modelName, feishu })
})

function startDeploy(opts) {
  showTab('deploy')
  currentStep = -1
  document.getElementById('progress-bar').style.width = '3%'
  document.getElementById('progress-label').textContent = '启动部署脚本...'
  document.getElementById('log-box').innerHTML = ''
  document.getElementById('deploy-footer').style.display = 'none'
  document.getElementById('btn-cancel').style.display = 'inline-block'
  for (let i = 0; i <= 3; i++) document.getElementById('sdot-' + i).className = 'step-dot'

  window.api.removeAllListeners('log')
  window.api.removeAllListeners('deploy-done')
  window.api.removeAllListeners('deploy-error')

  window.api.startDeploy(opts)
  window.api.onLog((line) => { appendLog(line); updateProgress(line) })

  window.api.onDone((info) => {
    gwInfo = info
    document.getElementById('progress-bar').style.width = '100%'
    document.getElementById('progress-label').textContent = '完成！'
    setDeployStep(3)
    document.getElementById('btn-cancel').style.display = 'none'
    setTimeout(() => {
      const url = `http://localhost:${info.port}?token=${info.token}`
      document.getElementById('done-model').textContent = deployModelLabel
      document.getElementById('done-url').textContent = url
      document.getElementById('done-token').textContent = info.token || '（无）'
      showTab('done')
    }, 800)
  })

  window.api.onError((msg) => {
    appendLog('[错误] ' + msg)
    document.getElementById('btn-cancel').style.display = 'none'
    document.getElementById('deploy-footer').style.display = 'flex'
  })
}

document.getElementById('btn-cancel').addEventListener('click', () => {
  document.getElementById('btn-cancel').style.display = 'none'
  appendLog('[取消] 用户取消部署')
  document.getElementById('deploy-footer').style.display = 'flex'
})

document.getElementById('btn-redeploy-from-log').addEventListener('click', () => showTab('config'))

// ============================================================
// 部署完成页
// ============================================================
document.getElementById('btn-open-web').addEventListener('click', () => {
  if (gwInfo) window.api.openUrl(`http://localhost:${gwInfo.port}?token=${gwInfo.token}`)
})
document.getElementById('btn-go-ops').addEventListener('click', () => { showTab('ops'); refreshOpsStatus() })
document.getElementById('btn-redeploy').addEventListener('click', () => showTab('config'))

// ============================================================
// Toast 通知
// ============================================================
function showToast(msg, type = 'success') {
  const el = document.getElementById('toast')
  document.getElementById('toast-msg').textContent = msg
  el.className = `toast ${type}`
  el.style.display = 'block'
  clearTimeout(el._timer)
  el._timer = setTimeout(() => { el.style.display = 'none' }, 3500)
}

// ============================================================
// 运维管理
// ============================================================
async function refreshOpsStatus() {
  const dot = document.getElementById('status-dot')
  const text = document.getElementById('status-text')
  dot.className = 'status-dot'
  text.textContent = '检测中...'
  const { running } = await window.api.opsStatus()
  dot.className = running ? 'status-dot running' : 'status-dot stopped'
  text.textContent = running ? 'Gateway 运行中（端口 18789）' : 'Gateway 已停止'
}

function showOpsMsg(msg, isError = false) {
  showToast(msg, isError ? 'error' : 'success')
}

document.getElementById('btn-refresh-status').addEventListener('click', refreshOpsStatus)

document.getElementById('btn-ops-restart').addEventListener('click', async () => {
  showOpsMsg('正在重启...')
  const r = await window.api.opsRestart()
  if (r.success) { showOpsMsg('重启成功，等待服务就绪...'); setTimeout(refreshOpsStatus, 2500) }
  else showOpsMsg('重启失败: ' + r.error, true)
})

document.getElementById('btn-ops-stop').addEventListener('click', async () => {
  const r = await window.api.opsStop()
  if (r.success) { showOpsMsg('服务已停止'); setTimeout(refreshOpsStatus, 800) }
  else showOpsMsg('停止失败: ' + r.error, true)
})

document.getElementById('btn-ops-logs').addEventListener('click', async () => {
  const { logs } = await window.api.opsGetLogs()
  const box = document.getElementById('ops-log-box')
  const label = document.getElementById('ops-log-label')
  box.textContent = logs
  box.classList.remove('hidden')
  label.style.display = ''
  box.scrollTop = box.scrollHeight
})

document.getElementById('btn-ops-uninstall').addEventListener('click', async () => {
  if (!confirm('确定要卸载 OpenClaw 吗？此操作将停止服务并删除 npm 包。')) return
  showOpsMsg('正在卸载...')
  const r = await window.api.opsUninstall()
  if (r.success) showOpsMsg('卸载完成')
  else showOpsMsg('卸载失败: ' + r.error, true)
  setTimeout(refreshOpsStatus, 1000)
})
