#!/usr/bin/env bash
# deploy.sh — 从环境变量读取敏感配置，动态生成 wrangler.toml 后部署
# 使用方式：
#   source .wrangler.env && bash deploy.sh
# 或直接传入：
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx HOTGIT_D1_DATABASE_ID=xxx bash deploy.sh

set -euo pipefail

# ── 检查必要的环境变量 ────────────────────────────────────────────────
: "${CLOUDFLARE_API_TOKEN:?请设置 CLOUDFLARE_API_TOKEN 环境变量}"
: "${CLOUDFLARE_ACCOUNT_ID:?请设置 CLOUDFLARE_ACCOUNT_ID 环境变量}"
: "${HOTGIT_D1_DATABASE_ID:?请设置 HOTGIT_D1_DATABASE_ID 环境变量}"

echo "▶ 准备部署 HotGit CF..."
echo "  Account: ${CLOUDFLARE_ACCOUNT_ID:0:8}..."
echo "  D1 DB  : ${HOTGIT_D1_DATABASE_ID:0:8}..."

# ── 生成临时 wrangler.toml（含真实 ID，不提交）────────────────────────
WRANGLER_TMP=$(mktemp /tmp/wrangler_deploy_XXXXXX.toml)
trap "rm -f $WRANGLER_TMP" EXIT

sed \
  -e "s|REPLACE_WITH_YOUR_D1_DATABASE_ID|${HOTGIT_D1_DATABASE_ID}|g" \
  wrangler.toml > "$WRANGLER_TMP"

# 追加 account_id（wrangler 优先读取环境变量 CLOUDFLARE_ACCOUNT_ID，这里也写入临时文件）
echo "" >> "$WRANGLER_TMP"
echo "account_id = \"${CLOUDFLARE_ACCOUNT_ID}\"" >> "$WRANGLER_TMP"

echo "▶ 开始部署 Worker..."
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  npx wrangler deploy --config "$WRANGLER_TMP"

echo ""
echo "✅ 部署完成！"
echo "   线上地址: https://hotgit-cf.$(npx wrangler whoami 2>/dev/null | grep -o '[a-z0-9]*\.workers\.dev' | head -1 || echo 'workers.dev')"

# ── 可选：设置 GITHUB_TOKEN Secret ──────────────────────────────────
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo ""
  echo "▶ 注入 GITHUB_TOKEN Secret..."
  echo "$GITHUB_TOKEN" | CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    npx wrangler secret put GITHUB_TOKEN --config "$WRANGLER_TMP"
  echo "✅ GITHUB_TOKEN 已设置"
fi
