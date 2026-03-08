// ============================================================
// OpenClaw 一键部署器 — 渲染进程 (无授权版)
// ============================================================

const api = window.electronAPI

function escapeHtml(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---- 状态 ----
let currentTab = 'config'
let deployConfig = {}
let cachedGatewayToken = ''
let lastDeployState = null
let deployStartTime = null
let elapsedTimer = null
let manageBusy = false

// ============================================================
// 页签导航
// ============================================================
function switchTab(tabId) {
  currentTab = tabId
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tabId)
  })
  document.querySelectorAll('.tab-page').forEach(page => {
    page.classList.toggle('active', page.id === `page-${tabId}`)
  })
  if (tabId === 'manage') {
    refreshLastDeployCard()
    refreshStatus()
    startAgentsPoll()
  } else {
    stopAgentsPoll()
  }
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => switchTab(item.dataset.tab))
})

// ============================================================
// 系统信息
// ============================================================
async function loadSystemInfo() {
  try {
    const info = await api.system.detect()
    const grid = document.getElementById('system-info-grid')
    const platMap = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' }
    const items = [
      { label: '操作系统',   value: platMap[info.platform] || info.platform, cls: '' },
      { label: 'CPU',        value: info.cpuModel,                            cls: '' },
      { label: 'CPU 核心',   value: `${info.cpuCores} 核`,                   cls: '' },
      { label: '总内存',     value: `${info.totalMemory} GB`,                 cls: info.totalMemory < 1 ? 'warn' : 'ok' },
      { label: '可用内存',   value: `${info.freeMemory} GB`,                  cls: info.freeMemory < 0.5 ? 'warn' : 'ok' },
      { label: 'Docker',     value: info.hasDocker ? '已安装 ✓' : '未安装',  cls: info.hasDocker ? 'ok' : 'error' },
      { label: 'Node.js',    value: info.hasNode ? info.nodeSystemVersion : '未安装', cls: info.hasNode ? 'ok' : 'warn' },
      { label: '磁盘可用',   value: info.diskFreeGB ? `${info.diskFreeGB} GB` : '未知', cls: info.diskFreeGB && info.diskFreeGB < 2 ? 'warn' : 'ok' },
      { label: '端口 18789', value: info.port18789InUse ? '已占用 ⚠️' : '可用 ✓', cls: info.port18789InUse ? 'warn' : 'ok' },
    ]
    grid.innerHTML = items.map(i => `
      <div class="info-item">
        <span class="info-item-label">${i.label}</span>
        <span class="info-item-value ${i.cls}">${i.value}</span>
      </div>`).join('')
  } catch (err) {
    console.error('system detect error:', err)
  }
}

// ============================================================
// 配置页 — 部署目标 / 方式 / 镜像
// ============================================================
document.querySelectorAll('input[name="deploy-target"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const isSSH = document.querySelector('input[name="deploy-target"]:checked').value === 'ssh'
    document.getElementById('ssh-config-card').style.display = isSSH ? 'block' : 'none'
  })
})

function updateImageChoiceCard() {
  const mode = document.querySelector('input[name="deploy-mode"]:checked')?.value || 'docker'
  const card = document.getElementById('image-choice-card')
  const titleEl = card?.querySelector('h3')
  const descEl  = card?.querySelector('.feature-desc')
  if (card) card.style.display = 'block'
  if (titleEl) titleEl.textContent = mode === 'docker' ? '🐳 镜像类型' : '📦 安装版本'
  if (descEl)  descEl.textContent  = mode === 'docker'
    ? '选择要部署的 OpenClaw 镜像来源；Docker 与 Node 均可在此选择官方 / 汉化 / 中国 IM 整合版。'
    : '选择要安装的 OpenClaw 版本（npm 包）：官方英文版或汉化版；中国 IM 整合版在 Node 下使用汉化包。'
}
document.querySelectorAll('input[name="deploy-mode"]').forEach(r => r.addEventListener('change', updateImageChoiceCard))

