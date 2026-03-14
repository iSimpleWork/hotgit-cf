# HotGit — Cloudflare Workers 版

GitHub 热门仓库每日追踪系统，基于 **Cloudflare Workers + D1 + Cron Triggers** 构建，零服务器运维。

## 功能

| 榜单 | 说明 |
|------|------|
| ⭐ Star 总榜 | 全网 Star 数最多的 100 个仓库 |
| 🍴 Fork 总榜 | 全网 Fork 数最多的 100 个仓库 |
| 📈 日增 Star | 近 1 天内活跃度最高的 100 个仓库 |
| 📅 周增 Star | 近 7 天内活跃度最高的 100 个仓库 |
| 🗓️ 月增 Star | 近 30 天内活跃度最高的 100 个仓库 |

每天 **23:00 CST（15:00 UTC）** 自动爬取，支持分页、语言筛选、关键词搜索。

## 本地开发

```bash
npm install

# 运行测试
npm test

# 本地开发服务器（需先配置 wrangler.toml）
npm run dev
```

## 首次部署流程

### 1. 准备账号信息

需要提供以下信息（见 `DEPLOY_CHECKLIST.md`）：
- Cloudflare Account ID
- Cloudflare API Token
- GitHub Personal Access Token（可选，提升 API 限额）

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create hotgit-db
# 将输出的 database_id 填入 wrangler.toml
```

### 3. 更新 wrangler.toml

将 `database_id` 替换为上一步获得的真实 ID。

### 4. 设置 Secrets

```bash
npx wrangler secret put GITHUB_TOKEN   # GitHub PAT
npx wrangler secret put ADMIN_TOKEN    # 手动触发爬取的鉴权 token
```

### 5. 执行数据库迁移

```bash
npm run db:migrate:remote
```

### 6. 部署

```bash
npm run deploy
```

### 7. 通过 GitHub Actions 自动部署

在 GitHub 仓库 Settings → Secrets 中添加：
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

之后每次推送到 `main` 分支将自动触发测试 + 部署。

## API

| 端点 | 说明 |
|------|------|
| `GET /api/repos?category=top_stars&page=1&per_page=20` | 获取仓库列表 |
| `GET /api/stats` | 获取统计摘要 |
| `GET /api/dates` | 获取所有爬取日期 |
| `POST /api/crawl` | 手动触发爬取（需 `X-Admin-Token` 头） |

## 技术栈

- **运行时**：Cloudflare Workers（Edge，全球加速）
- **数据库**：Cloudflare D1（SQLite，每天 10 万次读免费）
- **定时任务**：Cloudflare Cron Triggers
- **前端**：服务端渲染 HTML（无框架，极速加载）
- **CI/CD**：GitHub Actions
