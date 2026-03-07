// 步骤切换
function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'))
  document.getElementById(id).classList.add('active')
}

// 进度关键词映射
const progressMap = [
  { keywords: ['第一步', '检测 Node'], pct: 10, label: '检测 Node.js 环境...' },
  { keywords: ['第二步', '安装 Node'], pct: 25, label: '安装 Node.js...' },
  { keywords: ['第三步', 'npm 镜像'], pct: 40, label: '配置 npm 镜像...' },
  { keywords: ['第四步', '安装 OpenClaw', 'npm install'], pct: 55, label: '安装 OpenClaw...' },
  { keywords: ['第五步', '填写配置'], pct: 65, label: '准备配置信息...' },
  { keywords: ['第六步', '写入', '配置文件'], pct: 78, label: '写入配置文件...' },
  { keywords: ['第七步', '启动 Gateway'], pct: 88, label: '启动 Gateway...' },
  { keywords: ['Gateway 启动成功', '部署完成', 'DEPLOY_DONE'], pct: 100, label: '完成！' },
]

function updateProgress(line) {
  const bar = document.getElementById('progress-bar')
  const label = document.getElementById('progress-label')
  for (const entry of progressMap) {
    if (entry.keywords.some(k => line.includes(k))) {
      bar.style.width = entry.pct + '%'
      label.textContent = entry.label
      break
    }
  }
}

function classifyLine(line) {
  if (line.includes('[成功]') || line.includes('成功')) return 'log-success'
  if (line.includes('[警告]') || line.includes('警告')) return 'log-warn'
  if (line.includes('[错误]') || line.includes('错误')) return 'log-error'
  if (line.includes('>>>') || line.includes('第一步') || line.includes('第二步') ||
      line.includes('第三步') || line.includes('第四步') || line.includes('第五步') ||
      line.includes('第六步') || line.includes('第七步')) return 'log-step'
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
// 欢迎页
// ============================================================
document.getElementById('btn-next-welcome').addEventListener('click', () => {
  const testMode = document.getElementById('test-mode-check').checked
  if (testMode) {
    // 测试模式跳过 API Key 输入
    startDeploy('sk-test-placeholder', true)
  } else {
    showStep('step-apikey')
  }
})

// ============================================================
// API Key 页
// ============================================================
document.getElementById('btn-back-apikey').addEventListener('click', () => showStep('step-welcome'))

document.getElementById('btn-toggle-eye').addEventListener('click', () => {
  const input = document.getElementById('api-key-input')
  input.type = input.type === 'password' ? 'text' : 'password'
})

document.getElementById('btn-next-apikey').addEventListener('click', () => {
  const key = document.getElementById('api-key-input').value.trim()
  const errEl = document.getElementById('key-error')
  if (!key) {
    errEl.textContent = 'API Key 不能为空'
    return
  }
  if (!key.startsWith('sk-')) {
    errEl.textContent = 'API Key 格式不对，应以 sk- 开头'
    return
  }
  errEl.textContent = ''
  startDeploy(key, false)
})

document.getElementById('api-key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-next-apikey').click()
})

// ============================================================
// 部署
// ============================================================
let gwInfo = null

function startDeploy(apiKey, testMode) {
  showStep('step-installing')
  document.getElementById('progress-bar').style.width = '5%'
  document.getElementById('progress-label').textContent = '启动部署脚本...'
  document.getElementById('log-box').innerHTML = ''

  window.api.startDeploy({ apiKey, testMode })

  window.api.onLog((line) => {
    appendLog(line)
    updateProgress(line)
  })

  window.api.onDone((info) => {
    gwInfo = info
    document.getElementById('progress-bar').style.width = '100%'
    document.getElementById('progress-label').textContent = '完成！'
    setTimeout(() => {
      const url = `http://localhost:${info.port}?token=${info.token}`
      document.getElementById('gw-url').textContent = url
      document.getElementById('gw-url').title = url
      showStep('step-done')
    }, 600)
  })

  window.api.onError((msg) => {
    document.getElementById('error-detail').textContent = msg
    showStep('step-error')
  })
}

// ============================================================
// 完成页
// ============================================================
document.getElementById('btn-open-web').addEventListener('click', () => {
  if (gwInfo) {
    window.api.openUrl(`http://localhost:${gwInfo.port}?token=${gwInfo.token}`)
  }
})

document.getElementById('btn-quit').addEventListener('click', () => window.close())

// ============================================================
// 错误页
// ============================================================
document.getElementById('btn-restart').addEventListener('click', () => {
  document.getElementById('api-key-input').value = ''
  document.getElementById('key-error').textContent = ''
  document.getElementById('test-mode-check').checked = false
  showStep('step-welcome')
})
