#Requires -Version 5.1
# OpenClaw 自动部署脚本 - Windows PowerShell 版本

# 设置 UTF-8 编码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

# ============================================================
# 工具函数
# ============================================================
function Info($msg)   { Write-Host "[信息] $msg" -ForegroundColor Cyan }
function Success($msg){ Write-Host "[成功] $msg" -ForegroundColor Green }
function Warn($msg)   { Write-Host "[警告] $msg" -ForegroundColor Yellow }
function Err($msg)    { Write-Host "[错误] $msg" -ForegroundColor Red }
function Step($msg)   { Write-Host "`n>>> $msg" -ForegroundColor Cyan }
function Pause-Script { Write-Host ""; Read-Host "按回车键继续" | Out-Null }

function Read-Secret($prompt) {
    Write-Host $prompt -NoNewline
    $secure = Read-Host -AsSecureString " "
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    return $plain
}

# ============================================================
# 欢迎界面 / GUI 模式检测
# ============================================================
$guiMode = $env:GUI_MODE -eq "1"
$testMode = $false

if ($guiMode) {
    $testMode = $env:TEST_MODE -eq "true"
    Step "OpenClaw 自动部署 - Windows"
} else {
    Clear-Host
    Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║         OpenClaw 自动部署工具 - Windows 版           ║" -ForegroundColor Cyan
    Write-Host "║                  内部使用 v1.0                       ║" -ForegroundColor Cyan
    Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
    Warn "请确保电脑已连接网络后再继续。"
    Write-Host ""
    Write-Host "是否以【测试模式】运行？" -ForegroundColor Yellow
    Write-Host "  测试模式：只验证环境检测和安装逻辑，跳过写入配置和重启 Gateway"
    Write-Host "  正式模式：完整执行所有步骤（会覆盖现有配置）"
    Write-Host ""
    $runMode = Read-Host "输入 t 进入测试模式，直接回车进入正式模式"
    if ($runMode -eq "t" -or $runMode -eq "T") {
        $testMode = $true
        Warn "【测试模式】已启用，不会修改任何现有配置。"
    } else {
        Warn "【正式模式】将覆盖现有配置，请确认已备份。"
    }
    Pause-Script
}

# ============================================================
# 检查管理员权限
# ============================================================
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Err "请右键点击启动文件，选择「以管理员身份运行」"
    Pause-Script
    exit 1
}

# ============================================================
# 第一步：检测 Node.js 环境
# ============================================================
Step "第一步：检测 Node.js 环境"

$nodeOk = $false
try {
    $nodeVer = (& node --version 2>$null).TrimStart('v')
    $nodeMajor = [int]($nodeVer.Split('.')[0])
    if ($nodeMajor -ge 18) {
        Success "Node.js 已安装：v$nodeVer（满足要求）"
        $nodeOk = $true
    } else {
        Warn "Node.js 版本过低（v$nodeVer），需要 v18 或以上，将自动升级。"
    }
} catch {
    Warn "未检测到 Node.js，将自动安装。"
}