// ============================================================
// LLM 多组配置
// ============================================================
const LLM_CONFIGS = {
  deepseek:     { baseUrl: 'https://api.deepseek.com',                              model: 'deepseek-chat' },
  qwen:         { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',     model: 'qwen-max' },
  kimi:         { baseUrl: 'https://api.moonshot.cn/v1',                            model: 'kimi-k2.5' },
  shengsuanyun: { baseUrl: 'https://api.shengsuanyun.com/v1',                       model: '' },
  anthropic:    { baseUrl: 'https://api.anthropic.com',                             model: 'claude-sonnet-4-20250514' },
  custom:       { baseUrl: '', model: '' },
}

function getLlmCards() {
  return Array.from(document.querySelectorAll('#llm-cards .llm-card'))
}

function updateLlmCardVisibility(card) {
  const val = card.querySelector('.llm-provider')?.value || ''
  const apiKeyWrap  = card.querySelector('.llm-apikey-field')
  const baseUrlWrap = card.querySelector('.llm-baseurl-field')
  if (val) {
    if (apiKeyWrap)  apiKeyWrap.style.display  = 'block'
    if (baseUrlWrap) {
      if (val === 'custom') {
        baseUrlWrap.style.display = 'block'
      } else {
        baseUrlWrap.style.display = 'none'
        const input = card.querySelector('.llm-baseurl')
        if (input) input.value = LLM_CONFIGS[val]?.baseUrl || ''
      }
    }
  } else {
    if (apiKeyWrap)  apiKeyWrap.style.display  = 'none'
    if (baseUrlWrap) baseUrlWrap.style.display = 'none'
  }
}

function addLlmCard() {
  const container = document.getElementById('llm-cards')
  const first = container?.querySelector('.llm-card')
  if (!container || !first) return
  const clone = first.cloneNode(true)
  clone.querySelector('.llm-provider').value = ''
  clone.querySelector('.llm-apikey').value   = ''
  clone.querySelector('.llm-baseurl').value  = ''
  clone.removeAttribute('data-llm-index')
  updateLlmCardVisibility(clone)
  container.appendChild(clone)
}

function removeLlmCard(cardEl) {
  if (getLlmCards().length <= 1) return
  cardEl.remove()
}

function moveLlmCard(cardEl, up) {
  const cards = getLlmCards()
  const i = cards.indexOf(cardEl)
  if (i < 0) return
  const j = up ? i - 1 : i + 1
  if (j < 0 || j >= cards.length) return
  const container = document.getElementById('llm-cards')
  if (up) container.insertBefore(cardEl, cards[j])
  else    container.insertBefore(cardEl, cards[j].nextSibling)
}

document.getElementById('llm-add-card').addEventListener('click', addLlmCard)

document.getElementById('llm-cards').addEventListener('change', e => {
  if (e.target.classList.contains('llm-provider')) {
    const card = e.target.closest('.llm-card')
    if (card) updateLlmCardVisibility(card)
  }
})

document.getElementById('llm-cards').addEventListener('click', e => {
  const card = e.target.closest('.llm-card')
  if (!card) return
  if (e.target.classList.contains('llm-move-up'))   moveLlmCard(card, true)
  else if (e.target.classList.contains('llm-move-down')) moveLlmCard(card, false)
  else if (e.target.classList.contains('llm-remove'))    removeLlmCard(card)
})

function collectLlmsFromForm() {
  return getLlmCards().map(card => {
    const provider = card.querySelector('.llm-provider')?.value || ''
    const apiKey   = card.querySelector('.llm-apikey')?.value?.trim() || ''
    const baseUrl  = card.querySelector('.llm-baseurl')?.value?.trim() || ''
    const cfg = LLM_CONFIGS[provider] || {}
    return { provider, apiKey, baseUrl: baseUrl || cfg.baseUrl, modelId: cfg.model }
  })
}

function loadLlmsIntoForm(llms) {
  if (!llms?.length) return
  const container = document.getElementById('llm-cards')
  const first = container?.querySelector('.llm-card')
  if (!first || !container) return
  const template = first.cloneNode(true)
  container.innerHTML = ''
  for (const item of llms) {
    const card = template.cloneNode(true)
    card.querySelector('.llm-provider').value = item.provider || ''
    card.querySelector('.llm-apikey').value   = item.apiKey   || ''
    card.querySelector('.llm-baseurl').value  = item.baseUrl  || ''
    updateLlmCardVisibility(card)
    container.appendChild(card)
  }
}

// ============================================================
// 飞书通道
// ============================================================
document.getElementById('feishu-enabled').addEventListener('change', e => {
  document.getElementById('feishu-config-fields').style.display = e.target.checked ? 'block' : 'none'
})

document.getElementById('link-feishu-open').addEventListener('click', e => {
  e.preventDefault()
  api.shell.openExternal('https://open.feishu.cn/app')
})

// ============================================================
// 技能管理
// ============================================================
function getPluginsConfig() {
  const target = document.querySelector('input[name="deploy-target"]:checked')?.value || 'local'
  const mode   = document.querySelector('input[name="deploy-mode"]:checked')?.value   || 'docker'
  const config = { target, mode }
  if (target === 'ssh') {
    const host     = document.getElementById('ssh-host')?.value?.trim()
    const username = document.getElementById('ssh-username')?.value?.trim()
    if (host && username) {
      config.ssh = {
        host,
        port:     parseInt(document.getElementById('ssh-port')?.value, 10) || 22,
        username,
        password: document.getElementById('ssh-password')?.value || '',
      }
    }
  }
  return config
}

async function refreshPluginsList() {
  const listEl        = document.getElementById('plugins-list')
  const placeholderEl = document.getElementById('plugins-placeholder')
  const config = getPluginsConfig()
  if (config.target === 'ssh' && (!config.ssh?.host || !config.ssh?.username)) {
    placeholderEl.textContent = '远程管理请先填写 SSH 连接信息'
    placeholderEl.style.display = 'block'
    listEl.innerHTML = ''
    return
  }
  placeholderEl.textContent = '加载中...'
  placeholderEl.style.display = 'block'
  listEl.innerHTML = ''
  try {
    const result = await api.plugins.list(config)
    placeholderEl.style.display = 'none'
    if (!result.success) {
      placeholderEl.textContent = result.error || '获取列表失败，请确认已部署 OpenClaw'
      placeholderEl.style.display = 'block'
      return
    }
    const list = result.list || []
    if (list.length === 0) {
      placeholderEl.textContent = '暂无已安装插件'
      placeholderEl.style.display = 'block'
      return
    }
    list.forEach(name => {
      const row = document.createElement('div')
      row.className = 'plugin-item'
      row.innerHTML = `<span class="plugin-item-name">${escapeHtml(name)}</span><button type="button" class="btn btn-sm btn-ghost btn-plugin-uninstall" data-name="${escapeHtml(name)}">卸载</button>`
      listEl.appendChild(row)
    })
    listEl.querySelectorAll('.btn-plugin-uninstall').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-name')
        if (!name) return
        btn.disabled = true
        const res = await api.plugins.uninstall(config, name)
        if (res.success) { showToast('已卸载 ' + name); refreshPluginsList() }
        else { showToast(res.error || '卸载失败', 'error'); btn.disabled = false }
      })
    })
  } catch (err) {
    placeholderEl.textContent = err.message || '加载失败'
    placeholderEl.style.display = 'block'
  }
}

