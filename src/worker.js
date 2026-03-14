/**
 * HotGit — Cloudflare Worker
 *
 * 职责：
 *  1. Cron Trigger (23:00 CST = 15:00 UTC) 自动爬取 GitHub 榜单并写入 D1
 *  2. HTTP 路由：
 *     GET  /           → 首页 HTML
 *     GET  /repos      → 榜单列表页 HTML
 *     GET  /api/repos  → JSON API（分页/筛选）
 *     GET  /api/stats  → 统计摘要
 *     GET  /api/dates  → 所有爬取日期
 *     POST /api/crawl  → 手动触发爬取（需要 X-Admin-Token 头）
 *  3. 静态资源通过 __STATIC_CONTENT 或内联方式提供
 */

// ── 常量 ───────────────────────────────────────────────────────────────
const GITHUB_API   = 'https://api.github.com';
const USER_AGENT   = 'hotgit-cf/1.0 (https://github.com/hotgit)';

const CATEGORY_LABELS = {
  top_stars:    '⭐ Star 总榜',
  top_forks:    '🍴 Fork 总榜',
  star_daily:   '📈 日增 Star',
  star_weekly:  '📅 周增 Star',
  star_monthly: '🗓️ 月增 Star',
};

// ── Env 类型（供 JSDoc 注释）─────────────────────────────────────────
/**
 * @typedef {Object} Env
 * @property {D1Database} DB
 * @property {string}     GITHUB_TOKEN   - GitHub PAT（在 Cloudflare Secrets 设置）
 * @property {string}     ADMIN_TOKEN    - 手动触发爬取的鉴权 Token
 */

// ══════════════════════════════════════════════════════════════════════
// Worker 入口
// ══════════════════════════════════════════════════════════════════════
export default {
  // HTTP 请求
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 静态资源
    if (path.startsWith('/static/')) {
      return handleStatic(path);
    }

    // API 路由
    if (path === '/api/repos')  return apiRepos(request, env);
    if (path === '/api/stats')  return apiStats(env);
    if (path === '/api/dates')  return apiDates(env);
    if (path === '/api/crawl' && request.method === 'POST') {
      return apiCrawl(request, env, ctx);
    }

    // 页面路由
    if (path === '/')       return pageIndex(env);
    if (path === '/repos')  return pageRepos(request, env);

    return new Response('Not Found', { status: 404 });
  },

  // Cron Trigger：每天 15:00 UTC = 23:00 CST
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCrawl(env));
  },
};

// ══════════════════════════════════════════════════════════════════════
// 爬虫
// ══════════════════════════════════════════════════════════════════════

/**
 * 调用 GitHub Search API
 * @param {string} query
 * @param {string} sort
 * @param {string} githubToken
 * @param {number} perPage
 */
