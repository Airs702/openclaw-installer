#!/bin/bash
# OpenClaw 自动部署脚本 - macOS 版本
# 双击即可运行

# ============================================================
# 颜色定义
# ============================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ============================================================
# 工具函数
# ============================================================
info()    { echo -e "${BLUE}[信息]${NC} $1"; }
success() { echo -e "${GREEN}[成功]${NC} $1"; }
warn()    { echo -e "${YELLOW}[警告]${NC} $1"; }
error()   { echo -e "${RED}[错误]${NC} $1"; }
step()    { echo -e "\n${CYAN}>>> $1${NC}"; }

pause() {
    # GUI 模式下跳过 pause
    if [ "${GUI_MODE}" != "1" ]; then
        echo ""
        read -p "按回车键继续..." _
    fi
}

# 脚本出错时停止
set -e
trap 'error "脚本执行出错，请联系管理员。"; pause; exit 1' ERR

# ============================================================
# GUI 模式：从环境变量读取参数，跳过交互
# ============================================================
if [ "${GUI_MODE}" = "1" ]; then
    # KIMI_API_KEY 和 TEST_MODE 由 Electron 通过环境变量传入
    if [ "${TEST_MODE}" != "true" ]; then
        TEST_MODE=false
    fi
    step "OpenClaw 自动部署 - macOS"
else
    # ============================================================
    # 终端模式：原有交互逻辑
    # ============================================================
    clear
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════╗"
    echo "║          OpenClaw 自动部署工具 - macOS 版            ║"
    echo "║                  内部使用 v1.0                       ║"
    echo "╚══════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    warn "请确保电脑已连接网络后再继续。"
    echo ""
    read -p "输入 t 进入测试模式，直接回车进入正式模式: " RUN_MODE
    echo ""
    if [[ "$RUN_MODE" == "t" || "$RUN_MODE" == "T" ]]; then
        TEST_MODE=true
        warn "【测试模式】已启用，不会修改任何现有配置。"
    else
        TEST_MODE=false
        warn "【正式模式】将覆盖现有配置，请确认已备份。"
    fi
    pause
fi

# ============================================================
# 第一步：检测 Node.js 环境
# ============================================================
step "第一步：检测 Node.js 环境"

NODE_OK=false
NPM_OK=false

if command -v node &>/dev/null; then
    NODE_VER=$(node --version | sed 's/v//')
    NODE_MAJOR=$(echo $NODE_VER | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 18 ]; then
        success "Node.js 已安装：v${NODE_VER}（满足要求）"
        NODE_OK=true
    else
        warn "Node.js 版本过低（v${NODE_VER}），需要 v18 或以上，将自动升级。"
    fi
else
    warn "未检测到 Node.js，将自动安装。"
fi

if command -v npm &>/dev/null; then
    NPM_VER=$(npm --version)
    success "npm 已安装：v${NPM_VER}"
    NPM_OK=true
fi

# ============================================================
# 第二步：安装 Node.js（如需要）
# ============================================================
if [ "$NODE_OK" = false ]; then
    step "第二步：安装 Node.js（使用国内镜像）"

    # 检测是否有 Homebrew
    if command -v brew &>/dev/null; then
        info "检测到 Homebrew，使用 Homebrew 安装 Node.js..."
        # 配置清华镜像加速
        export HOMEBREW_BOTTLE_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"
        brew install node
    else
        info "未检测到 Homebrew，将从国内镜像下载 Node.js 安装包..."

        # 从 npmmirror 下载 Node.js LTS
        NODE_PKG="node-v20.19.0-darwin-x64.tar.gz"
        DOWNLOAD_URL="https://npmmirror.com/mirrors/node/v20.19.0/${NODE_PKG}"
        TMP_DIR=$(mktemp -d)

        info "正在下载 Node.js v20.19.0..."
        curl -L --progress-bar "$DOWNLOAD_URL" -o "${TMP_DIR}/${NODE_PKG}"

        info "正在安装..."
        tar -xzf "${TMP_DIR}/${NODE_PKG}" -C "${TMP_DIR}"
        sudo mkdir -p /usr/local/lib/nodejs
        sudo cp -r "${TMP_DIR}/node-v20.19.0-darwin-x64" /usr/local/lib/nodejs/node-v20

        # 写入 PATH
        SHELL_RC="$HOME/.zshrc"
        [ -f "$HOME/.bash_profile" ] && SHELL_RC="$HOME/.bash_profile"

        if ! grep -q "nodejs/node-v20" "$SHELL_RC" 2>/dev/null; then
            echo 'export PATH="/usr/local/lib/nodejs/node-v20/bin:$PATH"' >> "$SHELL_RC"
        fi
        export PATH="/usr/local/lib/nodejs/node-v20/bin:$PATH"

        rm -rf "$TMP_DIR"
        success "Node.js 安装完成"
    fi