document.getElementById('btn-plugins-refresh').addEventListener('click', () => refreshPluginsList())

document.getElementById('link-plugins-npm').addEventListener('click', e => {
  e.preventDefault()
  api.shell.openExternal('https://www.npmjs.com/search?q=openclaw')
})

document.querySelectorAll('.plugin-example').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.getAttribute('data-plugin')
    const input = document.getElementById('plugin-name-input')
    if (name && input) input.value = name
  })
})

document.getElementById('btn-plugin-install').addEventListener('click', async () => {
  const input = document.getElementById('plugin-name-input')
  const name  = (input?.value || '').trim()
  if (!name) { showToast('请输入插件包名', 'error'); return }
  if (!name.includes('@') && !name.includes('/')) {
    showToast('该名称像是 ClawHub 技能名，请使用下方「ClawHub 安装」按钮', 'error'); return
  }
  const config = getPluginsConfig()
  if (config.target === 'ssh' && (!config.ssh?.host || !config.ssh?.username)) {
    showToast('远程安装请先填写 SSH 连接信息', 'error'); return
  }
  const btn = document.getElementById('btn-plugin-install')
  const oldText = btn.textContent
  btn.disabled = true; btn.textContent = '安装中...'
  try {
    const res = await api.plugins.install(config, name)
    if (res.success) { showToast('安装成功'); input.value = ''; refreshPluginsList() }
    else showToast(res.error || '安装失败', 'error')
  } catch (err) { showToast(err.message || '安装失败', 'error') }
  btn.disabled = false; btn.textContent = oldText
})

// ============================================================
// 开始部署按钮
// ============================================================
document.getElementById('link-clawhub-site').addEventListener('click', e => {
  e.preventDefault()
  api.shell.openExternal('https://clawhub.ai')
})

document.getElementById('btn-plugins-fix-allow').addEventListener('click', async () => {
  const config = getPluginsConfig()
  if (config.target === 'ssh' && (!config.ssh?.host || !config.ssh?.username)) {
    showToast('远程操作请先填写 SSH 连接信息', 'error'); return
  }
  const btn = document.getElementById('btn-plugins-fix-allow')
  btn.disabled = true
  try {
    const res = await api.plugins.setClawhubAllowed(config)
    if (res.success) showToast('已设置 plugins.allow，可继续使用 ClawHub 安装')
    else showToast(res.error || '设置失败', 'error')
  } catch (err) { showToast(err.message || '设置失败', 'error') }
  btn.disabled = false
})

document.getElementById('btn-clawhub-install').addEventListener('click', async () => {
  const input     = document.getElementById('clawhub-skill-input')
  const skillName = (input?.value || '').trim()
  if (!skillName) { showToast('请输入 ClawHub 技能名（如 sonoscli）', 'error'); return }
  const config = getPluginsConfig()
  if (config.target === 'ssh' && (!config.ssh?.host || !config.ssh?.username)) {
    showToast('远程安装请先填写 SSH 连接信息', 'error'); return
  }
  const btn = document.getElementById('btn-clawhub-install')
  const oldText = btn.textContent
  btn.disabled = true; btn.textContent = '安装中...'
  try {
    const res = await api.clawhub.install(config, skillName)
    if (res.success) { showToast('ClawHub 技能安装成功'); input.value = ''; refreshPluginsList() }
    else showToast(res.error || '安装失败', 'error')
  } catch (err) { showToast(err.message || '安装失败', 'error') }
  btn.disabled = false; btn.textContent = oldText
})