# ============================================================
# 第二步：安装 Node.js（如需要）
# ============================================================
if (-not $nodeOk) {
    Step "第二步：安装 Node.js（使用国内镜像）"

    $nodeMsi = "$env:TEMP\node-v20.19.0-x64.msi"
    $downloadUrl = "https://npmmirror.com/mirrors/node/v20.19.0/node-v20.19.0-x64.msi"

    Info "正在从国内镜像下载 Node.js v20.19.0..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        (New-Object Net.WebClient).DownloadFile($downloadUrl, $nodeMsi)
    } catch {
        Err "下载失败，请检查网络连接后重试。"
        Pause-Script; exit 1
    }

    Info "正在安装 Node.js，请稍候..."
    Start-Process msiexec -ArgumentList "/i `"$nodeMsi`" /quiet /norestart ADDLOCAL=ALL" -Wait
    Remove-Item $nodeMsi -Force -ErrorAction SilentlyContinue

    $env:PATH = "$env:PATH;$env:ProgramFiles\nodejs"

    try {
        $v = & node --version 2>$null
        Success "Node.js 安装完成：$v"
    } catch {
        Err "Node.js 安装失败，请重启电脑后重试。"
        Pause-Script; exit 1
    }
} else {
    Step "第二步：跳过（Node.js 已满足要求）"
}

# ============================================================
# 第三步：配置 npm 国内镜像
# ============================================================
Step "第三步：配置 npm 国内镜像"
& npm config set registry https://registry.npmmirror.com
Success "npm 镜像已设置为淘宝源"

# ============================================================
# 第四步：安装 OpenClaw
# ============================================================
Step "第四步：安装 OpenClaw"

& git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" 2>$null
& git config --global --add url."https://github.com/".insteadOf "git@github.com:" 2>$null

$ocInstalled = $false
try { & openclaw --version 2>$null | Out-Null; $ocInstalled = $true } catch {}

if ($ocInstalled) {
    $curVer = (& openclaw --version 2>$null)
    Info "检测到 OpenClaw 已安装（版本：$curVer），更新到最新版..."
    & npm install -g openclaw
} else {
    Info "正在安装 OpenClaw..."
    & npm install -g openclaw
    if ($LASTEXITCODE -ne 0) {
        Err "OpenClaw 安装失败，请检查网络后重试。"
        Pause-Script; exit 1
    }
}

Success "OpenClaw 版本：$(& openclaw --version 2>$null)"

# ============================================================
# 第五步：收集配置信息
# ============================================================
Step "第五步：填写配置信息"

if ($testMode) {
    Warn "【测试模式】跳过配置信息填写。"
    $kimiApiKey = "sk-test-placeholder"
} elseif ($guiMode) {
    $kimiApiKey = $env:KIMI_API_KEY
    Success "API Key 已从 GUI 传入"
} else {
    Write-Host ""
    while ($true) {
        Write-Host "请输入你的 Kimi API Key：" -ForegroundColor Yellow
        Write-Host "（可在 platform.moonshot.cn 的控制台中获取）"
        $kimiApiKey = Read-Secret "  >"
        if ([string]::IsNullOrEmpty($kimiApiKey)) {
            Err "API Key 不能为空，请重新输入。"
        } elseif (-not $kimiApiKey.StartsWith("sk-")) {
            $force = Read-Host "API Key 格式看起来不对（应以 sk- 开头），是否继续？(y/N)"
            if ($force -eq "y" -or $force -eq "Y") { break }
        } else {
            Success "API Key 已填写"
            break
        }
    }
}

# ============================================================
# 第六步：写入配置文件
# ============================================================
Step "第六步：写入 OpenClaw 配置"

if ($testMode) {
    Warn "【测试模式】跳过写入配置文件，现有配置不受影响。"
    $gwPort = 18789
} else {
    Info "清理旧 Gateway 进程..."
    & openclaw gateway stop 2>$null
    Start-Sleep -Seconds 2

    # 检测可用端口
    $gwPort = 18789
    foreach ($tryPort in @(18789, 18790, 18791)) {
        $inUse = $false
        try {
            $tcp = New-Object Net.Sockets.TcpClient
            $tcp.Connect('127.0.0.1', $tryPort)
            $tcp.Close()
            $inUse = $true
        } catch {}
        if ($inUse) {
            Warn "端口 $tryPort 已被占用，跳过..."
        } else {
            $gwPort = $tryPort
            break
        }
    }
    Success "Gateway 将使用端口 $gwPort"

    $openclawDir = "$env:USERPROFILE\.openclaw"
    New-Item -ItemType Directory -Force -Path $openclawDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$openclawDir\workspace" | Out-Null

    $configPath = "$openclawDir\openclaw.json"
    if (Test-Path $configPath) {
        $stamp = Get-Date -Format "yyyyMMddHHmmss"
        Copy-Item $configPath "$configPath.bak.$stamp"
        Info "已备份旧配置文件"
    }

    $gwToken = [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")
    $workspacePath = "$env:USERPROFILE\.openclaw\workspace" -replace '\\', '/'

    $configJson = @"
{
  "meta": {
    "lastTouchedVersion": "2026.2.26"
  },
  "auth": {
    "profiles": {
      "moonshot:default": {
        "provider": "moonshot",
        "mode": "api_key"
      }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "moonshot": {
        "baseUrl": "https://api.moonshot.cn/v1",
        "api": "openai-completions",
        "apiKey": "$kimiApiKey",
        "models": [
          {
            "id": "kimi-k2.5",
            "name": "Kimi K2.5",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 256000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "moonshot/kimi-k2.5" },
      "workspace": "$workspacePath",
      "compaction": { "mode": "safeguard" },
      "maxConcurrent": 4
    },
    "list": [{ "id": "main" }]
  },
  "gateway": {
    "port": $gwPort,
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "$gwToken"
    },
    "remote": {
      "token": "$gwToken"
    }
  }
}
"@

    [System.IO.File]::WriteAllText($configPath, $configJson, [System.Text.Encoding]::UTF8)
    Success "配置文件已写入 $configPath"
}

# ============================================================
# 第七步：启动 Gateway
# ============================================================
Step "第七步：启动 Gateway 服务"

if ($testMode) {
    Warn "【测试模式】跳过 Gateway 重启，现有服务不受影响。"
    $gwRunning = $false
    try { & openclaw health 2>$null | Out-Null; $gwRunning = $true } catch {}
    if ($gwRunning) { Success "Gateway 当前运行正常（未做任何改动）" }
    else            { Warn "Gateway 当前未运行（测试模式下不自动启动）" }
} else {
    & openclaw doctor --fix 2>$null
    Info "正在启动 Gateway..."
    & openclaw gateway start

    Start-Sleep -Seconds 3

    $gwOk = $false
    try { & openclaw health 2>$null | Out-Null; $gwOk = $true } catch {}

    if (-not $gwOk) {
        Warn "首次启动未就绪，等待重试..."
        Start-Sleep -Seconds 5
        try { & openclaw health 2>$null | Out-Null; $gwOk = $true } catch {}
    }

    if ($gwOk) {
        Success "Gateway 启动成功！"
    } else {
        Err "Gateway 启动失败，请检查日志：openclaw logs"
        Pause-Script; exit 1
    }
}

# ============================================================
# 完成
# ============================================================
if (-not $guiMode) { Clear-Host }

if ($testMode) {
    Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║            [OK] 测试模式运行完成！                   ║" -ForegroundColor Green
    Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
    Write-Host ""
    Write-Host "测试结果：环境检测和安装逻辑均正常，现有配置未做任何修改。"
    Write-Host ""
    Write-Host "脚本可以正式分发给员工使用。"
} else {
    if (-not $guiMode) {
        Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
        Write-Host "║                   部署完成！                         ║" -ForegroundColor Green
        Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
        Write-Host ""
        Write-Host "OpenClaw 已成功部署，以下是你的配置信息："
        Write-Host ""
        Write-Host "  模型：     Kimi K2.5 (moonshot)" -ForegroundColor Cyan
        Write-Host "  Gateway：  http://localhost:${gwPort}?token=${gwToken}" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "后续操作："
        Write-Host "  * 打开 TUI 界面：openclaw tui"
        Write-Host "  * 查看运行状态：openclaw health"
        Write-Host "  * 查看日志：    openclaw logs"
        Write-Host ""
        Write-Host "如需配置飞书等频道，请运行：openclaw channels"
        Write-Host ""
        Info "正在打开 OpenClaw 网页版..."
        Start-Sleep -Seconds 1
        Start-Process "http://localhost:${gwPort}?token=${gwToken}"
    }
    # GUI 模式：输出结构化完成信息供 Electron 解析
    if ($guiMode) {
        Write-Host "DEPLOY_DONE:port=${gwPort}:token=${gwToken}"
    }
}
if (-not $guiMode) {
    Write-Host ""
    Pause-Script
}