async function githubSearch(query, sort, githubToken, perPage = 100) {
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': USER_AGENT,
  };
  if (githubToken) headers['Authorization'] = `token ${githubToken}`;

  const params = new URLSearchParams({
    q: query,
    sort,
    order: 'desc',
    per_page: String(perPage),
    page: '1',
  });

  const res = await fetch(`${GITHUB_API}/search/repositories?${params}`, {
    headers,
    cf: { cacheTtl: 60, cacheEverything: false },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.items || [];
}

/** 把 GitHub repo 对象格式化成统一结构 */
function fmtRepo(repo, category, rank) {
  let pushedAt = repo.pushed_at || repo.updated_at || '';
  if (pushedAt) {
    try { pushedAt = new Date(pushedAt).toISOString().replace('T', ' ').slice(0, 19); }
    catch (_) {}
  }
  return {
    category,
    rank,
    full_name:   repo.full_name   || '',
    html_url:    repo.html_url    || '',
    description: repo.description || '',
    language:    repo.language    || 'Unknown',
    stars:       repo.stargazers_count || 0,
    forks:       repo.forks_count      || 0,
    open_issues: repo.open_issues_count || 0,
    pushed_at:   pushedAt,
    topics:      (repo.topics || []).join(','),
    homepage:    repo.homepage || '',
  };
}

/** 按天数获取 since 日期字符串 */
function sinceDate(days) {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** 爬取所有榜单 */
async function fetchAll(githubToken) {
  const tasks = [
    { name: 'top_stars',    fn: () => githubSearch('stars:>1000',                        'stars',  githubToken) },
    { name: 'top_forks',    fn: () => githubSearch('forks:>500',                         'forks',  githubToken) },
    { name: 'star_daily',   fn: () => githubSearch(`pushed:>${sinceDate(1)}  stars:>10`, 'stars',  githubToken) },
    { name: 'star_weekly',  fn: () => githubSearch(`pushed:>${sinceDate(7)}  stars:>10`, 'stars',  githubToken) },
    { name: 'star_monthly', fn: () => githubSearch(`pushed:>${sinceDate(30)} stars:>10`, 'stars',  githubToken) },
  ];

  const result = {};
  // 顺序执行，避免 GitHub 限流
  for (const { name, fn } of tasks) {
    const items = await fn();
    result[name] = items.slice(0, 100).map((r, i) => fmtRepo(r, name, i + 1));
    // 间隔 1 秒
    await new Promise(r => setTimeout(r, 1000));
  }
  return result;
}

/** 主爬取流程：爬取 + 写入 D1 */
async function runCrawl(env) {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[crawl] start date=${today}`);

  let allRepos;
  try {
    allRepos = await fetchAll(env.GITHUB_TOKEN || '');
  } catch (e) {
    console.error('[crawl] fetchAll error:', e.message);
    await logCrawl(env.DB, today, 'ALL', 0, 'error', e.message);
    return;
  }

  for (const [category, repos] of Object.entries(allRepos)) {
    try {
      await saveRepos(env.DB, repos, today);
      await logCrawl(env.DB, today, category, repos.length, 'ok', '');
      console.log(`[crawl] ${category}: ${repos.length} saved`);
    } catch (e) {
      console.error(`[crawl] save ${category} error:`, e.message);
      await logCrawl(env.DB, today, category, 0, 'error', e.message);
    }
  }
  console.log('[crawl] done');
}

// ══════════════════════════════════════════════════════════════════════
// 数据库操作
// ══════════════════════════════════════════════════════════════════════

async function saveRepos(db, repos, crawlDate) {
  if (!repos.length) return;
  const category = repos[0].category;

  // 先删除当天同类别旧数据
  await db.prepare(
    'DELETE FROM repos WHERE crawl_date = ? AND category = ?'
  ).bind(crawlDate, category).run();

  // 批量插入（D1 支持 batch）
  const stmts = repos.map(r =>
    db.prepare(`
      INSERT INTO repos
        (crawl_date, category, rank, full_name, html_url, description,
         language, stars, forks, open_issues, pushed_at, topics, homepage)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      crawlDate, r.category, r.rank, r.full_name, r.html_url,
      r.description, r.language, r.stars, r.forks, r.open_issues,
      r.pushed_at, r.topics, r.homepage
    )
  );
  await db.batch(stmts);
}

async function logCrawl(db, crawlDate, category, count, status, message) {
  await db.prepare(
    'INSERT INTO crawl_log (crawl_date,category,count,status,message) VALUES (?,?,?,?,?)'
  ).bind(crawlDate, category, count, status, message).run();
}

async function getLatestDate(db) {
  const row = await db.prepare('SELECT MAX(crawl_date) AS d FROM repos').first();
  return row?.d || null;
}

async function getStats(db) {
  const date = await getLatestDate(db);
  if (!date) return { date: null, categories: {} };
  const rows = await db.prepare(
    'SELECT category, COUNT(*) AS cnt FROM repos WHERE crawl_date = ? GROUP BY category'
  ).bind(date).all();
  const categories = {};
  for (const r of rows.results) categories[r.category] = r.cnt;
  return { date, categories };
}