document.getElementById('btn-start-deploy').addEventListener('click', async () => {
  const btn = document.getElementById('btn-start-deploy')
  try {
    const target      = document.querySelector('input[name="deploy-target"]:checked')?.value ?? 'local'
    const mode        = document.querySelector('input[name="deploy-mode"]:checked')?.value   ?? 'docker'
    const imageChoice = document.querySelector('input[name="image-choice"]:checked')?.value  ?? 'hanhua'
    const proxyUrl    = document.getElementById('network-proxy')?.value.trim() || ''
    const llms        = collectLlmsFromForm()

    deployConfig = { target, mode, proxy: proxyUrl, imageChoice, llms, llm: llms[0] || {} }

    if (target === 'ssh') {
      const host     = document.getElementById('ssh-host').value.trim()
      const port     = parseInt(document.getElementById('ssh-port').value) || 22
      const username = document.getElementById('ssh-username').value.trim()
      if (!host)     { showToast('SSH 主机地址不能为空', 'error'); return }
      if (!username) { showToast('SSH 用户名不能为空', 'error'); return }
      if (port < 1 || port > 65535) { showToast('SSH 端口范围必须在 1-65535 之间', 'error'); return }
      deployConfig.ssh = { host, port, username, password: document.getElementById('ssh-password').value }
    }

    const hasProvider = llms.some(m => m.provider)
    const hasAnyKey   = llms.some(m => m.apiKey)
    if (hasProvider && !hasAnyKey) { showToast('请至少为一个模型填写 API Key', 'error'); return }

    const feishuEnabled = document.getElementById('feishu-enabled').checked
    if (feishuEnabled) {
      const appId     = document.getElementById('feishu-appid').value.trim()
      const appSecret = document.getElementById('feishu-appsecret').value.trim()
      if (!appId || !appSecret) { showToast('已启用飞书通道，请填写 App ID 和 App Secret', 'error'); return }
      deployConfig.feishu = {
        appId, appSecret,
        encryptKey:        document.getElementById('feishu-encryptkey').value.trim()  || undefined,
        verificationToken: document.getElementById('feishu-verifytoken').value.trim() || undefined,
      }
    }

    saveCurrentConfig()

    btn.disabled = true; btn.textContent = '检查中...'
    try {
      const check = await api.deploy.preflight(deployConfig)
      if (!check.ok) {
        const msg = check.issues.join('\n')
        showToast(check.issues[0], 'error')
        if (!confirm(`发现以下问题：\n\n${msg}\n\n是否仍然继续部署？`)) {
          btn.disabled = false; btn.textContent = '🚀 开始部署'; return
        }
      }
      // 旧版残留警告
      const oldClawWarning = (check.warnings || []).find(w => w.code === 'OLD_OPENCLAW')
      if (oldClawWarning) {
        const choice = await showOldClawDialog(oldClawWarning.message)
        if (choice === 'cancel') { btn.disabled = false; btn.textContent = '🚀 开始部署'; return }
        if (choice === 'uninstall') {
          btn.textContent = '卸载旧版中...'
          const r = await api.deploy.uninstallOld()
          r.results.forEach(line => console.log(line))
          showToast('旧版已卸载，继续部署', 'success')
        }
        // choice === 'continue' 直接继续
      }
    } catch { /* 预检失败不阻塞 */ }
    btn.disabled = false; btn.textContent = '🚀 开始部署'

    switchTab('deploy')
    startDeploy()
  } catch (err) {
    showToast('开始部署失败: ' + (err?.message || err), 'error')
    btn.disabled = false; btn.textContent = '🚀 开始部署'
  }
})

// ============================================================
// 部署页
// ============================================================
function startDeploy() {
  try {
    document.getElementById('deploy-log-output').innerHTML = ''
    document.getElementById('deploy-error-card').style.display = 'none'
    document.getElementById('deploy-progress-bar').style.width = '0%'
    document.getElementById('deploy-progress-text').textContent = '准备中... 0%'
    document.getElementById('deploy-elapsed').textContent = ''
    document.getElementById('deploy-steps-list').innerHTML = ''

    const substepCard = document.getElementById('substep-card')
    substepCard.style.display = 'none'
    document.getElementById('substep-timeline').innerHTML = ''
    const substepBadge = document.getElementById('substep-badge')
    substepBadge.textContent = '进行中'
    substepBadge.className = 'substep-badge'

    const mirrorCard = document.getElementById('mirror-card')
    mirrorCard.style.display = 'none'
    document.getElementById('mirror-list').innerHTML = ''

    deployStartTime = Date.now()
    clearInterval(elapsedTimer)
    elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - deployStartTime) / 1000)
      const m = Math.floor(sec / 60), s = sec % 60
      const el = document.getElementById('deploy-elapsed')
      if (el) el.textContent = `${m}:${String(s).padStart(2, '0')}`
    }, 1000)

    api.deploy.removeAllListeners()

    api.deploy.onProgress(data => {
      updateProgressBar(data.progress)
      updateStepsList(data)
    })

    api.deploy.onLog(msg => {
      appendLog(msg, classifyLogLine(msg))
      parseSubstep(msg)
      parseMirrorInfo(msg)
    })

    api.deploy.onError(data => {
      clearInterval(elapsedTimer)
      document.getElementById('deploy-cancel-area').style.display = 'none'
      appendLog(`错误: ${data.error}`, 'error')
      if (data.diagnosis) appendLog(data.diagnosis, 'warn')
      document.getElementById('deploy-error-card').style.display = 'block'
      document.getElementById('deploy-error-message').textContent = data.error
      document.getElementById('deploy-error-diagnosis').textContent = data.diagnosis || ''
      const badge = document.getElementById('substep-badge')
      if (substepCard.style.display !== 'none') {
        badge.textContent = '失败'; badge.className = 'substep-badge error'
      }
    })

    api.deploy.onComplete(data => {
      clearInterval(elapsedTimer)
      document.getElementById('deploy-cancel-area').style.display = 'none'
      updateProgressBar(100)
      appendLog('部署完成！', 'success')

      document.getElementById('deploy-url').textContent = data.url
      if (data.token) {
        cachedGatewayToken = data.token
        document.getElementById('deploy-token').textContent = data.token
        document.getElementById('token-row').style.display = 'flex'
        document.getElementById('token-tip').style.display = 'block'
        const masked = data.token.length > 6 ? data.token.slice(0, 6) + '***' : '***'
        appendLog(`网关令牌: ${masked}（完整令牌请在上方复制）`, 'info')
      }
      if (deployConfig.feishu) {
        const tipFeishu = document.getElementById('tip-feishu')
        if (tipFeishu) tipFeishu.style.display = 'list-item'
      }

      const deployState = {
        target: deployConfig.target || 'local',
        mode:   deployConfig.mode   || 'docker',
        url:    data.url,
        token:  data.token || '',
        timestamp:   new Date().toISOString(),
        imageChoice: deployConfig.imageChoice,
        lastStatus:  'running',
      }
      if (deployConfig.target === 'ssh' && deployConfig.ssh) {
        deployState.sshDisplay = {
          host:     deployConfig.ssh.host,
          port:     deployConfig.ssh.port || 22,
          username: deployConfig.ssh.username,
        }
      }
      api.deployState.save(deployState).catch(() => {})

      setTimeout(() => switchTab('complete'), 1500)
    })

    document.getElementById('deploy-cancel-area').style.display = 'flex'
    api.deploy.execute(deployConfig)
    appendLog(`开始部署... 模式: ${deployConfig.mode}, 目标: ${deployConfig.target}`, 'info')
  } catch (err) {
    appendLog('错误: ' + (err?.message || err), 'error')
    showToast('部署启动失败: ' + (err?.message || err), 'error')
    document.getElementById('deploy-error-card').style.display = 'block'
    document.getElementById('deploy-error-message').textContent = err?.message || String(err)
    document.getElementById('deploy-error-diagnosis').textContent = '请重启应用后重试。'
  }
}

