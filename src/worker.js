/**
 * HotGit — Cloudflare Worker
 *
 * 职责：
 *  1. Cron Trigger (04:00 CST = 20:00 UTC 前一天) 自动爬取 GitHub 榜单并写入 D1
 *  2. HTTP 路由：
 *     GET  /              → 首页 HTML
 *     GET  /repos         → 榜单列表页 HTML
 *     GET  /forceupdate   → 立即同步爬取并展示结果
 *     GET  /api/repos     → JSON API（分页/筛选）
 *     GET  /api/stats     → 统计摘要
 *     GET  /api/dates     → 所有爬取日期
 *     POST /api/crawl     → 手动触发爬取（需要 X-Admin-Token 头）
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
    if (path === '/')             return pageIndex(env);
    if (path === '/repos')        return pageRepos(request, env);
    if (path === '/forceupdate')  return pageForceUpdate(env);
    
    // SEO 静态化路由
    const repoMatch = path.match(/^\/repo\/([^\/]+)\/([^\/]+)$/);
    if (repoMatch) {
      return pageRepoDetail(env, repoMatch[1], repoMatch[2]);
    }
    if (path === '/sitemap.xml') return pageSitemap(env);
    if (path === '/robots.txt')  return pageRobots();

    return new Response('Not Found', { status: 404 });
  },

  // Cron Trigger：每天 20:00 UTC = 次日 04:00 CST
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
    try {
      // 转为北京时间（UTC+8）后格式化，避免 UTC 日期与北京时间差一天
      pushedAt = new Date(new Date(pushedAt).getTime() + 8 * 3600_000)
        .toISOString().replace('T', ' ').slice(0, 19);
    }
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

/** 返回 CST（UTC+8）当天日期字符串，格式 YYYY-MM-DD */
function todayCST() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 按天数获取 since 日期字符串（基于 CST） */
function sinceDate(days) {
  const d = new Date(Date.now() + 8 * 3600_000 - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** 爬取所有榜单 */
async function fetchAll(githubToken) {
  const tasks = [
    { name: 'top_stars',    fn: () => githubSearch('stars:>1000',           'stars', githubToken) },
    { name: 'top_forks',    fn: () => githubSearch('forks:>500',            'forks', githubToken) },
    { name: 'star_daily',   fn: () => githubSearch('stars:>100',            'stars', githubToken) },
    { name: 'star_weekly',  fn: () => githubSearch('stars:>100',             'stars', githubToken) },
    { name: 'star_monthly', fn: () => githubSearch('stars:>100',              'stars', githubToken) },
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

/** 保存当日 Star 历史数据 */
async function saveStarsHistory(db, repos, crawlDate) {
  if (!repos.length) return;
  const stmts = repos.map(r =>
    db.prepare(`
      INSERT INTO repo_stars_history (full_name, crawl_date, stars, forks)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(full_name, crawl_date) DO UPDATE SET stars = excluded.stars, forks = excluded.forks
    `).bind(r.full_name, crawlDate, r.stars, r.forks)
  );
  await db.batch(stmts);
}

/** 获取历史 Star 数据 */
async function getHistoryStars(db, fullName, date) {
  const row = await db.prepare(
    'SELECT stars, forks FROM repo_stars_history WHERE full_name = ? AND crawl_date = ?'
  ).bind(fullName, date).first();
  return row || null;
}

/** 主爬取流程：爬取 + 写入 D1 */
async function runCrawl(env) {
  const today = todayCST();
  console.log(`[crawl] start date=${today}`);

  let allRepos;
  try {
    allRepos = await fetchAll(env.GITHUB_TOKEN || '');
  } catch (e) {
    console.error('[crawl] fetchAll error:', e.message);
    await logCrawl(env.DB, today, 'ALL', 0, 'error', e.message);
    return;
  }

  // 先保存所有 repo 的历史数据（用于计算增量）
  const allReposFlat = Object.values(allRepos).flat();
  try {
    await saveStarsHistory(env.DB, allReposFlat, today);
    console.log('[crawl] history saved');
  } catch (e) {
    console.error('[crawl] save history error:', e.message);
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

function getHistoryDate(crawlDate, daysAgo) {
  const [y, m, d] = crawlDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - daysAgo);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function queryRepos(db, { category, crawlDate, page, perPage, lang, search }) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return { total: 0, page, per_page: perPage, data: [] };

  const isDaily = category === 'star_daily';
  const isWeekly = category === 'star_weekly';
  const isMonthly = category === 'star_monthly';
  const isIncrement = isDaily || isWeekly || isMonthly;

  let historyDate = null;
  if (isDaily) historyDate = getHistoryDate(crawlDate, 1);
  else if (isWeekly) historyDate = getHistoryDate(crawlDate, 7);
  else if (isMonthly) historyDate = getHistoryDate(crawlDate, 30);

  const conditions = ['crawl_date = ?', 'category = ?'];
  const params     = [crawlDate, category];

  if (lang)   { conditions.push('language = ?');                     params.push(lang); }
  if (search) { conditions.push('(full_name LIKE ? OR description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

  const where = conditions.join(' AND ');

  let rows;
  if (isIncrement && historyDate) {
    try {
      rows = await db.prepare(
        `SELECT r.*, h.stars AS history_stars, h.forks AS history_forks 
         FROM repos r 
         LEFT JOIN repo_stars_history h ON r.full_name = h.full_name AND h.crawl_date = ?
         WHERE ${where}`
      ).bind(historyDate, ...params).all();
    } catch (e) {
      if (e.message.includes('no such table') || e.message.includes('repo_stars_history')) {
        rows = await db.prepare(
          `SELECT * FROM repos WHERE ${where}`
        ).bind(...params).all();
        rows.results = rows.results.map(r => ({ ...r, history_stars: null }));
      } else {
        throw e;
      }
    }
  } else {
    rows = await db.prepare(
      `SELECT * FROM repos WHERE ${where}`
    ).bind(...params).all();
  }

  let data = rows.results;

  if (isIncrement && historyDate) {
    data = data.map(r => ({
      ...r,
      stars_incr: r.history_stars !== null ? r.stars - r.history_stars : null,
      forks_incr: r.history_forks !== null ? r.forks - r.history_forks : null,
    }));
    const hasHistory = data.some(r => r.stars_incr !== null);
    if (hasHistory) {
      data.sort((a, b) => {
        const aIncr = a.stars_incr ?? -Infinity;
        const bIncr = b.stars_incr ?? -Infinity;
        return bIncr - aIncr;
      });
    } else {
      data.sort((a, b) => b.stars - a.stars);
    }
    data = data.map((r, i) => ({ ...r, rank: i + 1 }));
  }

  const total = data.length;
  const offset = (page - 1) * perPage;
  data = data.slice(offset, offset + perPage);

  return { total, page, per_page: perPage, data };
}

async function getLanguages(db, category, crawlDate) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return [];
  const rows = await db.prepare(
    'SELECT DISTINCT language FROM repos WHERE crawl_date=? AND category=? AND language IS NOT NULL ORDER BY language'
  ).bind(crawlDate, category).all();
  return rows.results.map(r => r.language).filter(Boolean);
}

async function getRepoByName(db, fullName, crawlDate) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return null;
  const rows = await db.prepare(
    'SELECT * FROM repos WHERE crawl_date = ? AND full_name = ?'
  ).bind(crawlDate, fullName).all();
  return rows.results[0] || null;
}

async function getRelatedRepos(db, language, excludeFullName, crawlDate, limit = 10) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return [];
  const rows = await db.prepare(
    'SELECT * FROM repos WHERE crawl_date = ? AND language = ? AND full_name != ? ORDER BY stars DESC LIMIT ?'
  ).bind(crawlDate, language, excludeFullName, limit).all();
  return rows.results;
}

async function getAllRepoNames(db, limit = 1000) {
  const crawlDate = await getLatestDate(db);
  if (!crawlDate) return [];
  const rows = await db.prepare(
    'SELECT DISTINCT full_name FROM repos WHERE crawl_date = ? ORDER BY stars DESC LIMIT ?'
  ).bind(crawlDate, limit).all();
  return rows.results.map(r => r.full_name);
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
    <p>HotGit — GitHub 热门仓库追踪 · 数据每日 04:00 CST 自动更新 · Powered by Cloudflare Workers</p>
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
      : `<p class="hero-date warning">暂无数据，请访问 <a href="/forceupdate">/forceupdate</a> 立即更新</p>`}
  </section>
  <section class="stats-grid">${catCards}</section>
  ${dates.length ? `<section class="history"><h2>历史数据</h2><ul class="date-list">${dateList}</ul></section>` : ''}`;

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

  const isIncrement = ['star_daily', 'star_weekly', 'star_monthly'].includes(category);

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
    
    let starsDisplay, forksDisplay;
    if (isIncrement && repo.stars_incr !== undefined && repo.stars_incr !== null) {
      const incrClass = repo.stars_incr > 0 ? 'incr-pos' : repo.stars_incr < 0 ? 'incr-neg' : '';
      const incrSign = repo.stars_incr > 0 ? '+' : '';
      starsDisplay = `<span class="${incrClass}">⭐ ${fmtNum(repo.stars)} <span class="incr">(${incrSign}${fmtNum(repo.stars_incr)})</span></span>`;
      forksDisplay = repo.forks_incr !== undefined && repo.forks_incr !== null 
        ? `<span class="${repo.forks_incr > 0 ? 'incr-pos' : repo.forks_incr < 0 ? 'incr-neg' : ''}">🍴 ${fmtNum(repo.forks)} <span class="incr">(${repo.forks_incr > 0 ? '+' : ''}${fmtNum(repo.forks_incr)})</span></span>` 
        : `<span>🍴 ${fmtNum(repo.forks)}</span>`;
    } else {
      starsDisplay = `<span>⭐ ${fmtNum(repo.stars)}</span>`;
      forksDisplay = `<span>🍴 ${fmtNum(repo.forks)}</span>`;
    }
    
    const repoDetailUrl = `/repo/${repo.full_name.replace('/', '%2F')}`;
    return `
    <div class="repo-card">
      <div class="repo-rank">#${repo.rank}</div>
      <div class="repo-main">
        <div class="repo-title-line">
          <a class="repo-name" href="${repoDetailUrl}">${escHtml(repo.full_name)}</a>
          ${langBadge}
        </div>
        ${repo.description ? `<p class="repo-desc">${escHtml(repo.description)}</p>` : ''}
        ${topics ? `<div class="repo-topics">${topics}</div>` : ''}
        <div class="repo-meta">
          ${starsDisplay}
          ${forksDisplay}
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
    ? `<div class="empty-state"><p>暂无数据，请访问 <a href="/forceupdate">/forceupdate</a> 立即更新。</p><a class="btn btn-primary" href="/forceupdate">立即更新数据</a></div>`
    : '';

  const body = `
  <div class="repos-header">
    <h1>${CATEGORY_LABELS[category] || category}</h1>
    ${crawlDate ? `<p class="data-date">数据日期：${crawlDate}</p>` : ''}
  </div>
  <form class="filter-bar" method="get" action="/repos">
    <input type="hidden" name="category" value="${category}"/>
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

async function pageForceUpdate(env) {
  const startTime = Date.now();
  const today = todayCST();
  const results = [];
  let hasError = false;

  // 逐个分类爬取，记录结果（不改变按天记录的逻辑，saveRepos 会覆盖今天同类数据）
  const tasks = [
    { name: 'top_stars',    label: CATEGORY_LABELS.top_stars,    fn: () => githubSearch('stars:>1000',           'stars', env.GITHUB_TOKEN || '') },
    { name: 'top_forks',    label: CATEGORY_LABELS.top_forks,    fn: () => githubSearch('forks:>500',            'forks', env.GITHUB_TOKEN || '') },
    { name: 'star_daily',   label: CATEGORY_LABELS.star_daily,   fn: () => githubSearch('stars:>100',             'stars', env.GITHUB_TOKEN || '') },
    { name: 'star_weekly',  label: CATEGORY_LABELS.star_weekly,  fn: () => githubSearch('stars:>100',            'stars', env.GITHUB_TOKEN || '') },
    { name: 'star_monthly', label: CATEGORY_LABELS.star_monthly, fn: () => githubSearch('stars:>100',             'stars', env.GITHUB_TOKEN || '') },
  ];

  for (const task of tasks) {
    const t0 = Date.now();
    try {
      const items = await task.fn();
      const repos = items.slice(0, 100).map((r, i) => fmtRepo(r, task.name, i + 1));
      await saveRepos(env.DB, repos, today);
      await logCrawl(env.DB, today, task.name, repos.length, 'ok', '');
      results.push({ name: task.name, label: task.label, count: repos.length, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      await logCrawl(env.DB, today, task.name, 0, 'error', e.message);
      results.push({ name: task.name, label: task.label, count: 0, ok: false, ms: Date.now() - t0, error: e.message });
      hasError = true;
    }
    // 避免 GitHub 限流
    await new Promise(r => setTimeout(r, 1000));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalCount = results.reduce((s, r) => s + r.count, 0);

  const rows = results.map(r => `
    <tr class="${r.ok ? '' : 'row-error'}">
      <td>${r.label}</td>
      <td>${r.ok ? `<span class="badge-ok">✅ 成功</span>` : `<span class="badge-err">❌ 失败</span>`}</td>
      <td>${r.ok ? r.count + ' 个' : '—'}</td>
      <td>${(r.ms / 1000).toFixed(1)}s</td>
      ${r.ok ? '<td>—</td>' : `<td class="err-msg">${escHtml(r.error || '')}</td>`}
    </tr>`).join('');

  const summary = hasError
    ? `<p class="result-summary warn">⚠️ 部分分类更新失败，共写入 ${totalCount} 条数据，耗时 ${elapsed}s</p>`
    : `<p class="result-summary ok">✅ 全部更新成功，共写入 ${totalCount} 条数据，耗时 ${elapsed}s</p>`;

  const body = `
  <div class="repos-header">
    <h1>🔄 立即更新数据</h1>
    <p class="data-date">更新日期：${today}</p>
  </div>
  ${summary}
  <table class="result-table">
    <thead>
      <tr><th>分类</th><th>状态</th><th>写入数量</th><th>耗时</th><th>错误信息</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="result-actions">
    <a class="btn btn-primary" href="/">返回首页</a>
    <a class="btn btn-ghost" href="/repos?category=top_stars">查看榜单</a>
    <a class="btn btn-ghost" href="/forceupdate">再次更新</a>
  </div>`;

  return html(baseLayout('立即更新 — HotGit', body));
}

async function pageRepoDetail(env, owner, name) {
  const fullName = `${owner}/${name}`;
  const repo = await getRepoByName(env.DB, fullName);
  
  if (!repo) {
    return html(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"/><title>仓库未找到 — HotGit</title></head>
<body><h1>仓库未找到</h1><p>${escHtml(fullName)} 不在热门榜单中</p><a href="/">返回首页</a></body>
</html>`, 404);
  }

  const related = await getRelatedRepos(env.DB, repo.language, fullName);
  const crawlDate = await getLatestDate(env.DB);
  
  const title = `${repo.full_name} — HotGit`;
  const description = repo.description || `${repo.full_name} - ${repo.language} 项目，⭐ ${fmtNum(repo.stars)} Stars`;
  
  const repoLink = `
  <div class="repo-detail-header">
    <h1>
      <a href="${escHtml(repo.html_url)}" target="_blank" rel="noopener">${escHtml(repo.full_name)}</a>
      ${repo.language && repo.language !== 'Unknown' ? `<span class="lang-badge">${escHtml(repo.language)}</span>` : ''}
    </h1>
    ${repo.description ? `<p class="repo-desc">${escHtml(repo.description)}</p>` : ''}
  </div>
  <div class="repo-stats">
    <div class="stat-item"><span class="stat-value">⭐ ${fmtNum(repo.stars)}</span><span class="stat-label">Stars</span></div>
    <div class="stat-item"><span class="stat-value">🍴 ${fmtNum(repo.forks)}</span><span class="stat-label">Forks</span></div>
    <div class="stat-item"><span class="stat-value">🐛 ${repo.open_issues}</span><span class="stat-label">Issues</span></div>
    <div class="stat-item"><span class="stat-value">🕐 ${repo.pushed_at ? repo.pushed_at.slice(0,10) : '—'}</span><span class="stat-label">最近更新</span></div>
  </div>
  <div class="repo-links">
    <a class="btn btn-primary" href="${escHtml(repo.html_url)}" target="_blank" rel="noopener">🔗 GitHub</a>
    ${repo.homepage ? `<a class="btn btn-ghost" href="${escHtml(repo.homepage)}" target="_blank" rel="noopener">🌐 主页</a>` : ''}
  </div>`;

  const topicsHtml = repo.topics 
    ? `<div class="repo-topics">${repo.topics.split(',').filter(Boolean).map(t => `<span class="topic-tag">${escHtml(t)}</span>`).join('')}</div>` 
    : '';

  const relatedHtml = related.length 
    ? `<section class="related-repos"><h2>同语言热门项目</h2><div class="repo-list">${related.map(r => `
      <a class="repo-card" href="/repo/${escHtml(r.full_name.replace('/', '%2F'))}">
        <div class="repo-main">
          <div class="repo-title-line"><span class="repo-name">${escHtml(r.full_name)}</span></div>
          <div class="repo-meta"><span>⭐ ${fmtNum(r.stars)}</span><span>🍴 ${fmtNum(r.forks)}</span></div>
        </div>
      </a>`).join('')}</div></section>`
    : '';

  const canonicalUrl = `https://hotgit-cf.linkai.workers.dev/repo/${owner}/${name}`;

  const body = `
  ${repoLink}
  ${topicsHtml}
  ${relatedHtml}`;

  const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${title}</title>
  <meta name="description" content="${description}"/>
  <link rel="canonical" href="${canonicalUrl}"/>
  <meta property="og:title" content="${title}"/>
  <meta property="og:description" content="${description}"/>
  <meta property="og:url" content="${canonicalUrl}"/>
  <meta property="og:type" content="article"/>
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
  <main class="container">${body}</main>
  <footer class="footer">
    <p>HotGit — GitHub 热门仓库追踪 · 数据每日 04:00 CST 自动更新 · Powered by Cloudflare Workers</p>
  </footer>
</body>
</html>`;

  return new Response(htmlContent, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

async function pageSitemap(env) {
  const host = 'https://hotgit-cf.linkai.workers.dev';
  const repoNames = await getAllRepoNames(env.DB);
  const dates = await getCrawlDates(env.DB);
  
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${host}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>${host}/repos</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
  <url><loc>${host}/repos?category=top_stars</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  <url><loc>${host}/repos?category=top_forks</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  <url><loc>${host}/repos?category=star_daily</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  <url><loc>${host}/repos?category=star_weekly</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>${host}/repos?category=star_monthly</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`;

  for (const name of repoNames) {
    const [owner, repo] = name.split('/');
    xml += `
  <url><loc>${host}/repo/${owner}/${repo}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`;
  }

  xml += `
</urlset>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
}

function pageRobots() {
  const robots = `User-agent: *
Allow: /

Sitemap: https://hotgit-cf.linkai.workers.dev/sitemap.xml
`;
  return new Response(robots, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
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
.incr{font-size:.75rem;margin-left:.15rem}
.incr-pos{color:#3fb950}.incr-neg{color:#f85149}
.pagination{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;margin-top:2rem}
.page-btn{padding:.35rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-muted);font-size:.85rem;cursor:pointer;transition:background .15s,color .15s}
.page-btn:hover{background:var(--bg-card-h);color:var(--text);text-decoration:none}
.page-btn.active{background:var(--primary);border-color:var(--primary);color:#fff}
.page-info{font-size:.82rem;color:var(--text-muted);margin-left:.5rem}
.empty-state{text-align:center;padding:4rem 2rem;color:var(--text-muted)}.empty-state p{margin-bottom:1.25rem}
.result-summary{margin:1.25rem 0;padding:.75rem 1.25rem;border-radius:var(--radius);font-size:.95rem;border:1px solid var(--border)}
.result-summary.ok{background:#0d2137;border-color:#1f4b6e;color:#3fb950}
.result-summary.warn{background:#1c1a00;border-color:#6e5a00;color:#e3b341}
.result-table{width:100%;border-collapse:collapse;margin:1rem 0;font-size:.9rem}
.result-table th{padding:.6rem 1rem;text-align:left;background:var(--bg-card);border-bottom:2px solid var(--border);color:var(--text-muted);font-weight:600}
.result-table td{padding:.6rem 1rem;border-bottom:1px solid var(--border);color:var(--text)}
.result-table tr:last-child td{border-bottom:none}
.result-table tr.row-error td{background:#1a0a0a}
.badge-ok{color:#3fb950;font-size:.85rem}.badge-err{color:#f85149;font-size:.85rem}
.err-msg{color:#f85149;font-size:.82rem;word-break:break-all;max-width:300px}
.result-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:2rem}
.repo-detail-header{margin-bottom:1.5rem}
.repo-detail-header h1{font-size:1.8rem;display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;margin-bottom:.5rem}
.repo-detail-header .repo-desc{font-size:1.1rem;color:var(--text-muted);margin-top:.5rem}
.repo-stats{display:flex;flex-wrap:wrap;gap:1.5rem;margin:1.5rem 0}
.repo-stats .stat-item{display:flex;flex-direction:column;align-items:center;padding:1rem 1.5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);min-width:100px}
.repo-stats .stat-value{font-size:1.25rem;font-weight:700}
.repo-stats .stat-label{font-size:.8rem;color:var(--text-muted);margin-top:.25rem}
.repo-links{display:flex;gap:.75rem;margin:1.5rem 0}
.related-repos{margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--border)}
.related-repos h2{font-size:1.2rem;margin-bottom:1rem;color:var(--text-muted)}
.related-repos .repo-card{display:flex;gap:1rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem;margin-bottom:.75rem;transition:background .15s,border-color .15s}
.related-repos .repo-card:hover{background:var(--bg-card-h);border-color:#58a6ff}
.related-repos .repo-main{flex:1;min-width:0}
.related-repos .repo-title-line{display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem}
.related-repos .repo-name{font-size:1rem;font-weight:600}
.related-repos .repo-meta{display:flex;gap:1rem;font-size:.82rem;color:var(--text-muted)}
.footer{border-top:1px solid var(--border);padding:1.25rem;text-align:center;font-size:.82rem;color:var(--text-muted);background:var(--bg-card)}
@media(max-width:640px){.navbar{padding:0 1rem;gap:.75rem}.hero h1{font-size:1.5rem}.repo-card{flex-direction:column;gap:.5rem}.repo-rank{text-align:left}.repo-stats{gap:.75rem}.repo-stats .stat-item{min-width:80px;padding:.75rem}}
`;
