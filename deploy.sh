#!/usr/bin/env bash
# deploy.sh — 本地与 CI 共用的 HotGit 部署入口
# 用法：
#   source .wrangler.env && bash deploy.sh
#   source .wrangler.env && bash deploy.sh --validate
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx HOTGIT_D1_DATABASE_ID=xxx bash deploy.sh

set -euo pipefail

MODE="${1:-deploy}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

require_env() {
  : "${CLOUDFLARE_API_TOKEN:?请设置 CLOUDFLARE_API_TOKEN 环境变量}"
  : "${CLOUDFLARE_ACCOUNT_ID:?请设置 CLOUDFLARE_ACCOUNT_ID 环境变量}"
  : "${HOTGIT_D1_DATABASE_ID:?请设置 HOTGIT_D1_DATABASE_ID 环境变量}"
}

make_temp_config() {
  WRANGLER_TMP=$(mktemp /tmp/wrangler_deploy_XXXXXX.toml)
  trap 'rm -f "$WRANGLER_TMP"' EXIT

  awk \
    -v db_id="${HOTGIT_D1_DATABASE_ID}" \
    -v migrations_dir="${SCRIPT_DIR}/migrations" '
      {
        gsub(/REPLACE_WITH_YOUR_D1_DATABASE_ID/, db_id)
        print
        if ($0 ~ /database_id[[:space:]]*=/) {
          print "migrations_dir = \"" migrations_dir "\""
        }
      }
    ' wrangler.toml > "$WRANGLER_TMP"

  {
    echo ""
    echo "account_id = \"${CLOUDFLARE_ACCOUNT_ID}\""
  } >> "$WRANGLER_TMP"
}

validate_config() {
  grep -q "$HOTGIT_D1_DATABASE_ID" "$WRANGLER_TMP"
  grep -q "account_id = \"$CLOUDFLARE_ACCOUNT_ID\"" "$WRANGLER_TMP"
  grep -q "migrations_dir = \"${SCRIPT_DIR}/migrations\"" "$WRANGLER_TMP"
  [ -d "${SCRIPT_DIR}/migrations" ]
}

run_migrations() {
  echo "▶ 执行远端 D1 迁移..."
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    npx wrangler d1 migrations apply hotgit-db --remote --config "$WRANGLER_TMP"
}

run_deploy() {
  echo "▶ 开始部署 Worker..."
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    npx wrangler deploy --config "$WRANGLER_TMP"
}

put_optional_secret() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    echo ""
    echo "▶ 注入 GITHUB_TOKEN Secret..."
    echo "$GITHUB_TOKEN" | CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
      npx wrangler secret put GITHUB_TOKEN --config "$WRANGLER_TMP"
    echo "✅ GITHUB_TOKEN 已设置"
  fi
}

require_env

echo "▶ 准备部署 HotGit CF..."
echo "  Account: ${CLOUDFLARE_ACCOUNT_ID:0:8}..."
echo "  D1 DB  : ${HOTGIT_D1_DATABASE_ID:0:8}..."

make_temp_config
validate_config

case "$MODE" in
  --validate)
    echo "✅ 配置验证通过"
    echo "   临时 wrangler 配置已成功生成并校验"
    ;;
  deploy|"")
    run_migrations
    run_deploy
    echo ""
    echo "✅ 部署完成！"
    echo "   线上地址: https://hotgit-cf.$(npx wrangler whoami 2>/dev/null | grep -o '[a-z0-9]*\.workers\.dev' | head -1 || echo 'workers.dev')"
    put_optional_secret
    ;;
  *)
    echo "用法: bash deploy.sh [--validate]"
    exit 1
    ;;
esac