function classifyLogLine(msg) {
  if (msg.startsWith('✓') || msg.startsWith('✅')) return 'success'
  if (msg.startsWith('❌')) return 'error'
  if (msg.startsWith('⚠'))  return 'warn'
  return 'info'
}

function parseSubstep(msg) {
  const card     = document.getElementById('substep-card')
  const timeline = document.getElementById('substep-timeline')
  const badge    = document.getElementById('substep-badge')

  const stepMatch = msg.match(/\[(\d+)\/(\d+)\]\s*(.+)/)
  if (stepMatch) {
    card.style.display = 'block'
    const [, current, total, label] = stepMatch
    timeline.querySelectorAll('.substep-item.active').forEach(el => { el.className = 'substep-item done' })
    const item = document.createElement('div')
    item.className = 'substep-item active'
    item.dataset.step = current
    item.innerHTML = `<span class="substep-dot"></span><div class="substep-content"><span class="substep-label">${escapeHtml(label.trim())}</span></div>`
    timeline.appendChild(item)
    badge.textContent = parseInt(current) === parseInt(total) ? '即将完成' : `${current} / ${total}`
    return
  }

  if (card.style.display !== 'none') {
    if (msg.startsWith('✓') && (msg.includes('安装') || msg.includes('启动') || msg.includes('配置') || msg.includes('Colima') || msg.includes('Homebrew') || msg.includes('Docker'))) {
      timeline.querySelectorAll('.substep-item.active').forEach(el => { el.className = 'substep-item done' })
      if (msg.includes('安装成功') || msg.includes('启动成功') || msg.includes('已预配置') || msg.includes('就绪')) {
        badge.textContent = '完成'; badge.className = 'substep-badge done'
      }
    }
    if (msg.startsWith('⏳') || msg.startsWith('  |')) {
      const activeItem = timeline.querySelector('.substep-item.active .substep-content')
      if (activeItem) {
        let detail = activeItem.querySelector('.substep-detail')
        if (!detail) { detail = document.createElement('span'); detail.className = 'substep-detail'; activeItem.appendChild(detail) }
        detail.textContent = msg.replace(/^⏳\s*/, '').substring(0, 80)
      }
    }
  }
}

function parseMirrorInfo(msg) {
  const card   = document.getElementById('mirror-card')
  const list   = document.getElementById('mirror-list')
  const status = document.getElementById('mirror-status')

  if (msg.includes('测速') && msg.includes('镜像')) {
    card.style.display = 'block'
    status.textContent = '测速中...'; status.className = 'mirror-status'
    list.innerHTML = '<div class="mirror-item"><span style="color:var(--text-muted);font-size:12px">正在并行测试多个国内镜像源延迟...</span></div>'
    return
  }
  const bestMatch = msg.match(/已选定最快镜像源:\s*(.+)/)
  if (bestMatch) {
    const bestUrl = bestMatch[1].trim()
    status.textContent = '已就绪'; status.className = 'mirror-status ready'
    list.innerHTML = `<div class="mirror-item best"><span class="mirror-rank">1</span><span class="mirror-url">${escapeHtml(bestUrl)}</span><span class="mirror-latency">最快</span></div>`
    return
  }
  if (msg.includes('国内镜像源已预配置') || msg.includes('镜像源已配置')) {
    if (card.style.display === 'none') card.style.display = 'block'
    status.textContent = '已配置'; status.className = 'mirror-status ready'
    if (list.children.length === 0) {
      list.innerHTML = `<div class="mirror-item best"><span class="mirror-rank">✓</span><span class="mirror-url">国内多源加速已启用</span><span class="mirror-latency" style="color:var(--success)">就绪</span></div>`
    }
  }
}

function updateProgressBar(percent) {
  document.getElementById('deploy-progress-bar').style.width = `${percent}%`
  document.getElementById('deploy-progress-text').textContent = `${getProgressLabel(percent)} ${percent}%`
}

function getProgressLabel(p) {
  if (p < 15)  return '准备环境...'
  if (p < 35)  return '安装组件...'
  if (p < 55)  return '拉取镜像...'
  if (p < 75)  return '配置服务...'
  if (p < 100) return '即将完成...'
  return '部署完成！'
}

function updateStepsList(data) {
  const list = document.getElementById('deploy-steps-list')
  let item = document.getElementById(`step-${data.step}`)
  if (!item) {
    item = document.createElement('div')
    item.id = `step-${data.step}`
    item.className = 'step-item'
    item.innerHTML = `<span class="step-icon">⏳</span><span class="step-label">${escapeHtml(data.label)}</span>`
    list.appendChild(item)
  }
  item.className = `step-item ${data.status}`
  const icon = item.querySelector('.step-icon')
  if (data.status === 'running') { icon.textContent = '⏳'; item.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }
  else if (data.status === 'done')  icon.textContent = '✅'
  else if (data.status === 'error') icon.textContent = '❌'
}