async function getCrawlDates(db) {
  const rows = await db.prepare(
    'SELECT DISTINCT crawl_date FROM repos ORDER BY crawl_date DESC LIMIT 30'
  ).all();
  return rows.results.map(r => r.crawl_date);
}

async function queryRepos(db, { category, crawlDate, page, perPage, lang, search }) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return { total: 0, page, per_page: perPage, data: [] };

  const conditions = ['crawl_date = ?', 'category = ?'];
  const params     = [crawlDate, category];

  if (lang)   { conditions.push('language = ?');                     params.push(lang); }
  if (search) { conditions.push('(full_name LIKE ? OR description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

  const where = conditions.join(' AND ');

  const countRow = await db.prepare(`SELECT COUNT(*) AS n FROM repos WHERE ${where}`)
    .bind(...params).first();
  const total = countRow?.n || 0;

  const offset = (page - 1) * perPage;
  const rows   = await db.prepare(
    `SELECT * FROM repos WHERE ${where} ORDER BY rank ASC LIMIT ? OFFSET ?`
  ).bind(...params, perPage, offset).all();

  return { total, page, per_page: perPage, data: rows.results };
}

async function getLanguages(db, category, crawlDate) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return [];
  const rows = await db.prepare(
    'SELECT DISTINCT language FROM repos WHERE crawl_date=? AND category=? AND language IS NOT NULL ORDER BY language'
  ).bind(crawlDate, category).all();
  return rows.results.map(r => r.language).filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════════
// API 处理器
// ══════════════════════════════════════════════════════════════════════

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function parseIntParam(v, def) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

async function apiRepos(request, env) {
  const q         = new URL(request.url).searchParams;
  const category  = q.get('category') || 'top_stars';
  const page      = parseIntParam(q.get('page'),     1);
  const perPage   = Math.min(parseIntParam(q.get('per_page'), 20), 100);
  const lang      = q.get('lang')   || '';
  const search    = q.get('search') || '';
  const crawlDate = q.get('date')   || null;

  const result = await queryRepos(env.DB, { category, crawlDate, page, perPage, lang, search });
  return json(result);
}

async function apiStats(env) {
  return json(await getStats(env.DB));
}

async function apiDates(env) {
  return json(await getCrawlDates(env.DB));
}

async function apiCrawl(request, env, ctx) {
  // 简单 token 鉴权
  const adminToken = env.ADMIN_TOKEN || '';
  if (adminToken) {
    const provided = request.headers.get('X-Admin-Token') || '';
    if (provided !== adminToken) {
      return json({ error: 'Unauthorized' }, 401);
    }
  }
  ctx.waitUntil(runCrawl(env));
  return json({ status: 'started', message: 'Crawl job started in background' });
}

// ══════════════════════════════════════════════════════════════════════
// 静态资源（内联）
// ══════════════════════════════════════════════════════════════════════

function handleStatic(path) {
  if (path === '/static/css/style.css') {
    return new Response(CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public,max-age=86400' } });
  }
  return new Response('Not Found', { status: 404 });
}

// ══════════════════════════════════════════════════════════════════════
// 页面渲染（服务端模板字符串）
// ══════════════════════════════════════════════════════════════════════

function html(content) {
  return new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function baseLayout(title, bodyContent) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${title}</title>
  <link rel="stylesheet" href="/static/css/style.css"/>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔥</text></svg>"/>
</head>
<body>
  <nav class="navbar">
    <a class="brand" href="/">🔥 HotGit</a>
    <ul class="nav-links">
      <li><a href="/">首页</a></li>
      <li><a href="/repos?category=top_stars">⭐ Star 榜</a></li>
      <li><a href="/repos?category=top_forks">🍴 Fork 榜</a></li>
      <li><a href="/repos?category=star_daily">📈 日增</a></li>
      <li><a href="/repos?category=star_weekly">📅 周增</a></li>
      <li><a href="/repos?category=star_monthly">🗓️ 月增</a></li>
    </ul>
  </nav>
  <main class="container">${bodyContent}</main>
  <footer class="footer">
    <p>HotGit — GitHub 热门仓库追踪 · 数据每日 23:00 CST 自动更新 · Powered by Cloudflare Workers</p>
  </footer>
</body>
</html>`;
}

async function pageIndex(env) {
  const stats = await getStats(env.DB);
  const dates = await getCrawlDates(env.DB);

  const catCards = Object.entries(CATEGORY_LABELS).map(([cat, lbl]) => {
    const cnt = stats.categories?.[cat];
    return `
    <a class="stat-card" href="/repos?category=${cat}">
      <div class="stat-icon">${lbl.split(' ')[0]}</div>
      <div class="stat-label">${lbl.replace(/^[^\s]+\s/, '')}</div>
      <div class="stat-count">${cnt ? cnt + ' 个项目' : '暂无数据'}</div>
      <div class="stat-action">查看榜单 →</div>
    </a>`;
  }).join('');

  const dateList = dates.slice(0, 10).map(d =>
    `<li><a href="/repos?date=${d}">${d}</a></li>`
  ).join('');

  const body = `
  <section class="hero">
    <h1>🔥 GitHub 热门仓库追踪</h1>
    <p class="hero-sub">每天自动爬取 GitHub，分析 Star / Fork / 增量排行，帮你找到最值得关注的开源项目</p>
    ${stats.date
      ? `<p class="hero-date">最新数据：${stats.date}</p>`
      : `<p class="hero-date warning">暂无数据，可点击下方按钮立即爬取</p>`}
    <button id="btn-crawl" class="btn btn-primary btn-lg">立即爬取数据</button>
    <span id="crawl-status" class="crawl-status"></span>
  </section>
  <section class="stats-grid">${catCards}</section>
  ${dates.length ? `<section class="history"><h2>历史数据</h2><ul class="date-list">${dateList}</ul></section>` : ''}
  <script>
  document.getElementById('btn-crawl').addEventListener('click',function(){
    const btn=this,st=document.getElementById('crawl-status');
    btn.disabled=true;btn.textContent='爬取中...';
    st.textContent='后台爬取任务已启动，约 1-2 分钟完成，完成后刷新页面。';st.className='crawl-status info';
    fetch('/api/crawl',{method:'POST'}).then(r=>r.json()).then(d=>{
      st.textContent='✅ '+d.message;st.className='crawl-status success';
    }).catch(()=>{
      st.textContent='❌ 请求失败';st.className='crawl-status error';
      btn.disabled=false;btn.textContent='立即爬取数据';
    });
  });
  </script>`;

  return html(baseLayout('HotGit — GitHub 热门仓库追踪', body));
}

async function pageRepos(request, env) {
  const q         = new URL(request.url).searchParams;
  const category  = q.get('category') || 'top_stars';
  const page      = parseIntParam(q.get('page'),     1);
  const perPage   = parseIntParam(q.get('per_page'), 20);
  const lang      = q.get('lang')   || '';
  const search    = q.get('search') || '';
  const crawlDate = q.get('date')   || await getLatestDate(env.DB);

  const result  = await queryRepos(env.DB, { category, crawlDate, page, perPage, lang, search });
  const langs   = await getLanguages(env.DB, category, crawlDate);
  const dates   = await getCrawlDates(env.DB);

  // Tab 栏
  const tabs = Object.entries(CATEGORY_LABELS).map(([cat, lbl]) =>
    `<a class="tab${cat === category ? ' active' : ''}" href="/repos?category=${cat}&date=${crawlDate||''}">${lbl}</a>`
  ).join('');

  // 筛选栏
  const langOptions = langs.map(l =>
    `<option value="${l}"${l === lang ? ' selected' : ''}>${l}</option>`
  ).join('');
  const dateOptions = dates.map(d =>
    `<option value="${d}"${d === crawlDate ? ' selected' : ''}>${d}</option>`
  ).join('');
  const perPageOptions = [10,20,50,100].map(n =>
    `<option value="${n}"${n === perPage ? ' selected' : ''}>每页 ${n} 条</option>`
  ).join('');

  // 仓库卡片
  const cards = result.data.map(repo => {
    const langBadge = repo.language && repo.language !== 'Unknown'
      ? `<span class="lang-badge lang-${repo.language.toLowerCase().replace(/\s+/g,'-')}">${escHtml(repo.language)}</span>`
      : '';
    const topics = repo.topics
      ? repo.topics.split(',').filter(Boolean).slice(0,8).map(t =>
          `<span class="topic-tag">${escHtml(t)}</span>`).join('')
      : '';
    const pushedDate = repo.pushed_at ? repo.pushed_at.slice(0,10) : '—';
    return `
    <div class="repo-card">
      <div class="repo-rank">#${repo.rank}</div>
      <div class="repo-main">
        <div class="repo-title-line">
          <a class="repo-name" href="${escHtml(repo.html_url)}" target="_blank" rel="noopener">${escHtml(repo.full_name)}</a>
          ${langBadge}
        </div>
        ${repo.description ? `<p class="repo-desc">${escHtml(repo.description)}</p>` : ''}
        ${topics ? `<div class="repo-topics">${topics}</div>` : ''}
        <div class="repo-meta">
          <span>⭐ ${fmtNum(repo.stars)}</span>
          <span>🍴 ${fmtNum(repo.forks)}</span>
          <span>🐛 ${repo.open_issues}</span>
          <span>🕐 ${pushedDate}</span>
          ${repo.homepage ? `<a class="meta-link" href="${escHtml(repo.homepage)}" target="_blank" rel="noopener">🌐 主页</a>` : ''}
          <a class="meta-link" href="${escHtml(repo.html_url)}" target="_blank" rel="noopener">🔗 GitHub</a>
        </div>
      </div>
    </div>`;
  }).join('');

  // 分页
  const totalPages = result.total > 0 ? Math.ceil(result.total / perPage) : 1;
  const makePageUrl = p => `/repos?category=${category}&page=${p}&per_page=${perPage}&lang=${encodeURIComponent(lang)}&search=${encodeURIComponent(search)}&date=${crawlDate||''}`;
  let pagination = '';
  if (totalPages > 1) {
    const pageLinks = [];
    if (page > 1) pageLinks.push(`<a class="page-btn" href="${makePageUrl(page-1)}">‹ 上一页</a>`);
    const start = Math.max(1, page - 3), end = Math.min(totalPages, page + 3);
    for (let p = start; p <= end; p++) {
      pageLinks.push(p === page
        ? `<span class="page-btn active">${p}</span>`
        : `<a class="page-btn" href="${makePageUrl(p)}">${p}</a>`);
    }
    if (page < totalPages) pageLinks.push(`<a class="page-btn" href="${makePageUrl(page+1)}">下一页 ›</a>`);
    pageLinks.push(`<span class="page-info">共 ${result.total} 条 / ${totalPages} 页</span>`);
    pagination = `<nav class="pagination">${pageLinks.join('')}</nav>`;
  }

  const emptyState = result.data.length === 0
    ? `<div class="empty-state"><p>暂无数据，请返回首页点击「立即爬取数据」。</p><a class="btn btn-primary" href="/">返回首页</a></div>`
    : '';

  const body = `
  <div class="repos-header">
    <h1>${CATEGORY_LABELS[category] || category}</h1>
    ${crawlDate ? `<p class="data-date">数据日期：${crawlDate}</p>` : ''}
  </div>
  <form class="filter-bar" method="get" action="/repos">
    <input type="hidden" name="category" value="${category}"/>
    <input type="hidden" name="date" value="${crawlDate||''}"/>
    <input class="input-search" type="text" name="search" placeholder="搜索项目名/描述…" value="${escHtml(search)}"/>
    <select name="lang" class="select-lang"><option value="">全部语言</option>${langOptions}</select>
    <select name="per_page" class="select-per-page">${perPageOptions}</select>
    <select name="date" class="select-date">${dateOptions}</select>
    <button class="btn btn-primary" type="submit">筛选</button>
    <a class="btn btn-ghost" href="/repos?category=${category}">重置</a>
  </form>
  <div class="tab-bar">${tabs}</div>
  ${result.data.length ? `<div class="repo-list">${cards}</div>${pagination}` : emptyState}`;

  return html(baseLayout(`${CATEGORY_LABELS[category] || category} — HotGit`, body));
}

// ── 工具函数 ───────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

// ══════════════════════════════════════════════════════════════════════
// 内联 CSS（与 hotgit 项目保持一致的暗色主题）
// ══════════════════════════════════════════════════════════════════════
const CSS = `
:root{--primary:#238636;--primary-h:#2ea043;--bg:#0d1117;--bg-card:#161b22;--bg-card-h:#1c2128;--border:#30363d;--text:#e6edf3;--text-muted:#8b949e;--accent:#58a6ff;--radius:8px;--shadow:0 2px 12px rgba(0,0,0,.4)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.navbar{display:flex;align-items:center;gap:1.5rem;padding:0 2rem;height:60px;background:var(--bg-card);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.brand{font-size:1.25rem;font-weight:700;color:var(--text)!important;text-decoration:none!important;white-space:nowrap}
.nav-links{display:flex;gap:.25rem;list-style:none;flex-wrap:wrap}
.nav-links a{padding:.3rem .75rem;border-radius:var(--radius);color:var(--text-muted);font-size:.9rem;transition:background .15s,color .15s}
.nav-links a:hover{background:var(--bg-card-h);color:var(--text);text-decoration:none}
.container{max-width:1200px;margin:0 auto;padding:2rem 1.5rem 4rem}
.btn{display:inline-flex;align-items:center;gap:.4rem;padding:.5rem 1.25rem;border-radius:var(--radius);border:1px solid transparent;cursor:pointer;font-size:.9rem;font-weight:500;transition:background .15s,border-color .15s;text-decoration:none!important}
.btn-primary{background:var(--primary);color:#fff;border-color:var(--primary)}.btn-primary:hover{background:var(--primary-h)}
.btn-ghost{background:transparent;color:var(--text-muted);border-color:var(--border)}.btn-ghost:hover{background:var(--bg-card-h);color:var(--text)}
.btn-lg{padding:.65rem 1.75rem;font-size:1rem}
.hero{text-align:center;padding:3.5rem 0 2.5rem}
.hero h1{font-size:2.2rem;margin-bottom:.75rem}
.hero-sub{color:var(--text-muted);margin-bottom:.5rem;font-size:1.05rem}
.hero-date{color:var(--text-muted);margin-bottom:1.5rem;font-size:.9rem}
.hero-date.warning{color:#e3b341}
.crawl-status{display:block;margin-top:.75rem;font-size:.9rem;min-height:1.2em}
.crawl-status.info{color:#58a6ff}.crawl-status.success{color:#3fb950}.crawl-status.error{color:#f85149}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin:2rem 0}
.stat-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem 1.25rem;text-align:center;transition:transform .15s,background .15s,border-color .15s;text-decoration:none!important;color:var(--text)!important}
.stat-card:hover{background:var(--bg-card-h);transform:translateY(-2px);border-color:var(--accent)}
.stat-icon{font-size:2rem;margin-bottom:.5rem}.stat-label{font-weight:600;font-size:1rem}.stat-count{color:var(--text-muted);font-size:.85rem;margin:.25rem 0}.stat-action{color:var(--accent);font-size:.85rem;margin-top:.5rem}
.history{margin-top:2.5rem}.history h2{margin-bottom:.75rem;font-size:1.1rem;color:var(--text-muted)}
.date-list{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none}
.date-list a{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:.25rem .75rem;font-size:.85rem;color:var(--text-muted)}
.date-list a:hover{color:var(--text);border-color:var(--accent);text-decoration:none}
.repos-header{margin-bottom:1.5rem}.repos-header h1{font-size:1.6rem}.data-date{color:var(--text-muted);font-size:.85rem;margin-top:.25rem}
.filter-bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:1.25rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:.75rem 1rem}
.input-search{flex:1;min-width:160px;padding:.4rem .75rem;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:.9rem}
.input-search:focus{outline:none;border-color:var(--accent)}
.select-lang,.select-per-page,.select-date{padding:.4rem .75rem;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:.9rem;cursor:pointer}
.tab-bar{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1.25rem}
.tab{padding:.35rem .9rem;border-radius:20px;border:1px solid var(--border);font-size:.85rem;color:var(--text-muted);transition:background .15s,color .15s,border-color .15s}
.tab:hover{background:var(--bg-card-h);color:var(--text);text-decoration:none}
.tab.active{background:var(--primary);border-color:var(--primary);color:#fff}
.repo-list{display:flex;flex-direction:column;gap:.75rem}
.repo-card{display:flex;gap:1rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem;transition:background .15s,border-color .15s}
.repo-card:hover{background:var(--bg-card-h);border-color:#58a6ff55}
.repo-rank{font-size:1.1rem;font-weight:700;color:var(--text-muted);min-width:36px;padding-top:2px;text-align:center}
.repo-main{flex:1;min-width:0}
.repo-title-line{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-bottom:.35rem}
.repo-name{font-size:1rem;font-weight:600;color:var(--accent)!important}
.repo-name:hover{text-decoration:underline}
.lang-badge{font-size:.72rem;padding:.15rem .55rem;border-radius:12px;background:#21262d;border:1px solid var(--border);color:var(--text-muted)}
.lang-python{border-color:#3572a5;color:#79b8ff}.lang-javascript{border-color:#f1e05a;color:#e3c564}
.lang-typescript{border-color:#2b7489;color:#79d4c8}.lang-go{border-color:#00add8;color:#79d4f0}
.lang-rust{border-color:#dea584;color:#dea584}.lang-java{border-color:#b07219;color:#f0a030}
.lang-shell{border-color:#89e051;color:#89e051}.lang-swift{border-color:#f05138;color:#f05138}
.repo-desc{font-size:.9rem;color:var(--text-muted);margin-bottom:.5rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.repo-topics{display:flex;flex-wrap:wrap;gap:.35rem;margin-bottom:.5rem}
.topic-tag{font-size:.72rem;padding:.1rem .5rem;border-radius:12px;background:#0d2137;border:1px solid #1f4b6e;color:#79b8ff}
.repo-meta{display:flex;flex-wrap:wrap;gap:1rem;font-size:.82rem;color:var(--text-muted);align-items:center}
.meta-link{color:var(--text-muted)}.meta-link:hover{color:var(--accent)}
.pagination{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;margin-top:2rem}
.page-btn{padding:.35rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-muted);font-size:.85rem;cursor:pointer;transition:background .15s,color .15s}
.page-btn:hover{background:var(--bg-card-h);color:var(--text);text-decoration:none}
.page-btn.active{background:var(--primary);border-color:var(--primary);color:#fff}
.page-info{font-size:.82rem;color:var(--text-muted);margin-left:.5rem}
.empty-state{text-align:center;padding:4rem 2rem;color:var(--text-muted)}.empty-state p{margin-bottom:1.25rem}
.footer{border-top:1px solid var(--border);padding:1.25rem;text-align:center;font-size:.82rem;color:var(--text-muted);background:var(--bg-card)}
@media(max-width:640px){.navbar{padding:0 1rem;gap:.75rem}.hero h1{font-size:1.5rem}.repo-card{flex-direction:column;gap:.5rem}.repo-rank{text-align:left}}
`;