else
    step "第二步：跳过（Node.js 已满足要求）"
fi

# ============================================================
# 第三步：配置 npm 国内镜像
# ============================================================
step "第三步：配置 npm 国内镜像"

# 如果当前用户对 npm 全局目录没有写权限，切换到用户私有目录
NPM_PREFIX=$(npm config get prefix 2>/dev/null)
if [ ! -w "$NPM_PREFIX" ]; then
    info "当前用户对 npm 全局目录无写权限，切换到用户私有目录..."
    mkdir -p "$HOME/.npm-global"
    npm config set prefix "$HOME/.npm-global"
    export PATH="$HOME/.npm-global/bin:$PATH"
    if ! grep -q '\.npm-global' "$HOME/.zshrc" 2>/dev/null; then
        echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.zshrc"
    fi
    success "npm 全局目录已设置为 ~/.npm-global"
fi

npm config set registry https://registry.npmmirror.com
success "npm 镜像已设置为淘宝源"

# ============================================================
# 第四步：安装 OpenClaw
# ============================================================
step "第四步：安装 OpenClaw"

# 强制将 SSH 方式的 GitHub 依赖转为 HTTPS，避免无 SSH key 时报错
git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
git config --global --add url."https://github.com/".insteadOf "git@github.com:"

if command -v openclaw &>/dev/null; then
    CUR_VER=$(openclaw --version 2>/dev/null || echo "未知")
    info "检测到 OpenClaw 已安装（版本：${CUR_VER}），更新到最新版..."
    npm install -g openclaw
else
    info "正在安装 OpenClaw..."
    npm install -g openclaw
fi

# 确保后续命令使用刚安装的 openclaw（而非系统其他版本）
NPM_BIN=$(npm bin -g 2>/dev/null || npm prefix -g)/bin
export PATH="$NPM_BIN:$PATH"

success "OpenClaw 版本：$(openclaw --version)"

# ============================================================
# 第五步：收集配置信息
# ============================================================
step "第五步：填写配置信息"

if [ "$TEST_MODE" = true ]; then
    warn "【测试模式】跳过配置信息填写。"
    KIMI_API_KEY="sk-test-placeholder"
else
    # GUI 模式下 KIMI_API_KEY 已由环境变量传入，无需 read
    if [ "${GUI_MODE}" != "1" ]; then
        echo ""
        echo "接下来需要填写两项信息，请准备好后继续。"
        echo ""
        while true; do
            echo -e "${YELLOW}请输入你的 Kimi API Key：${NC}"
            echo "（可在 platform.moonshot.cn 的控制台中获取）"
            read -s KIMI_API_KEY
            echo ""
            if [ -z "$KIMI_API_KEY" ]; then
                error "API Key 不能为空，请重新输入。"
            elif [[ ! "$KIMI_API_KEY" =~ ^sk- ]]; then
                warn "API Key 格式看起来不对（应以 sk- 开头），是否继续？(y/N): "
                read FORCE
                [[ "$FORCE" =~ ^[Yy]$ ]] && break
            else
                success "API Key 已填写"
                break
            fi
        done
    fi
fi # end TEST_MODE check

# ============================================================
# 第六步：写入配置文件
# ============================================================
step "第六步：写入 OpenClaw 配置"

if [ "$TEST_MODE" = true ]; then
    warn "【测试模式】跳过写入配置文件，现有配置不受影响。"
    GW_PORT=18789
else

# 先停掉旧 Gateway 并清理残留进程
info "清理旧 Gateway 进程..."
openclaw gateway stop &>/dev/null 2>&1 || true
sleep 2
# 杀掉当前用户所有残留的 openclaw-gateway 进程
pkill -u "$(whoami)" -f openclaw-gateway 2>/dev/null || true
sleep 1