function appendLog(text, type = 'info') {
  const logOutput = document.getElementById('deploy-log-output')
  const time = new Date().toLocaleTimeString('zh-CN')
  const line = document.createElement('p')
  line.className = `log-line log-${type}`
  line.textContent = `[${time}] ${text}`
  logOutput.appendChild(line)
  logOutput.scrollTop = logOutput.scrollHeight
}

document.getElementById('btn-clear-log').addEventListener('click', () => {
  document.getElementById('deploy-log-output').innerHTML = ''
})

document.getElementById('btn-toggle-log').addEventListener('click', () => {
  document.querySelector('.log-card').classList.toggle('expanded')
})

document.getElementById('btn-cancel-deploy').addEventListener('click', async () => {
  if (confirm('确认取消当前部署？已完成的步骤不会回滚。')) {
    await api.deploy.cancel()
    clearInterval(elapsedTimer)
    appendLog('⚠ 用户取消了部署', 'warn')
    document.getElementById('deploy-cancel-area').style.display = 'none'
  }
})

document.getElementById('btn-retry-deploy').addEventListener('click', () => startDeploy())

// ============================================================
// 完成页
// ============================================================
document.getElementById('btn-open-dashboard').addEventListener('click', () => {
  const url = document.getElementById('deploy-url').textContent
  api.shell.openExternal(url)
})

document.getElementById('btn-copy-url').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('deploy-url').textContent)
  showToast('地址已复制到剪贴板')
})

document.getElementById('btn-copy-token').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('deploy-token').textContent)
  showToast('令牌已复制到剪贴板')
})

document.getElementById('btn-export-config').addEventListener('click', async () => {
  const result = await api.manage.exportConfig()
  if (result.success) showToast(`配置已导出到 ${result.path}`)
  else showToast('导出失败: ' + result.error, 'error')
})

// ============================================================
// 管理页
// ============================================================
const IMAGE_CHOICE_LABELS = { official: '官方', hanhua: '汉化版', 'cn-im': '中国 IM 整合版' }

async function refreshLastDeployCard() {
  const card   = document.getElementById('last-deploy-card')
  const noCard = document.getElementById('no-deploy-card')
  const infoEl = document.getElementById('last-deploy-info')
  if (!card || !noCard || !infoEl) return
  try {
    const state = await api.deployState.load()
    lastDeployState = state
    if (!state || !state.target) {
      card.style.display = 'none'; noCard.style.display = 'block'; return
    }
    noCard.style.display = 'none'; card.style.display = 'block'
    const targetLabel = state.target === 'local' ? '本机' : (state.sshDisplay ? `${state.sshDisplay.host}:${state.sshDisplay.port || 22}` : '远程')
    const modeLabel   = state.mode === 'docker' ? 'Docker' : 'Node'
    const imageLabel  = state.imageChoice ? (IMAGE_CHOICE_LABELS[state.imageChoice] || state.imageChoice) : ''
    const statusLabel = state.lastStatus === 'running' ? '运行中' : state.lastStatus === 'not_found' ? '未部署' : state.lastStatus === 'exited' ? '已停止' : (state.lastStatus || '未知')
    const lines = [
      `目标：${targetLabel}`,
      `方式：${modeLabel}${imageLabel ? ' · ' + imageLabel : ''}`,
      `状态：${statusLabel}`,
      state.url ? `地址：${state.url}` : '',
    ].filter(Boolean)
    infoEl.innerHTML = lines.map(l => `<div class="last-deploy-line">${escapeHtml(l)}</div>`).join('')
  } catch {
    lastDeployState = null; noCard.style.display = 'block'; card.style.display = 'none'
  }
}

document.getElementById('btn-last-deploy-open').addEventListener('click', () => {
  let url = ''
  if (lastDeployState?.url) {
    url = lastDeployState.url.includes('#token=') ? lastDeployState.url
      : (cachedGatewayToken ? `${lastDeployState.url}/#token=${cachedGatewayToken}` : lastDeployState.url)
  } else {
    const base = deployConfig.target === 'ssh' && deployConfig.ssh ? `http://${deployConfig.ssh.host}:18789` : 'http://127.0.0.1:18789'
    url = cachedGatewayToken ? `${base}/#token=${cachedGatewayToken}` : base
  }
  api.shell.openExternal(url)
})
document.getElementById('btn-last-deploy-config').addEventListener('click', () => switchTab('config'))
document.getElementById('btn-no-deploy-config').addEventListener('click',   () => switchTab('config'))

async function refreshStatus() {
  try {
    const result = await api.manage.status(deployConfig)
    const dot  = document.getElementById('status-dot')
    const text = document.getElementById('status-text')
    if (result.token) cachedGatewayToken = result.token
    if (result.running) {
      dot.className = 'status-dot running'; text.textContent = '运行中'
    } else {
      dot.className = 'status-dot stopped'
      text.textContent = result.status === 'not_found' ? '未部署' : `已停止 (${result.status})`
    }
  } catch {
    document.getElementById('status-dot').className = 'status-dot stopped'
    document.getElementById('status-text').textContent = '无法检测'
  }
}

