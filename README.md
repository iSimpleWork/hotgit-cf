# HotGit

> 每天自动追踪 GitHub 最热项目，按 Star 总数、Fork 数、日/周/月增量分类展示。

**线上地址**：https://www.hotgit.org

---

## 功能

- 每天 23:00（北京时间）自动爬取 GitHub 数据
- 展示维度：Star 总数 Top100 / Fork 数 Top100 / 日增 Top100 / 周增 Top100 / 月增 Top100
- 支持分页（10/20/50/100 条每页）
- 支持编程语言筛选 + 关键词搜索
- 展示字段：项目名、Star/Fork/Issues、最近推送时间、项目简介、语言、Topics、GitHub 链接
- 支持手动触发爬取

---

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Cloudflare Workers |
| 数据库 | Cloudflare D1（SQLite） |
| 定时任务 | Cloudflare Cron Triggers |
| 前端 | 内联 HTML/CSS/JS（Workers 直接渲染） |
| CI/CD | GitHub Actions |

---

## 本地开发 & 部署

### 前提条件

- Node.js 16+
- Cloudflare 账号（免费套餐即可）
- GitHub 账号

### 第一步：克隆并安装依赖

```bash
git clone https://github.com/iSimpleWork/hotgit-cf.git
cd hotgit-cf
npm install
```

### 第二步：配置环境变量

所有敏感信息通过**系统环境变量**传入，**不写入任何代码或配置文件**。

复制模板并填入真实值：

```bash
cp .wrangler.env.example .wrangler.env
```

编辑 `.wrangler.env`（已被 `.gitignore` 排除，不会提交）：

```bash
# Cloudflare 账号 ID（登录 dash.cloudflare.com 右侧边栏查看）
export CLOUDFLARE_ACCOUNT_ID=your_account_id

# Cloudflare API Token（需要 Workers Edit + D1 Edit 权限）
# 创建地址：dash.cloudflare.com/profile/api-tokens
export CLOUDFLARE_API_TOKEN=your_api_token

# D1 数据库 ID（第三步创建后填入）
export HOTGIT_D1_DATABASE_ID=your_d1_database_id

# GitHub PAT（只需 public_repo 权限，用于提升 API 限额，可选）
# 创建地址：github.com/settings/tokens
export GITHUB_TOKEN=your_github_pat
```

加载环境变量：

```bash
source .wrangler.env
```

### 第三步：创建 D1 数据库

```bash
npx wrangler d1 create hotgit-db
```

输出中会包含 `database_id`，将其填入 `.wrangler.env` 的 `HOTGIT_D1_DATABASE_ID`。

执行数据库迁移：

```bash
npx wrangler d1 execute hotgit-db --file=migrations/0001_init.sql --remote
```

### 第四步：本地验证部署脚本

先验证脚本能正确提取配置并生成临时 `wrangler.toml`：

```bash
bash deploy.sh --validate
```

### 第五步：部署

```bash
bash deploy.sh
```

`deploy.sh` 会先执行远端 D1 迁移，再部署 Worker。它从环境变量读取配置，动态生成临时部署文件，**不会修改源码中的 wrangler.toml**。

部署成功后设置 GitHub Token Secret（提升爬取限额）：

```bash
echo "$GITHUB_TOKEN" | npx wrangler secret put GITHUB_TOKEN
```

---

## GitHub Actions 自动部署

在仓库的 **Settings → Secrets and variables → Actions** 中添加以下 4 个 Secret：

| Secret 名称 | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（Workers Edit + D1 Edit 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 数据库 ID |

配置完成后，每次推送到 `main` 分支即自动部署。
GitHub Actions 会先运行 `bash deploy.sh --validate`，再运行同一份 `bash deploy.sh` 做迁移和部署，确保 CI 与本地使用同一套脚本逻辑。

---

## API 接口

| 接口 | 说明 |
|---|---|
| `GET /` | 首页 |
| `GET /repos?category=stars&page=1&per_page=20&lang=Python&q=search` | 仓库列表 |
| `GET /api/repos` | JSON 格式仓库列表 |
| `GET /api/stats` | 统计信息 |
| `POST /api/crawl` | 手动触发爬取 |

---

## 项目结构

```
hotgit-cf/
├── src/
│   └── worker.js          # Cloudflare Worker 主入口（爬虫 + API + 前端渲染）
├── migrations/
│   └── 0001_init.sql      # D1 数据库初始化 SQL
├── test/
│   └── run.js             # 72 个单元测试
├── .github/
│   └── workflows/
│       └── deploy.yml     # GitHub Actions 自动部署
├── wrangler.toml          # Wrangler 配置（不含敏感信息）
├── .wrangler.env.example  # 环境变量模板（可提交）
├── .wrangler.env          # 本地环境变量（已 gitignore，不提交）
├── deploy.sh              # 本地部署脚本
└── .gitignore
```

---

## 注意事项

- `.wrangler.env` 已被 `.gitignore` 排除，其中的真实 Token/ID **不会提交到 Git**
- `wrangler.toml` 中的 `database_id` 字段保持占位符，由 `deploy.sh` 或 CI 在运行时替换
- 所有 Cloudflare Secrets（如 `GITHUB_TOKEN`）通过 `wrangler secret put` 注入，不写入代码