# 确定可用端口（在写配置之前）
GW_PORT=18789
for TRY_PORT in 18789 18790 18791; do
    if nc -z 127.0.0.1 ${TRY_PORT} 2>/dev/null; then
        warn "端口 ${TRY_PORT} 已被占用，跳过..."
    else
        GW_PORT=${TRY_PORT}
        break
    fi
done
success "Gateway 将使用端口 ${GW_PORT}"

mkdir -p ~/.openclaw

# 备份旧配置
if [ -f ~/.openclaw/openclaw.json ]; then
    cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d%H%M%S)
    info "已备份旧配置文件"
fi

GW_TOKEN=$(openssl rand -hex 24)

cat > ~/.openclaw/openclaw.json << JSONEOF
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
        "apiKey": "${KIMI_API_KEY}",
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
      "model": {
        "primary": "moonshot/kimi-k2.5"
      },
      "workspace": "${HOME}/.openclaw/workspace",
      "compaction": { "mode": "safeguard" },
      "maxConcurrent": 4
    },
    "list": [{ "id": "main" }]
  },
  "gateway": {
    "port": ${GW_PORT},
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "${GW_TOKEN}"
    },
    "remote": {
      "token": "${GW_TOKEN}"
    }
  }
}
JSONEOF

success "配置文件已写入 ~/.openclaw/openclaw.json"

fi # end TEST_MODE check for config

# ============================================================
# 第七步：启动 Gateway
# ============================================================
step "第七步：启动 Gateway 服务"

if [ "$TEST_MODE" = true ]; then
    warn "【测试模式】跳过 Gateway 重启，现有服务不受影响。"
    if openclaw health &>/dev/null 2>&1; then
        success "Gateway 当前运行正常（未做任何改动）"
    else
        warn "Gateway 当前未运行（测试模式下不自动启动）"
    fi
else
    # 同步 service token
    info "正在同步 Gateway 服务配置..."
    export OPENCLAW_GATEWAY_TOKEN="${GW_TOKEN}"
    openclaw doctor --fix &>/dev/null 2>&1 || true

    info "正在启动 Gateway..."
    openclaw gateway start

    sleep 3

    if openclaw health &>/dev/null 2>&1; then
        success "Gateway 启动成功！"
    else
        warn "首次启动未就绪，等待重试..."
        sleep 5
        if openclaw health &>/dev/null 2>&1; then
            success "Gateway 启动成功！"
        else
            error "Gateway 启动失败，请检查日志：openclaw logs"
            pause
            exit 1
        fi
    fi
fi

# GUI 模式：输出结构化完成信息供 Electron 解析
if [ "${GUI_MODE}" = "1" ] && [ "$TEST_MODE" != "true" ]; then
    echo "DEPLOY_DONE:port=${GW_PORT}:token=${GW_TOKEN}"
fi

# ============================================================
# 完成
# ============================================================
if [ "${GUI_MODE}" != "1" ]; then
    clear
    echo -e "${GREEN}"
    echo "╔══════════════════════════════════════════════════════╗"
    if [ "$TEST_MODE" = true ]; then
    echo "║               ✅ 测试模式运行完成！                  ║"
    else
    echo "║                  🎉 部署完成！                       ║"
    fi
    echo "╚══════════════════════════════════════════════════════╝"
    echo -e "${NC}"

    if [ "$TEST_MODE" = true ]; then
        echo "测试结果：环境检测和安装逻辑均正常，现有配置未做任何修改。"
        echo ""
        echo "脚本可以正式分发给员工使用。"
    else
        echo "OpenClaw 已成功部署，以下是你的配置信息："
        echo ""
        echo -e "  ${CYAN}模型：${NC}     Kimi K2.5 (moonshot)"
        echo -e "  ${CYAN}Gateway：${NC}  http://localhost:${GW_PORT}?token=${GW_TOKEN}"
        echo ""
        echo "后续操作："
        echo "  • 打开 TUI 界面：openclaw tui"
        echo "  • 查看运行状态：openclaw health"
        echo "  • 查看日志：    openclaw logs"
        echo ""
        echo "如需配置飞书等频道，请运行：openclaw channels"
        echo ""
        info "正在打开 OpenClaw 网页版..."
        sleep 1
        open "http://localhost:${GW_PORT}?token=${GW_TOKEN}"
    fi
    echo ""
    pause
fi