document.getElementById('btn-refresh-status').addEventListener('click', refreshStatus)

// ============================================================
// Agent 心跳监测
// ============================================================
let agentsPollTimer = null

function formatIdleTime(sec) {
  if (sec === null || sec === undefined) return '未知'
  if (sec < 60) return `${sec}秒前`
  if (sec < 3600) return `${Math.floor(sec / 60)}分钟前`
  return `${Math.floor(sec / 3600)}小时前`
}

function agentStatusLabel(agent) {
  if (agent.status === 'running' || agent.status === 'active') return { cls: 'agent-dot running', text: '运行中' }
  if (agent.status === 'idle' || (agent.idleSec !== null && agent.idleSec > 300)) return { cls: 'agent-dot idle', text: '空闲/可能超时' }
  if (agent.status === 'error' || agent.status === 'failed') return { cls: 'agent-dot error', text: '异常' }
  if (agent.status === 'stopped') return { cls: 'agent-dot stopped', text: '已停止' }
  return { cls: 'agent-dot idle', text: agent.status || '未知' }
}

async function refreshAgents() {
  const wrap = document.getElementById('agents-list-wrap')
  const empty = document.getElementById('agents-empty')
  if (!wrap) return

  const cfg = { ...deployConfig }
  if (lastDeployState?.token) cfg.token = lastDeployState.token

  try {
    const result = await api.manage.agents(cfg)
    if (!result.online || !result.agents.length) {
      wrap.innerHTML = ''
      const msg = document.createElement('div')
      msg.className = 'agents-empty'
      msg.textContent = result.online ? '暂无运行中的 Agent' : '服务未运行或无法连接'
      wrap.appendChild(msg)
      return
    }

    wrap.innerHTML = result.agents.map(a => {
      const { cls, text } = agentStatusLabel(a)
      const idleWarn = a.idleSec !== null && a.idleSec > 300
      return `<div class="agent-row${idleWarn ? ' agent-warn' : ''}">
        <span class="${cls}"></span>
        <div class="agent-info">
          <span class="agent-name">${a.name}</span>
          ${a.task ? `<span class="agent-task">${a.task}</span>` : ''}
          ${a.model ? `<span class="agent-model">${a.model}</span>` : ''}
        </div>
        <div class="agent-meta">
          <span class="agent-status-text">${text}</span>
          <span class="agent-last-active">${a.lastActive ? '活跃：' + formatIdleTime(a.idleSec) : ''}</span>
          ${idleWarn ? '<span class="agent-timeout-badge">⚠ 超时</span>' : ''}
        </div>
      </div>`
    }).join('')
  } catch {
    wrap.innerHTML = '<div class="agents-empty">检测失败</div>'
  }
}

function startAgentsPoll() {
  stopAgentsPoll()
  refreshAgents()
  agentsPollTimer = setInterval(refreshAgents, 15000)
  const badge = document.getElementById('agents-poll-badge')
  if (badge) badge.textContent = '每15秒刷新'
}

function stopAgentsPoll() {
  if (agentsPollTimer) { clearInterval(agentsPollTimer); agentsPollTimer = null }
}

document.getElementById('btn-refresh-agents').addEventListener('click', refreshAgents)

async function manageAction(action, confirmMsg) {
  if (manageBusy) { showToast('操作进行中，请稍候...', 'error'); return }
  if (confirmMsg && !confirm(confirmMsg)) return
  manageBusy = true
  const btns = document.querySelectorAll('.action-grid .action-btn')
  btns.forEach(b => { b.disabled = true; b.style.opacity = '0.6' })
  const statusText = document.getElementById('status-text')
  const actionLabels = { restart: '重启', stop: '停止', update: '更新', uninstall: '卸载' }
  statusText.textContent = `正在${actionLabels[action] || '执行'}...`
  try {
    let result
    switch (action) {
      case 'restart':      result = await api.manage.restart(deployConfig);  break
      case 'stop':         result = await api.manage.stop(deployConfig);     break
      case 'update':       result = await api.manage.update(deployConfig);   break
      case 'uninstall':    result = await api.manage.uninstall();            break
      case 'exportConfig':
        result = await api.manage.exportConfig()
        if (result.success) { showToast(`配置已导出到 ${result.path}`); return }
        break
      case 'exportLogs':
        result = await api.manage.exportLogs()
        if (result.success) { showToast(`日志已导出到 ${result.path}`); return }
        break
    }
    if (result?.success) { showToast(result.message || '操作成功'); refreshStatus() }
    else showToast('操作失败: ' + (result?.error || '未知错误'), 'error')
  } catch (err) {
    showToast('操作异常: ' + err.message, 'error')
  } finally {
    manageBusy = false
    btns.forEach(b => { b.disabled = false; b.style.opacity = '1' })
    refreshStatus()
  }
}

document.getElementById('btn-manage-restart').addEventListener('click',       () => manageAction('restart',   '确认重启 OpenClaw 服务？'))
document.getElementById('btn-manage-stop').addEventListener('click',          () => manageAction('stop',      '确认停止 OpenClaw 服务？'))
document.getElementById('btn-manage-update').addEventListener('click',        () => manageAction('update',    '确认更新到最新版本？这将重启服务'))
document.getElementById('btn-manage-uninstall').addEventListener('click',     () => manageAction('uninstall', '⚠️ 确认完全卸载？这将删除所有 OpenClaw 数据！'))
document.getElementById('btn-manage-export-config').addEventListener('click', () => manageAction('exportConfig'))
document.getElementById('btn-manage-export-logs').addEventListener('click',   () => manageAction('exportLogs'))

