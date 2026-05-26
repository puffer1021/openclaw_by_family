#!/usr/bin/env bash
# 家庭虾 · 一键设置脚本
# 在新设备 clone 仓库后运行：bash scripts/setup-kids.sh
#
# 完成项：
#   1. 检查/安装系统依赖（ffmpeg, cairo, pango — Manim 需要）
#   2. 创建 Python venv 并装 manim
#   3. 提示登录 codex（GPT-5.5 视觉模型，复用 ChatGPT 订阅）
#   4. 提示 .env 配置 ARK_API_KEY（图像/视频生成仍走豆包）

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> 家庭虾 setup 开始"
echo "    仓库根目录：$REPO_ROOT"
echo

# ============ 1. 系统依赖 ============
if [[ "$(uname)" == "Darwin" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "❌ 没装 Homebrew，先去 https://brew.sh 装一下再来"
    exit 1
  fi

  for pkg in ffmpeg cairo pango pkg-config; do
    if brew list --formula | grep -q "^${pkg}\$"; then
      echo "✓ brew $pkg 已装"
    else
      echo "==> brew install $pkg"
      brew install "$pkg"
    fi
  done
elif [[ "$(uname)" == "Linux" ]]; then
  echo "提示：Linux 请手动 apt/yum 装 ffmpeg libcairo2 libpango1.0 pkg-config"
else
  echo "未知平台 $(uname)，请手动安装 ffmpeg/cairo/pango"
fi
echo

# ============ 2. Python venv + manim ============
if [[ ! -x .venv/bin/manim ]]; then
  echo "==> 创建 Python venv 并装 manim"
  python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install -r services/storyboard/requirements.txt
  echo "✓ manim 已装：$(.venv/bin/manim --version 2>&1 | tail -1)"
else
  echo "✓ .venv/bin/manim 已存在"
fi
echo

# ============ 3. Node 依赖 ============
if [[ ! -d node_modules/@openai/codex ]]; then
  echo "==> 安装 Node 依赖（pnpm install）"
  pnpm install
fi
echo "✓ codex CLI 路径：node_modules/@openai/codex/bin/codex.js"
echo

# ============ 4. 鉴权检查 ============
echo "==> 鉴权检查"
if [[ -f "$HOME/.codex/auth.json" ]]; then
  if grep -q '"auth_mode":\s*"chatgpt"' "$HOME/.codex/auth.json"; then
    echo "✓ codex 已用 ChatGPT 浏览器登录（GPT-5.5 视觉模型可用）"
  else
    echo "⚠️  ~/.codex/auth.json 存在但不是 chatgpt 模式，可以继续用，但 GPT-5.5 走 API 会扣额度"
  fi
else
  echo "⚠️  没找到 ~/.codex/auth.json"
  echo "   请运行：node node_modules/@openai/codex/bin/codex.js login"
  echo "   按提示打开浏览器登录 ChatGPT 即可（一次性）"
fi
echo

if [[ -f .env ]] && grep -q "^ARK_API_KEY=" .env && [[ -n "$(grep "^ARK_API_KEY=" .env | cut -d= -f2)" ]]; then
  echo "✓ .env 里 ARK_API_KEY 已配置（创造房间图像/视频生成会用）"
else
  echo "⚠️  .env 里 ARK_API_KEY 没配置"
  echo "   如果只用数学岛：可以忽略"
  echo "   如果要用创造房间：去 https://console.volcengine.com 申请豆包 key"
  echo "   参考：cp .env.example .env 然后填 ARK_API_KEY"
fi
echo

echo "==> setup 完成。启动方式："
echo "    终端 A：node services/storyboard/index.mjs"
echo "    终端 B：pnpm dev"
echo "    浏览器：http://localhost:5173/kids/"
