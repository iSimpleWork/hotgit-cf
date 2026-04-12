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
const DEFAULT_DOMAIN = 'hotgit-cf.linkai.workers.dev';

let DOMAIN = DEFAULT_DOMAIN;

function getDomain(env) {
  return env.DOMAIN || DOMAIN;
}

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
    
    // SEO 静态化路由 /repo/owner/repo 或 /repo/owner%2Frepo
    const repoMatch = path.match(/^\/repo\/([^\/]+)\/([^\/]+)$/);
    if (repoMatch) {
      let owner = repoMatch[1];
      let name = repoMatch[2];
      try { owner = decodeURIComponent(owner); } catch(e) {}
      try { name = decodeURIComponent(name); } catch(e) {}
      const fullName = `${owner}/${name}`;
      console.log('[repo] path:', path, '-> fullName:', fullName);
      return pageRepoDetail(env, owner, name);
    }
    // ID 路由 /r/123
    const idMatch = path.match(/^\/r\/(\d+)$/);
    if (idMatch) {
      return pageRepoDetailById(env, parseInt(idMatch[1]));
    }
    if (path === '/sitemap.xml') return pageSitemap(env);
    if (path === '/robots.txt')  return pageRobots(env);

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

async function githubRepo(fullName, githubToken) {
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': USER_AGENT,
  };
  if (githubToken) headers['Authorization'] = `token ${githubToken}`;

  const res = await fetch(`${GITHUB_API}/repos/${fullName}`, {
    headers,
    cf: { cacheTtl: 300, cacheEverything: false },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub repo API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

function parseTrendingRepoNames(html) {
  const names = [];
  const seen = new Set();
  const matches = html.matchAll(/<h2[^>]*>\s*<a[^>]*href="\/([\w.-]+\/[\w.-]+)"/g);

  for (const match of matches) {
    const fullName = match[1];
    if (!fullName || seen.has(fullName)) continue;
    if (fullName.includes('/pulls') || fullName.includes('/issues')) continue;
    seen.add(fullName);
    names.push(fullName);
  }

  return names;
}

async function fetchTrendingRepos(githubToken) {
  const res = await fetch('https://github.com/trending?since=daily', {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
    },
    cf: { cacheTtl: 300, cacheEverything: false },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub Trending ${res.status}: ${text.slice(0, 200)}`);
  }

  const html = await res.text();
  const repoNames = parseTrendingRepoNames(html).slice(0, 25);
  if (!repoNames.length) {
    throw new Error('GitHub Trending parse error: no repositories found');
  }

  const repos = [];
  for (const fullName of repoNames) {
    try {
      repos.push(await githubRepo(fullName, githubToken));
    } catch (e) {
      console.error('[trending] repo detail error:', fullName, e.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return repos;
}

function daysSince(dateString, now = Date.now()) {
  if (!dateString) return Infinity;
  const ts = Date.parse(dateString);
  if (Number.isNaN(ts)) return Infinity;
  return Math.max(0, Math.floor((now - ts) / 86400_000));
}

function scorePotentialDailyRepo(repo, { historyDay, historyWeek, isTrending, now = Date.now() }) {
  const stars = repo.stargazers_count || 0;
  const dailyGain = historyDay ? Math.max(0, stars - (historyDay.stars || 0)) : 0;
  const weeklyGain = historyWeek ? Math.max(0, stars - (historyWeek.stars || 0)) : 0;
  const ageDays = daysSince(repo.created_at, now);
  const pushedDays = daysSince(repo.pushed_at || repo.updated_at, now);

  const trendingBoost = isTrending ? 120 : 0;
  const freshnessBoost = ageDays <= 7 ? 80 : ageDays <= 30 ? 45 : ageDays <= 90 ? 20 : 0;
  const activityBoost = pushedDays <= 1 ? 30 : pushedDays <= 3 ? 15 : 0;
  const normalizedDaily = dailyGain > 0 ? dailyGain / Math.max(Math.sqrt(stars), 8) : 0;
  const normalizedWeekly = weeklyGain > 0 ? weeklyGain / Math.max(Math.sqrt(stars), 8) : 0;
  const coldStartBoost = !historyDay && ageDays <= 30 ? Math.min(stars, 300) * 0.2 : 0;

  const score =
    trendingBoost +
    freshnessBoost +
    activityBoost +
    dailyGain * 3 +
    weeklyGain * 0.8 +
    normalizedDaily * 120 +
    normalizedWeekly * 40 +
    coldStartBoost;

  return {
    score,
    dailyGain,
    weeklyGain,
  };
}

function comparePotentialDailyRepo(a, b) {
  const aTrending = a.sources.has('trending') ? 1 : 0;
  const bTrending = b.sources.has('trending') ? 1 : 0;
  if (bTrending !== aTrending) return bTrending - aTrending;

  if (b.dailyGain !== a.dailyGain) return b.dailyGain - a.dailyGain;

  const aStars = a.repo.stargazers_count || 0;
  const bStars = b.repo.stargazers_count || 0;
  if (bStars !== aStars) return bStars - aStars;

  if (b.weeklyGain !== a.weeklyGain) return b.weeklyGain - a.weeklyGain;
  if (b.score !== a.score) return b.score - a.score;

  return a.repo.full_name.localeCompare(b.repo.full_name);
}

async function fetchPotentialDailyRepos(db, githubToken) {
  const today = todayCST();
  const dayDate = getHistoryDate(today, 1);
  const weekDate = getHistoryDate(today, 7);
  const sources = [
    { name: 'trending', limit: 25, fn: () => fetchTrendingRepos(githubToken) },
    { name: 'fresh_new', limit: 100, fn: () => githubSearch(`archived:false created:>=${sinceDate(14)} stars:>=10`, 'stars', githubToken) },
    { name: 'fresh_rising', limit: 100, fn: () => githubSearch(`archived:false created:>=${sinceDate(90)} stars:20..5000`, 'stars', githubToken) },
    { name: 'active_rising', limit: 100, fn: () => githubSearch(`archived:false pushed:>=${sinceDate(3)} stars:20..10000`, 'updated', githubToken) },
  ];

  const candidates = new Map();

  for (const source of sources) {
    try {
      const items = await source.fn();
      for (const repo of items.slice(0, source.limit)) {
        if (!repo?.full_name) continue;
        const existing = candidates.get(repo.full_name);
        if (existing) {
          existing.sources.add(source.name);
          continue;
        }
        candidates.set(repo.full_name, { repo, sources: new Set([source.name]) });
      }
    } catch (e) {
      console.error('[star_daily] source error:', source.name, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const scored = [];
  for (const candidate of candidates.values()) {
    const historyDay = await getHistoryStars(db, candidate.repo.full_name, dayDate);
    const historyWeek = await getHistoryStars(db, candidate.repo.full_name, weekDate);
    const scoring = scorePotentialDailyRepo(candidate.repo, {
      historyDay,
      historyWeek,
      isTrending: candidate.sources.has('trending'),
    });
    scored.push({
      ...candidate,
      ...scoring,
    });
  }

  scored.sort(comparePotentialDailyRepo);

  return scored.slice(0, 100).map((item, index) => fmtRepo(item.repo, 'star_daily', index + 1));
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
async function fetchAll(db, githubToken) {
  const tasks = [
    { name: 'top_stars',    fn: () => githubSearch('stars:>1000',           'stars', githubToken) },
    { name: 'top_forks',    fn: () => githubSearch('forks:>500',            'forks', githubToken) },
    { name: 'star_daily',   fn: () => fetchPotentialDailyRepos(db, githubToken) },
    { name: 'star_weekly',  fn: () => githubSearch('stars:>100',             'stars', githubToken) },
    { name: 'star_monthly', fn: () => githubSearch('stars:>100',              'stars', githubToken) },
  ];

  const result = {};
  // 顺序执行，避免 GitHub 限流
  for (const { name, fn } of tasks) {
    const items = await fn();
    result[name] = name === 'star_daily'
      ? items
      : items.slice(0, 100).map((r, i) => fmtRepo(r, name, i + 1));
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
    allRepos = await fetchAll(env.DB, env.GITHUB_TOKEN || '');
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
      // 先翻译并保存
      await translateAndSaveRepos(env.DB, repos);
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
         language, stars, forks, open_issues, pushed_at, topics, homepage,
         translated_name, translated_desc)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      crawlDate, r.category, r.rank, r.full_name, r.html_url,
      r.description, r.language, r.stars, r.forks, r.open_issues,
      r.pushed_at, r.topics, r.homepage,
      r.translated_name || '', r.translated_desc || ''
    )
  );
  await db.batch(stmts);
}

async function translateAndSaveRepos(db, repos) {
  for (const r of repos) {
    const nameText = r.full_name || '';
    const descText = r.description || '';
    const isZh = /[\u4e00-\u9fa5]/.test(descText) || /[\u4e00-\u9fa5]/.test(nameText);
    const targetLang = isZh ? 'en' : 'zh';
    
    if (nameText && !r.translated_name) {
      const nameToTranslate = nameText.split('/')[1] || nameText;
      r.translated_name = await translateText(db, nameToTranslate, targetLang);
    }
    
    if (descText && !r.translated_desc) {
      r.translated_desc = await translateText(db, descText, targetLang);
    }
    
    // 间隔避免 API 限流
    await new Promise(x => setTimeout(x, 200));
  }
}

async function logCrawl(db, crawlDate, category, count, status, message) {
  await db.prepare(
    'INSERT INTO crawl_log (crawl_date,category,count,status,message) VALUES (?,?,?,?,?)'
  ).bind(crawlDate, category, count, status, message).run();
}

async function getLatestDate(db) {
  try {
    const row = await db.prepare('SELECT MAX(crawl_date) AS d FROM repos').first();
    return row?.d || null;
  } catch (e) {
    console.error('[getLatestDate] error:', e.message);
    return null;
  }
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
  try {
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

    const conditions = ['repos.crawl_date = ?', 'repos.category = ?'];
    const params     = [crawlDate, category];

    if (lang)   { conditions.push('repos.language = ?'); params.push(lang); }
    if (search) {
      conditions.push('(repos.full_name LIKE ? OR repos.description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const where = conditions.join(' AND ');

    let rows;
    if (isIncrement && historyDate) {
      rows = await db.prepare(
        `SELECT repos.*, h.stars AS history_stars, h.forks AS history_forks 
         FROM repos 
         LEFT JOIN repo_stars_history h ON repos.full_name = h.full_name AND h.crawl_date = ?
         WHERE ${where}`
      ).bind(historyDate, ...params).all();
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
  } catch (e) {
    console.error('[queryRepos] error:', e.message);
    return { total: 0, page, per_page: perPage, data: [] };
  }
}

async function getLanguages(db, category, crawlDate) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return [];
  const rows = await db.prepare(
    'SELECT DISTINCT language FROM repos WHERE crawl_date=? AND category=? AND language IS NOT NULL ORDER BY language'
  ).bind(crawlDate, category).all();
  return rows.results.map(r => r.language).filter(Boolean);
}

async function getRepoById(db, id, crawlDate) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return null;
  const rows = await db.prepare(
    'SELECT * FROM repos WHERE crawl_date = ? AND id = ?'
  ).bind(crawlDate, id).all();
  if (rows.results.length > 0) return rows.results[0];
  // 如果当天没有，查询最近有数据的一天
  const latestRow = await db.prepare(
    'SELECT crawl_date FROM repos WHERE id = ? ORDER BY crawl_date DESC LIMIT 1'
  ).bind(id).first();
  if (!latestRow) return null;
  const rows2 = await db.prepare(
    'SELECT * FROM repos WHERE crawl_date = ? AND id = ?'
  ).bind(latestRow.crawl_date, id).all();
  return rows2.results[0] || null;
}

async function getRepoByName(db, fullName, crawlDate) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  console.log('[getRepoByName] fullName:', fullName, 'crawlDate:', crawlDate);
  if (!crawlDate) return null;
  const rows = await db.prepare(
    'SELECT * FROM repos WHERE crawl_date = ? AND full_name = ?'
  ).bind(crawlDate, fullName).all();
  console.log('[getRepoByName] found:', rows.results.length, 'on', crawlDate);
  if (rows.results.length > 0) return rows.results[0];
  // 如果当天没有，查询最近有数据的一天
  const latestRow = await db.prepare(
    'SELECT crawl_date FROM repos WHERE full_name = ? ORDER BY crawl_date DESC LIMIT 1'
  ).bind(fullName).first();
  console.log('[getRepoByName] latestRow:', latestRow);
  if (!latestRow) return null;
  const rows2 = await db.prepare(
    'SELECT * FROM repos WHERE crawl_date = ? AND full_name = ?'
  ).bind(latestRow.crawl_date, fullName).all();
  console.log('[getRepoByName] found on latest:', rows2.results.length);
  return rows2.results[0] || null;
}

async function getRelatedRepos(db, language, excludeFullName, crawlDate, limit = 10) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return [];
  const rows = await db.prepare(
    'SELECT full_name, MAX(stars) as stars, MAX(forks) as forks, MAX(html_url) as html_url, MAX(description) as description, MAX(language) as language, MAX(pushed_at) as pushed_at, MAX(topics) as topics, MAX(homepage) as homepage, MAX(open_issues) as open_issues, MAX(rank) as rank, MAX(id) as id FROM repos WHERE crawl_date = ? AND language = ? AND full_name != ? GROUP BY full_name ORDER BY stars DESC LIMIT ?'
  ).bind(crawlDate, language, excludeFullName, limit).all();
  console.log('[getRelatedRepos] found:', rows.results.length, 'language:', language);
  if (rows.results.length > 0) return rows.results;
  // 如果当天没有，查询最近有数据的一天
  const latestRow = await db.prepare(
    'SELECT crawl_date FROM repos WHERE language = ? ORDER BY crawl_date DESC LIMIT 1'
  ).bind(language).first();
  if (!latestRow) return [];
  const rows2 = await db.prepare(
    'SELECT full_name, MAX(stars) as stars, MAX(forks) as forks, MAX(html_url) as html_url, MAX(description) as description, MAX(language) as language, MAX(pushed_at) as pushed_at, MAX(topics) as topics, MAX(homepage) as homepage, MAX(open_issues) as open_issues, MAX(rank) as rank, MAX(id) as id FROM repos WHERE crawl_date = ? AND language = ? AND full_name != ? GROUP BY full_name ORDER BY stars DESC LIMIT ?'
  ).bind(latestRow.crawl_date, language, excludeFullName, limit).all();
  return rows2.results;
}

async function getRepoHistory(db, fullName, days = 30) {
  try {
    const rows = await db.prepare(
      'SELECT crawl_date, stars, forks FROM repos WHERE full_name = ? GROUP BY crawl_date ORDER BY crawl_date DESC LIMIT ?'
    ).bind(fullName, days).all();
    console.log('[getRepoHistory]', fullName, 'found:', rows.results.length);
    return rows.results.reverse();
  } catch (e) {
    console.log('[getRepoHistory] error:', e.message);
    return [];
  }
}

async function getCachedTranslation(db, textHash, targetLang) {
  const row = await db.prepare(
    'SELECT translated_text FROM translations WHERE text_hash = ? AND target_lang = ? AND created_at > datetime("now", "-1 day")'
  ).bind(textHash, targetLang).first();
  return row?.translated_text || null;
}

async function saveTranslation(db, textHash, targetLang, translatedText) {
  await db.prepare(
    'INSERT OR REPLACE INTO translations (text_hash, target_lang, translated_text, created_at) VALUES (?, ?, ?, datetime("now"))'
  ).bind(textHash, targetLang, translatedText).run();
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return String(hash);
}

async function translateText(db, text, targetLang = 'en') {
  if (!text || text.length < 3) return null;
  const sourceLang = /[\u4e00-\u9fa5]/.test(text) ? 'zh' : 'en';
  if (sourceLang === targetLang) {
    console.log('[translate] skip: source same as target', sourceLang);
    return null;
  }
  
  const textHash = hashString(text);
  
  // 尝试从缓存读取，忽略表不存在错误
  try {
    const cached = await getCachedTranslation(db, textHash, targetLang);
    if (cached) {
      console.log('[translate] cache hit:', textHash);
      return cached;
    }
  } catch (e) {
    console.log('[translate] cache read error (table may not exist):', e.message);
  }
  
  try {
    const langPair = `${sourceLang}|${targetLang}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${langPair}`;
    console.log('[translate] calling API:', text.slice(0, 30), '->', targetLang);
    const res = await fetch(url);
    const data = await res.json();
    console.log('[translate] API response:', JSON.stringify(data).slice(0, 100));
    if (data.responseStatus === 200 && data.responseData?.translatedText) {
      const translatedText = data.responseData.translatedText;
      try {
        await saveTranslation(db, textHash, targetLang, translatedText);
      } catch (e) {
        console.log('[translate] save cache error:', e.message);
      }
      return translatedText;
    }
  } catch (e) {
    console.log('[translate] error:', e.message);
  }
  return null;
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

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

const ANALYTICS_HEAD_SNIPPET = `
  <meta name="google-adsense-account" content="ca-pub-0790471852661955"/>
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-RJDEV8XM5Y"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-RJDEV8XM5Y');
  </script>`;

function baseLayout(title, bodyContent) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${title}</title>
  <link rel="stylesheet" href="/static/css/style.css"/>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔥</text></svg>"/>
${ANALYTICS_HEAD_SNIPPET}
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
    
    const nameUrl = encodeURIComponent(repo.full_name);
    const repoDetailUrl = `/repo/${nameUrl}`;
    const repoIdUrl = `/r/${repo.id}`;
    return `
    <div class="repo-card">
      <div class="repo-rank">#${repo.rank}</div>
      <div class="repo-main">
        <div class="repo-title-line">
          <a class="repo-name" href="${repoIdUrl}">${escHtml(repo.full_name)}</a>
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
    { name: 'star_daily',   label: CATEGORY_LABELS.star_daily,   fn: () => fetchPotentialDailyRepos(env.DB, env.GITHUB_TOKEN || '') },
    { name: 'star_weekly',  label: CATEGORY_LABELS.star_weekly,  fn: () => githubSearch('stars:>100',            'stars', env.GITHUB_TOKEN || '') },
    { name: 'star_monthly', label: CATEGORY_LABELS.star_monthly, fn: () => githubSearch('stars:>100',             'stars', env.GITHUB_TOKEN || '') },
  ];

  for (const task of tasks) {
    const t0 = Date.now();
    try {
      const items = await task.fn();
      const repos = task.name === 'star_daily'
        ? items
        : items.slice(0, 100).map((r, i) => fmtRepo(r, task.name, i + 1));
      await translateAndSaveRepos(env.DB, repos);
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
<head><meta charset="UTF-8"/><title>仓库未找到 — HotGit</title>${ANALYTICS_HEAD_SNIPPET}
</head>
<body><h1>仓库未找到</h1><p>${escHtml(fullName)} 不在热门榜单中</p><a href="/">返回首页</a></body>
</html>`, 404);
  }

  const history = await getRepoHistory(env.DB, fullName, 30);
  const related = await getRelatedRepos(env.DB, repo.language, fullName);
  const crawlDate = await getLatestDate(env.DB);
  
  const title = `${repo.full_name} — HotGit`;
  const description = repo.description || `${repo.full_name} - ${repo.language} 项目，⭐ ${fmtNum(repo.stars)} Stars`;
  
  const translatedName = repo.translated_name || '';
  const translatedDesc = repo.translated_desc || '';
  
  const repoLink = `
  <div class="repo-detail-header">
    <h1>
      <a href="${escHtml(repo.html_url)}" target="_blank" rel="noopener">${escHtml(repo.full_name)}</a>
      ${repo.language && repo.language !== 'Unknown' ? `<span class="lang-badge">${escHtml(repo.language)}</span>` : ''}
    </h1>
    ${translatedName ? `<p class="repo-name-trans">🌐 ${escHtml(translatedName)}</p>` : ''}
    ${repo.description ? `<p class="repo-desc">${escHtml(repo.description)}</p>` : ''}
    ${translatedDesc ? `<p class="repo-desc-trans">🌐 ${escHtml(translatedDesc)}</p>` : ''}
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

  const chartHtml = history.length > 0 
    ? `<section class="trend-chart">
      <h2>📈 趋势变化（${history.length}条数据）</h2>
      <div class="chart-container">
        <canvas id="trendChart"></canvas>
      </div>
    </section>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      try {
        const ctx = document.getElementById('trendChart').getContext('2d');
        new Chart(ctx, {
          type: 'line',
          data: {
            labels: ${JSON.stringify(history.map(h => h.crawl_date))},
            datasets: [
              {
                label: 'Stars',
                data: ${JSON.stringify(history.map(h => h.stars))},
                borderColor: '#e3b341',
                backgroundColor: 'rgba(227,179,65,0.1)',
                fill: true,
                tension: 0.3
              },
              {
                label: 'Forks',
                data: ${JSON.stringify(history.map(h => h.forks))},
                borderColor: '#58a6ff',
                backgroundColor: 'rgba(88,166,255,0.1)',
                fill: true,
                tension: 0.3
              }
            ]
          },
          options: {
            responsive: true,
            plugins: { legend: { labels: { color: '#e6edf3' } } },
            scales: {
              x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
              y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }
            }
          }
        });
      } catch(e) {
        console.error('Chart error:', e);
      }
    </script>`
    : '';

  const relatedHtml = related.length 
    ? `<section class="related-repos"><h2>同语言热门项目</h2><div class="repo-list">${related.map(r => `
      <a class="repo-card" href="/r/${r.id}">
        <div class="repo-main">
          <div class="repo-title-line"><span class="repo-name">${escHtml(r.full_name)}</span></div>
          <div class="repo-meta"><span>⭐ ${fmtNum(r.stars)}</span><span>🍴 ${fmtNum(r.forks)}</span></div>
        </div>
      </a>`).join('')}</div></section>`
    : '';

  const domain = getDomain(env);
  const canonicalUrl = `https://${domain}/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  const body = `
  ${repoLink}
  ${topicsHtml}
  ${chartHtml}
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
${ANALYTICS_HEAD_SNIPPET}
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

async function pageRepoDetailById(env, id) {
  const repo = await getRepoById(env.DB, id);
  
  if (!repo) {
    return html(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"/><title>仓库未找到 — HotGit</title>${ANALYTICS_HEAD_SNIPPET}
</head>
<body><h1>仓库未找到</h1><p>ID: ${id} 不在热门榜单中</p><a href="/">返回首页</a></body>
</html>`, 404);
  }

  return pageRepoDetail(env, repo.full_name.split('/')[0], repo.full_name.split('/')[1]);
}

async function pageSitemap(env) {
  const domain = getDomain(env);
  const host = `https://${domain}`;
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

function pageRobots(env) {
  const domain = getDomain(env);
  const robots = `User-agent: *
Allow: /

Sitemap: https://${domain}/sitemap.xml
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
.repo-desc-trans{color:var(--text-muted);font-size:.95rem;margin-top:.5rem}
.trend-chart{margin:2rem 0;padding:1.5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)}
.trend-chart h2{font-size:1.2rem;margin-bottom:1rem;color:var(--text-muted)}
.chart-container{position:relative;height:300px}
.footer{border-top:1px solid var(--border);padding:1.25rem;text-align:center;font-size:.82rem;color:var(--text-muted);background:var(--bg-card)}
@media(max-width:640px){.navbar{padding:0 1rem;gap:.75rem}.hero h1{font-size:1.5rem}.repo-card{flex-direction:column;gap:.5rem}.repo-rank{text-align:left}.repo-stats{gap:.75rem}.repo-stats .stat-item{min-width:80px;padding:.75rem}}
`;