document.getElementById('btn-manage-approve-devices').addEventListener('click', async () => {
  try {
    const result = await api.manage.approveDevices()
    if (result.success) showToast('已批准所有待审设备，请刷新 Dashboard 页面')
    else showToast('设备批准失败: ' + (result.error || '未知错误'), 'error')
  } catch (err) { showToast('操作失败: ' + err.message, 'error') }
})

document.getElementById('btn-manage-open').addEventListener('click', () => {
  const base = deployConfig.target === 'ssh' && deployConfig.ssh ? `http://${deployConfig.ssh.host}:18789` : 'http://127.0.0.1:18789'
  const url  = cachedGatewayToken ? `${base}/#token=${cachedGatewayToken}` : base
  api.shell.openExternal(url)
})

// ============================================================
// 旧版 openclaw 残留对话框
// ============================================================
function showOldClawDialog(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center'
    overlay.innerHTML = `
      <div style="background:var(--surface,#1e1e2e);border:1px solid var(--border,#333);border-radius:12px;padding:28px 32px;max-width:420px;width:90%">
        <div style="font-size:15px;font-weight:600;margin-bottom:10px;color:var(--warning,#f59e0b)">⚠ 检测到旧版 OpenClaw</div>
        <div style="font-size:13px;color:var(--text-secondary,#aaa);line-height:1.6;margin-bottom:20px">${message}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button id="dlg-uninstall" style="flex:1;padding:9px 0;border-radius:8px;border:none;background:var(--primary,#6366f1);color:#fff;font-size:13px;cursor:pointer">卸载旧版后继续</button>
          <button id="dlg-continue" style="flex:1;padding:9px 0;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:var(--text,#eee);font-size:13px;cursor:pointer">忽略，直接继续</button>
          <button id="dlg-cancel" style="flex:1;padding:9px 0;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:var(--text-secondary,#aaa);font-size:13px;cursor:pointer">取消</button>
        </div>
      </div>`
    document.body.appendChild(overlay)
    const cleanup = (choice) => { document.body.removeChild(overlay); resolve(choice) }
    overlay.querySelector('#dlg-uninstall').onclick = () => cleanup('uninstall')
    overlay.querySelector('#dlg-continue').onclick = () => cleanup('continue')
    overlay.querySelector('#dlg-cancel').onclick = () => cleanup('cancel')
  })
}

// ============================================================
// Toast
// ============================================================
function showToast(message, type = 'success') {
  const toast = document.getElementById('manage-toast')
  const msgEl = document.getElementById('toast-message')
  if (!toast || !msgEl) return
  msgEl.textContent = message
  toast.className = `toast ${type}`
  toast.style.display = 'block'
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => { toast.style.display = 'none' }, 3000)
}

// ============================================================
// 配置持久化
// ============================================================
async function loadSavedConfig() {
  try {
    const saved = await api.config.load()
    if (!saved) return
    if (saved.target) {
      const r = document.querySelector(`input[name="deploy-target"][value="${saved.target}"]`)
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })) }
    }
    if (saved.mode) {
      const r = document.querySelector(`input[name="deploy-mode"][value="${saved.mode}"]`)
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })) }
    }
    if (saved.imageChoice) {
      const r = document.querySelector(`input[name="image-choice"][value="${saved.imageChoice}"]`)
      if (r) r.checked = true
    }
    if (saved.ssh) {
      if (saved.ssh.host)     document.getElementById('ssh-host').value     = saved.ssh.host
      if (saved.ssh.port)     document.getElementById('ssh-port').value     = saved.ssh.port
      if (saved.ssh.username) document.getElementById('ssh-username').value = saved.ssh.username
    }
    if (saved.proxy) {
      const el = document.getElementById('network-proxy')
      if (el) el.value = saved.proxy
    }
    if (saved.llms?.length) {
      loadLlmsIntoForm(saved.llms)
    } else if (saved.llm && (saved.llm.provider || saved.llm.apiKey)) {
      loadLlmsIntoForm([{ provider: saved.llm.provider || '', apiKey: saved.llm.apiKey || '', baseUrl: saved.llm.baseUrl || '' }])
    }
    if (saved.feishu) {
      document.getElementById('feishu-enabled').checked = true
      document.getElementById('feishu-enabled').dispatchEvent(new Event('change'))
      if (saved.feishu.appId)             document.getElementById('feishu-appid').value       = saved.feishu.appId
      if (saved.feishu.appSecret)         document.getElementById('feishu-appsecret').value   = saved.feishu.appSecret
      if (saved.feishu.encryptKey)        document.getElementById('feishu-encryptkey').value  = saved.feishu.encryptKey
      if (saved.feishu.verificationToken) document.getElementById('feishu-verifytoken').value = saved.feishu.verificationToken
    }
  } catch { /* 首次使用 */ }
}

function saveCurrentConfig() {
  api.config.save(deployConfig).catch(() => {})
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  loadSystemInfo()
  loadSavedConfig()
  updateImageChoiceCard()

  try {
    const lastDeploy = await api.deployState.load()
    if (lastDeploy?.target) {
      deployConfig.target = lastDeploy.target
      deployConfig.mode   = lastDeploy.mode
      if (lastDeploy.imageChoice) deployConfig.imageChoice = lastDeploy.imageChoice
      if (lastDeploy.token)       cachedGatewayToken       = lastDeploy.token
    }
  } catch { /* 无历史部署记录 */ }
})
