/**
 * HotGit — Cloudflare Worker
 *
 * 职责：
 *  1. Cron Trigger (04:00 CST = 20:00 UTC 前一天) 自动爬取 GitHub 榜单并写入 D1
 *  2. HTTP 路由：
 *     GET  /              → 首页 HTML
 *     GET  /about         → 关于页 HTML
 *     GET  /repos         → 榜单列表页 HTML
 *     GET  /forceupdate   → 立即同步爬取并展示结果
 *     GET  /backfillinsights → 补全存量项目观察总结
 *     GET  /api/repos     → JSON API（分页/筛选）
 *     GET  /api/stats     → 统计摘要
 *     GET  /api/dates     → 所有爬取日期
 *     POST /api/crawl     → 手动触发爬取（需要 X-Admin-Token 头）
 *     GET  /llms.txt      → AI 搜索/问答工具可读站点说明
 *  3. 静态资源通过 __STATIC_CONTENT 或内联方式提供
 */
import { WECHAT_PROMO_PNG_BASE64 } from './wechat-promo.js';

// ── 常量 ───────────────────────────────────────────────────────────────
const GITHUB_API   = 'https://api.github.com';
const USER_AGENT   = 'hotgit-cf/1.0 (https://github.com/hotgit)';
const DEFAULT_DOMAIN = 'hotgit-cf.linkai.workers.dev';
const SITE_NAME = 'HotGit';
const SITE_DESCRIPTION = 'HotGit 每日追踪 GitHub 热门仓库、Star 增长趋势和开源项目潜力榜，帮开发者及时发现值得关注的开源项目。';
const WECHAT_PROMO_ALT = '项目值得看 公众号二维码，扫码关注获取最新热门项目资讯及深度解读';
const DEFAULT_LOCALE = 'zh-CN';
const LOCALES = {
  'zh-CN': { code: 'zh-CN', prefix: '/zh-CN', label: '中文', shortLabel: '中文' },
  en: { code: 'en', prefix: '/en', label: 'English', shortLabel: 'EN' },
};
const LOCALE_COOKIE = 'hotgit_locale';

let DOMAIN = DEFAULT_DOMAIN;

function getDomain(env) {
  return env.DOMAIN || DOMAIN;
}

function normalizeLocale(locale) {
  return LOCALES[locale] ? locale : DEFAULT_LOCALE;
}

function parseLocalizedPath(pathname) {
  for (const locale of Object.keys(LOCALES)) {
    const prefix = LOCALES[locale].prefix;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const path = pathname.slice(prefix.length) || '/';
      return { locale, prefix, path, hasPrefix: true };
    }
  }
  return { locale: DEFAULT_LOCALE, prefix: '', path: pathname || '/', hasPrefix: false };
}

function getPreferredLocale(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  return normalizeLocale(match ? decodeURIComponent(match[1]) : DEFAULT_LOCALE);
}

function hasLocaleCookie(request) {
  return new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=`).test(request.headers.get('Cookie') || '');
}

function shouldRedirectToPreferredLocale(path) {
  return path === '/' || path === '/about' || path === '/repos' || /^\/repo\//.test(path);
}

function redirectToLocale(url, locale) {
  const nextUrl = new URL(url.toString());
  nextUrl.pathname = localizedPath(locale, nextUrl.pathname);
  return withLocaleCookie(Response.redirect(nextUrl.toString(), 302), locale);
}

function withLocaleCookie(response, locale) {
  if (!locale) return response;
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', `${LOCALE_COOKIE}=${encodeURIComponent(normalizeLocale(locale))}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withRobotsHeader(response, value = 'noindex, follow') {
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function localizedPath(locale, path = '/') {
  locale = normalizeLocale(locale);
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${LOCALES[locale].prefix}${cleanPath === '/' ? '/' : cleanPath}`;
}

function routePath(path, langPrefix = '') {
  if (!langPrefix) return path;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${langPrefix}${cleanPath === '/' ? '/' : cleanPath}`;
}

function routeUrl(env, path, locale = DEFAULT_LOCALE) {
  return siteUrl(env, localizedPath(locale, path));
}

function categoryLabels(locale = DEFAULT_LOCALE) {
  return locale === 'en' ? CATEGORY_LABELS_EN : CATEGORY_LABELS;
}

function tr(locale, zh, en) {
  return locale === 'en' ? en : zh;
}

const CATEGORY_LABELS = {
  top_stars:    '⭐ Star 总榜',
  top_forks:    '🍴 Fork 总榜',
  star_daily:   '📈 日增 Star',
  star_weekly:  '📅 周增 Star',
  star_monthly: '🗓️ 月增 Star',
};

const CATEGORY_LABELS_EN = {
  top_stars:    '⭐ Top Stars',
  top_forks:    '🍴 Top Forks',
  star_daily:   '📈 Daily Stars',
  star_weekly:  '📅 Weekly Stars',
  star_monthly: '🗓️ Monthly Stars',
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
    const originalPath = url.pathname;
    const localeRoute = parseLocalizedPath(originalPath);
    const path = localeRoute.path;
    const locale = localeRoute.locale;
    const langPrefix = localeRoute.prefix;

    // 静态资源
    if (originalPath.startsWith('/static/')) {
      return handleStatic(originalPath);
    }

    // API 路由
    if (originalPath === '/api/repos')  return apiRepos(request, env);
    if (originalPath === '/api/stats')  return apiStats(env);
    if (originalPath === '/api/dates')  return apiDates(env);
    if (originalPath === '/api/crawl' && request.method === 'POST') {
      return apiCrawl(request, env, ctx);
    }

    const preferredLocale = localeRoute.hasPrefix ? locale : getPreferredLocale(request);
    if (!localeRoute.hasPrefix && hasLocaleCookie(request) && shouldRedirectToPreferredLocale(path)) {
      return redirectToLocale(url, preferredLocale);
    }

    // 页面路由
    if (path === '/')             return withLocaleCookie(await pageIndex(env, locale, langPrefix), localeRoute.hasPrefix ? locale : null);
    if (path === '/about')        return withLocaleCookie(await pageAbout(env, locale, langPrefix), localeRoute.hasPrefix ? locale : null);
    if (path === '/repos')        return withLocaleCookie(await pageRepos(request, env, locale, langPrefix), localeRoute.hasPrefix ? locale : null);
    if (path === '/forceupdate')  return pageForceUpdate(env);
    if (path === '/backfillinsights') return pageBackfillInsights(request, env);
    
    // SEO 静态化路由 /repo/owner/repo 或 /repo/owner%2Frepo
    const repoMatch = path.match(/^\/repo\/([^\/]+)\/([^\/]+)$/);
    if (repoMatch) {
      let owner = repoMatch[1];
      let name = repoMatch[2];
      try { owner = decodeURIComponent(owner); } catch(e) {}
      try { name = decodeURIComponent(name); } catch(e) {}
      const fullName = `${owner}/${name}`;
      console.log('[repo] path:', path, '-> fullName:', fullName);
      return withLocaleCookie(await pageRepoDetail(env, owner, name, locale, langPrefix), localeRoute.hasPrefix ? locale : null);
    }
    // ID 路由 /r/123
    const idMatch = path.match(/^\/r\/(\d+)$/);
    if (idMatch) {
      return withLocaleCookie(await pageRepoDetailById(env, parseInt(idMatch[1]), locale, langPrefix), localeRoute.hasPrefix ? locale : null);
    }
    if (path === '/sitemap.xml') return pageSitemap(env, localeRoute.hasPrefix ? locale : null);
    if (path === '/robots.txt')  return pageRobots(env);
    if (path === '/llms.txt')    return pageLlmsTxt(env, localeRoute.hasPrefix ? locale : null);

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

async function githubReadmeText(fullName, githubToken) {
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': USER_AGENT,
  };
  if (githubToken) headers['Authorization'] = `token ${githubToken}`;

  try {
    const res = await fetch(`${GITHUB_API}/repos/${fullName}/readme`, {
      headers,
      cf: { cacheTtl: 3600, cacheEverything: false },
    });
    if (!res.ok) return '';
    const data = await res.json();
    if (!data?.content) return '';
    const raw = atob(String(data.content).replace(/\s+/g, ''));
    return cleanMarkdownText(raw).slice(0, 3000);
  } catch (e) {
    console.error('[githubReadmeText] error:', fullName, e.message);
    return '';
  }
}

async function fetchHomepageMeta(homepage) {
  if (!homepage || !/^https?:\/\//i.test(homepage)) return '';
  try {
    const res = await fetch(homepage, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
      },
      cf: { cacheTtl: 3600, cacheEverything: false },
    });
    if (!res.ok) return '';
    const html = (await res.text()).slice(0, 12000);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
    const desc = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
    return cleanMarkdownText(`${title} ${desc}`).slice(0, 500);
  } catch (e) {
    console.error('[fetchHomepageMeta] error:', homepage, e.message);
    return '';
  }
}

function cleanMarkdownText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_\-|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  for (const [index, fullName] of repoNames.entries()) {
    try {
      const repo = await githubRepo(fullName, githubToken);
      repo.__trendingRank = index + 1;
      repos.push(repo);
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

  if (aTrending && (!a.hasDailyHistory || !b.hasDailyHistory)) {
    const aTrendingRank = a.trendingRank ?? Infinity;
    const bTrendingRank = b.trendingRank ?? Infinity;
    if (aTrendingRank !== bTrendingRank) return aTrendingRank - bTrendingRank;
  }

  if (b.dailyGain !== a.dailyGain) return b.dailyGain - a.dailyGain;

  const aStars = a.repo.stargazers_count || 0;
  const bStars = b.repo.stargazers_count || 0;
  if (bStars !== aStars) return bStars - aStars;

  if (b.weeklyGain !== a.weeklyGain) return b.weeklyGain - a.weeklyGain;
  if (b.score !== a.score) return b.score - a.score;

  return a.repo.full_name.localeCompare(b.repo.full_name);
}

async function fetchPotentialDailyRepos(db, githubToken, limit = 100) {
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
      hasDailyHistory: historyDay !== null,
      trendingRank: candidate.repo.__trendingRank ?? null,
    });
  }

  scored.sort(comparePotentialDailyRepo);

  return scored.slice(0, limit).map((item, index) => fmtRepo(item.repo, 'star_daily', index + 1));
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
    project_insight: repo.project_insight || '',
    project_insight_updated_at: repo.project_insight_updated_at || '',
  };
}

/** 返回 CST（UTC+8）当天日期字符串，格式 YYYY-MM-DD */
function todayCST() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 返回 CST（UTC+8）当前时间，格式 YYYY-MM-DD HH:mm:ss */
function nowCSTDateTime() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
}

/** 按天数获取 since 日期字符串（基于 CST） */
function sinceDate(days) {
  const d = new Date(Date.now() + 8 * 3600_000 - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** 爬取所有榜单 */
async function fetchAll(db, githubToken, prefetchedDailyRepos = null) {
  const tasks = [
    { name: 'star_daily',   fn: () => prefetchedDailyRepos || fetchPotentialDailyRepos(db, githubToken) },
    { name: 'star_weekly',  fn: () => githubSearch('stars:>100',             'stars', githubToken) },
    { name: 'star_monthly', fn: () => githubSearch('stars:>100',              'stars', githubToken) },
    { name: 'top_stars',    fn: () => githubSearch('stars:>1000',           'stars', githubToken) },
    { name: 'top_forks',    fn: () => githubSearch('forks:>500',            'forks', githubToken) },
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
  const githubToken = env.GITHUB_TOKEN || '';

  let dailyHistoryPool = [];
  try {
    dailyHistoryPool = await fetchPotentialDailyRepos(env.DB, githubToken, 300);
  } catch (e) {
    console.error('[crawl] daily history pool error:', e.message);
    await logCrawl(env.DB, today, 'star_daily', 0, 'error', e.message);
  }

  // 先保存候选池历史数据（用于后续日增、周增、月增计算）
  try {
    await saveStarsHistory(env.DB, dailyHistoryPool, today);
    console.log('[crawl] history saved');
  } catch (e) {
    console.error('[crawl] save history error:', e.message);
  }

  // 定时任务优先保证榜单数据落库，不在主流程批量抓 README/主页，避免超时或触发限流。
  const tasks = [
    { name: 'star_daily',   fn: () => dailyHistoryPool.slice(0, 100) },
    { name: 'star_weekly',  fn: () => githubSearch('stars:>100',   'stars', githubToken) },
    { name: 'star_monthly', fn: () => githubSearch('stars:>100',   'stars', githubToken) },
    { name: 'top_stars',    fn: () => githubSearch('stars:>1000',  'stars', githubToken) },
    { name: 'top_forks',    fn: () => githubSearch('forks:>500',   'forks', githubToken) },
  ];

  for (const task of tasks) {
    try {
      const items = await task.fn();
      const repos = task.name === 'star_daily'
        ? items
        : items.slice(0, 100).map((r, i) => fmtRepo(r, task.name, i + 1));
      await saveStarsHistory(env.DB, repos, today);
      await translateAndSaveRepos(env.DB, repos);
      await saveRepos(env.DB, repos, today);
      await logCrawl(env.DB, today, task.name, repos.length, 'ok', '');
      console.log(`[crawl] ${task.name}: ${repos.length} saved`);
    } catch (e) {
      console.error(`[crawl] ${task.name} error:`, e.message);
      await logCrawl(env.DB, today, task.name, 0, 'error', e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
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
         translated_name, translated_desc, project_insight, project_insight_updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      crawlDate, r.category, r.rank, r.full_name, r.html_url,
      r.description, r.language, r.stars, r.forks, r.open_issues,
      r.pushed_at, r.topics, r.homepage,
      r.translated_name || '', r.translated_desc || '',
      r.project_insight || '', r.project_insight_updated_at || ''
    )
  );
  await db.batch(stmts);
}

async function enrichProjectInsights(db, repos, githubToken, crawlDate, insightCache = new Map(), options = {}) {
  const force = Boolean(options.force);
  for (const repo of repos) {
    if (!repo?.full_name) continue;
    if (repo.project_insight && !force) continue;

    const cached = insightCache.get(repo.full_name);
    if (cached) {
      repo.project_insight = cached.text;
      repo.project_insight_updated_at = cached.updatedAt;
      continue;
    }

    const historyDate = getInsightHistoryDate(repo.category, crawlDate);
    const history = historyDate ? await getHistoryStars(db, repo.full_name, historyDate) : null;
    const historyPoints = history
      ? [{ crawl_date: historyDate, stars: history.stars }, { crawl_date: crawlDate, stars: repo.stars }]
      : [{ crawl_date: crawlDate, stars: repo.stars }];

    const [readmeResult, homepageResult] = await Promise.allSettled([
      githubReadmeText(repo.full_name, githubToken),
      fetchHomepageMeta(repo.homepage || ''),
    ]);
    const readmeText = readmeResult.status === 'fulfilled' ? readmeResult.value : '';
    const homepageMeta = homepageResult.status === 'fulfilled' ? homepageResult.value : '';
    repo.project_insight = buildProjectInsight(repo, historyPoints, readmeText, homepageMeta);
    repo.project_insight_updated_at = nowCSTDateTime();
    insightCache.set(repo.full_name, {
      text: repo.project_insight,
      updatedAt: repo.project_insight_updated_at,
    });

    // README/主页抓取属于增强信息，轻微限速避免对外部服务造成压力。
    await new Promise(r => setTimeout(r, 120));
  }
}

function getInsightHistoryDate(category, crawlDate) {
  if (!crawlDate) return null;
  if (category === 'star_weekly') return getHistoryDate(crawlDate, 7);
  if (category === 'star_monthly') return getHistoryDate(crawlDate, 30);
  return getHistoryDate(crawlDate, 1);
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

async function getLatestDate(db, category = '') {
  try {
    const row = category
      ? await db.prepare('SELECT MAX(crawl_date) AS d FROM repos WHERE category = ?').bind(category).first()
      : await db.prepare('SELECT MAX(crawl_date) AS d FROM repos').first();
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
    `SELECT r.category, COUNT(*) AS cnt
     FROM repos r
     JOIN (
       SELECT category, MAX(crawl_date) AS crawl_date
       FROM repos
       GROUP BY category
     ) latest
       ON latest.category = r.category
      AND latest.crawl_date = r.crawl_date
     GROUP BY r.category`
  ).all();
  const categories = {};
  for (const r of rows.results) categories[r.category] = r.cnt;
  return { date, categories };
}

async function getCrawlDates(db, category = '') {
  const rows = category
    ? await db.prepare('SELECT DISTINCT crawl_date FROM repos WHERE category = ? ORDER BY crawl_date DESC LIMIT 30').bind(category).all()
    : await db.prepare('SELECT DISTINCT crawl_date FROM repos ORDER BY crawl_date DESC LIMIT 30').all();
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
    if (!isDaily) {
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

async function getTopicRelatedRepos(db, topics, excludeFullName, crawlDate, limit = 10) {
  const topicList = String(topics || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 6);
  if (!topicList.length) return [];
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return [];

  const conditions = topicList.map(() => 'topics LIKE ?').join(' OR ');
  const params = topicList.map(t => `%${t}%`);
  const rows = await db.prepare(
    `SELECT full_name, MAX(stars) as stars, MAX(forks) as forks, MAX(html_url) as html_url,
            MAX(description) as description, MAX(language) as language, MAX(pushed_at) as pushed_at,
            MAX(topics) as topics, MAX(homepage) as homepage, MAX(open_issues) as open_issues,
            MAX(rank) as rank, MAX(id) as id
     FROM repos
     WHERE crawl_date = ? AND full_name != ? AND (${conditions})
     GROUP BY full_name
     ORDER BY stars DESC
     LIMIT ?`
  ).bind(crawlDate, excludeFullName, ...params, limit).all();

  return rows.results;
}

async function getReposPendingProjectInsights(db, limit = 20) {
  const rows = await db.prepare(
    `SELECT *,
            CASE
              WHEN COALESCE(project_insight, '') = '' THEN '缺少项目观察'
              WHEN COALESCE(project_insight_updated_at, '') = '' THEN '缺少生成时间'
              ELSE '仓库更新后重新生成'
            END AS __insightReason
     FROM repos
     WHERE id IN (
       SELECT MAX(id)
       FROM repos
       GROUP BY full_name
     )
       AND (
         COALESCE(project_insight, '') = ''
         OR COALESCE(project_insight_updated_at, '') = ''
         OR (COALESCE(pushed_at, '') != '' AND pushed_at > COALESCE(project_insight_updated_at, ''))
       )
     ORDER BY
       CASE WHEN COALESCE(project_insight, '') = '' THEN 0 ELSE 1 END,
       pushed_at DESC,
       crawl_date DESC,
       stars DESC
     LIMIT ?`
  ).bind(limit).all();
  return rows.results;
}

async function getReposMissingProjectInsights(db, limit = 20) {
  return getReposPendingProjectInsights(db, limit);
}

async function updateRepoProjectInsight(db, repo) {
  await db.prepare(
    `UPDATE repos
     SET project_insight = ?,
         project_insight_updated_at = ?
     WHERE full_name = ?`
  ).bind(
    repo.project_insight || '',
    repo.project_insight_updated_at || nowCSTDateTime(),
    repo.full_name
  ).run();
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

async function getRepoFieldTranslation(db, repo, fieldName, targetLang) {
  if (!repo?.id || !fieldName || !targetLang) return null;
  try {
    const row = await db.prepare(
      `SELECT translated_text
       FROM translations
       WHERE repo_id = ? AND field_name = ? AND target_lang = ?
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`
    ).bind(repo.id, fieldName, targetLang).first();
    return row?.translated_text || null;
  } catch (e) {
    console.log('[repo translation] read error:', e.message);
    return null;
  }
}

async function saveRepoFieldTranslation(db, repo, fieldName, targetLang, translatedText, sourceText = '', sourceLang = '') {
  if (!repo?.id || !fieldName || !targetLang || !translatedText) return;
  try {
    const textHash = hashString(`${repo.id}|${fieldName}|${targetLang}`);
    await db.prepare(
      `INSERT OR REPLACE INTO translations
        (text_hash, repo_id, full_name, field_name, source_lang, target_lang, source_text, translated_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      textHash,
      repo.id,
      repo.full_name || '',
      fieldName,
      sourceLang || detectTextLanguage(sourceText || translatedText),
      targetLang,
      sourceText || translatedText,
      translatedText
    ).run();
  } catch (e) {
    console.log('[repo translation] save error:', e.message);
  }
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
  const apiTargetLang = translationApiLang(targetLang);
  if (sourceLang === apiTargetLang) {
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
    const langPair = `${sourceLang}|${apiTargetLang}`;
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

function translationApiLang(lang) {
  if (!lang) return 'en';
  const normalized = String(lang).toLowerCase();
  if (normalized === 'zh-cn' || normalized === 'zh') return 'zh';
  if (normalized.startsWith('en')) return 'en';
  return normalized.split('-')[0];
}

function detectTextLanguage(text) {
  return /[\u4e00-\u9fa5]/.test(String(text || '')) ? 'zh-CN' : 'en';
}

function repoPrimaryName(repo) {
  return (repo.full_name || '').split('/').pop() || repo.full_name || '';
}

function repoDetailPath(fullName, langPrefix = '') {
  const [owner, ...nameParts] = String(fullName || '').split('/');
  const name = nameParts.join('/');
  if (!owner || !name) return routePath('/', langPrefix);
  return routePath(`/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, langPrefix);
}

function resolveRepoFieldFromBase(repo, fieldName, targetLang) {
  const locale = normalizeLocale(targetLang);
  if (fieldName === 'name') {
    const original = repoPrimaryName(repo);
    const translated = repo.translated_name || '';
    const originalLang = detectTextLanguage(original);
    if (locale === 'zh-CN') return originalLang === 'zh-CN' ? original : (translated || original);
    if (locale === 'en') return originalLang === 'en' ? original : (translated || original);
    return '';
  }

  if (fieldName === 'description') {
    const original = repo.description || '';
    const translated = repo.translated_desc || '';
    const originalLang = detectTextLanguage(original);
    if (locale === 'zh-CN') return originalLang === 'zh-CN' ? original : (translated || original);
    if (locale === 'en') return originalLang === 'en' ? original : (translated || original);
    return '';
  }

  if (fieldName === 'project_insight') {
    const original = repo.project_insight || '';
    const originalLang = detectTextLanguage(original);
    if (locale === originalLang) return original;
    return '';
  }

  return '';
}

function repoFieldSourceText(repo, fieldName) {
  if (fieldName === 'name') return repoPrimaryName(repo);
  if (fieldName === 'description') return repo.description || repo.translated_desc || '';
  if (fieldName === 'project_insight') return repo.project_insight || '';
  return '';
}

async function getLocalizedRepoField(db, repo, fieldName, targetLang) {
  const locale = normalizeLocale(targetLang);
  const fromBase = resolveRepoFieldFromBase(repo, fieldName, locale);
  if (fromBase) {
    const existing = await getRepoFieldTranslation(db, repo, fieldName, locale);
    if (existing !== fromBase) {
      await saveRepoFieldTranslation(db, repo, fieldName, locale, fromBase, repoFieldSourceText(repo, fieldName), detectTextLanguage(repoFieldSourceText(repo, fieldName)));
    }
    return fromBase;
  }

  const cached = await getRepoFieldTranslation(db, repo, fieldName, locale);
  if (cached) return cached;

  const sourceText = repoFieldSourceText(repo, fieldName);
  if (!sourceText) return '';

  const translated = await translateText(db, sourceText, locale);
  if (translated) {
    await saveRepoFieldTranslation(db, repo, fieldName, locale, translated, sourceText, detectTextLanguage(sourceText));
    return translated;
  }

  return sourceText;
}

async function getLocalizedRepoContent(db, repo, targetLang, fields = ['name', 'description', 'project_insight']) {
  const result = {};
  for (const fieldName of fields) {
    result[fieldName] = await getLocalizedRepoField(db, repo, fieldName, targetLang);
  }
  return result;
}

async function getAllRepoNames(db, limit = 1000) {
  const crawlDate = await getLatestDate(db);
  if (!crawlDate) return [];
  const rows = await db.prepare(
    'SELECT DISTINCT full_name FROM repos WHERE crawl_date = ? ORDER BY stars DESC LIMIT ?'
  ).bind(crawlDate, limit).all();
  return rows.results.map(r => r.full_name);
}

async function getSitemapRepos(db, limit = 1000) {
  const rows = await db.prepare(
    `SELECT full_name, MAX(crawl_date) as lastmod, MAX(stars) as stars
     FROM repos
     GROUP BY full_name
     ORDER BY lastmod DESC, stars DESC
     LIMIT ?`
  ).bind(limit).all();
  return rows.results;
}

async function getSitemapListCounts(db) {
  const rows = await db.prepare(
    `SELECT crawl_date, category, COUNT(*) AS total
     FROM repos
     GROUP BY crawl_date, category
     ORDER BY crawl_date DESC, category`
  ).all();
  return rows.results;
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
  const crawlDate = q.get('date')   || await getLatestDate(env.DB, category);

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
  if (path === '/static/img/wechat-promo.png') {
    return imageFromBase64(WECHAT_PROMO_PNG_BASE64, 'image/png');
  }
  return new Response('Not Found', { status: 404 });
}

function imageFromBase64(base64, contentType) {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public,max-age=604800,immutable',
    }
  });
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

const JOURNEY_GROW_HEAD_SNIPPET=`<script data-grow-initializer="">!(function(){window.growMe||((window.growMe=function(e){window.growMe._.push(e);}),(window.growMe._=[]));var e=document.createElement("script");(e.type="text/javascript"),(e.src="https://faves.grow.me/main.js"),(e.defer=!0),e.setAttribute("data-grow-faves-site-id","U2l0ZTo5NTE1NTE5NC04Nzc5LTRlYWUtOTRhZi04YmU0ZjcwODU2YmU=");var t=document.getElementsByTagName("script")[0];t.parentNode.insertBefore(e,t);})();</script>`;

const EZOIC_HEAD_SNIPPET=`
<script data-cfasync="false" src="https://cmp.gatekeeperconsent.com/min.js"></script>
<script data-cfasync="false" src="https://the.gatekeeperconsent.com/cmp.min.js"></script>
<script async src="//www.ezojs.com/ezoic/sa.min.js"></script>
<script>
    window.ezstandalone = window.ezstandalone || {};
    ezstandalone.cmd = ezstandalone.cmd || [];
</script>
<script src="//ezoicanalytics.com/analytics.js"></script>
`;

function baseLayout(title, bodyContent, options = {}) {
  const locale = normalizeLocale(options.locale || DEFAULT_LOCALE);
  const langPrefix = options.langPrefix || '';
  const description = options.description || SITE_DESCRIPTION;
  const canonicalUrl = options.canonicalUrl || '';
  const robots = options.robots || '';
  const ogType = options.ogType || 'website';
  const extraHead = options.extraHead || '';
  const currentPath = options.currentPath || '/';
  const alternatePath = options.alternatePath || currentPath;
  const nav = layoutText(locale);
  const localeLinks = Object.values(LOCALES).map(l => {
    const active = l.code === locale ? ' active' : '';
    return `<a class="lang-link${active}" href="${localizedPath(l.code, alternatePath)}" hreflang="${escHtml(l.code)}" data-locale="${escHtml(l.code)}">${escHtml(l.shortLabel)}</a>`;
  }).join('');
  const alternates = Object.values(LOCALES).map(l =>
    `<link rel="alternate" hreflang="${escHtml(l.code)}" href="${escHtml(routeUrl(options.env || {}, alternatePath, l.code))}"/>`
  ).join('\n  ');
  return `<!DOCTYPE html>
<html lang="${escHtml(locale)}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${escHtml(title)}</title>
  <meta name="description" content="${escHtml(description)}"/>
  ${canonicalUrl ? `<link rel="canonical" href="${escHtml(canonicalUrl)}"/>` : ''}
  ${alternates}
  <link rel="alternate" hreflang="x-default" href="${escHtml(routeUrl(options.env || {}, alternatePath, DEFAULT_LOCALE))}"/>
  ${robots ? `<meta name="robots" content="${escHtml(robots)}"/>` : ''}
  <meta property="og:site_name" content="${SITE_NAME}"/>
  <meta property="og:title" content="${escHtml(title)}"/>
  <meta property="og:description" content="${escHtml(description)}"/>
  ${canonicalUrl ? `<meta property="og:url" content="${escHtml(canonicalUrl)}"/>` : ''}
  <meta property="og:type" content="${escHtml(ogType)}"/>
  <meta name="twitter:card" content="summary"/>
  <meta name="twitter:title" content="${escHtml(title)}"/>
  <meta name="twitter:description" content="${escHtml(description)}"/>
  <link rel="stylesheet" href="/static/css/style.css"/>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔥</text></svg>"/>
  ${extraHead}
${ANALYTICS_HEAD_SNIPPET}
${JOURNEY_GROW_HEAD_SNIPPET}
${EZOIC_HEAD_SNIPPET}
</head>
<body>
  <nav class="navbar">
    <a class="brand" href="${routePath('/', langPrefix)}">🔥 HotGit</a>
    <ul class="nav-links">
      <li><a href="${routePath('/', langPrefix)}">${nav.home}</a></li>
      <li><a href="${routePath('/repos?category=top_stars', langPrefix)}">${nav.topStars}</a></li>
      <li><a href="${routePath('/repos?category=top_forks', langPrefix)}">${nav.topForks}</a></li>
      <li><a href="${routePath('/repos?category=star_daily', langPrefix)}">${nav.daily}</a></li>
      <li><a href="${routePath('/repos?category=star_weekly', langPrefix)}">${nav.weekly}</a></li>
      <li><a href="${routePath('/repos?category=star_monthly', langPrefix)}">${nav.monthly}</a></li>
      <li><a href="${routePath('/about', langPrefix)}">${nav.about}</a></li>
    </ul>
    <div class="lang-switch" aria-label="${escHtml(nav.language)}">${localeLinks}</div>
  </nav>
  <main class="container">${bodyContent}</main>
  <footer class="footer">
    <p>${nav.footer}</p>
  </footer>
  <script>
    document.querySelectorAll('[data-locale]').forEach(function(link) {
      link.addEventListener('click', function() {
        try {
          localStorage.setItem('${LOCALE_COOKIE}', link.dataset.locale);
          document.cookie = '${LOCALE_COOKIE}=' + encodeURIComponent(link.dataset.locale) + '; Path=/; Max-Age=31536000; SameSite=Lax; Secure';
        } catch (e) {}
      });
    });
  </script>
</body>
</html>`;
}

function layoutText(locale) {
  if (locale === 'en') {
    return {
      home: 'Home',
      topStars: '⭐ Stars',
      topForks: '🍴 Forks',
      daily: '📈 Daily',
      weekly: '📅 Weekly',
      monthly: '🗓️ Monthly',
      about: 'About',
      language: 'Language',
      footer: 'HotGit — GitHub trending repositories tracker · Data updates daily at 04:00 CST · Powered by Cloudflare Workers',
    };
  }
  return {
    home: '首页',
    topStars: '⭐ Star 榜',
    topForks: '🍴 Fork 榜',
    daily: '📈 日增',
    weekly: '📅 周增',
    monthly: '🗓️ 月增',
    about: '关于',
    language: '语言',
    footer: 'HotGit — GitHub 热门仓库追踪 · 数据每日 04:00 CST 自动更新 · Powered by Cloudflare Workers',
  };
}

function siteUrl(env, path = '/') {
  return `https://${getDomain(env)}${path}`;
}

function jsonLdScript(data) {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

function wechatPromoBlock(variant = 'default', locale = DEFAULT_LOCALE) {
  const titleId = `wechat-promo-title-${variant}`;
  return `
  <section class="wechat-promo wechat-promo-${variant}" aria-labelledby="${titleId}">
    <table class="wechat-promo-table" role="presentation">
      <tr>
        <td class="wechat-promo-copy">
          <p class="promo-eyebrow">${tr(locale, '公众号同步更新', 'WeChat updates')}</p>
          <h2 id="${titleId}">${tr(locale, '搜索关注【项目值得看】公众号，第一时间发现热门开源项目', 'Follow the Project Worth Watching WeChat account for daily open-source picks')}</h2>
          <p>${tr(locale, '每日热门项目资讯、增长趋势观察和深度解读会同步到公众号，适合通勤、碎片时间快速浏览。', 'Daily project highlights, growth observations, and deeper reads are also published on WeChat for quick reading.')}</p>
        </td>
        <td class="wechat-promo-media">
          <img class="wechat-promo-img" src="/static/img/wechat-promo.png" alt="${WECHAT_PROMO_ALT}" height="132" loading="lazy" decoding="async"/>
        </td>
      </tr>
    </table>
  </section>`;
}

function buildProjectInsight(repo, history = [], readmeText = '', homepageMeta = '') {
  const topics = (repo.topics || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 6);
  const sourceText = `${repo.description || ''} ${readmeText || ''} ${homepageMeta || ''}`.toLowerCase();
  const latest = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const dailyGain = latest && previous ? latest.stars - previous.stars : null;

  const focus = inferProjectFocus(repo, sourceText, topics);
  const audience = inferProjectAudience(repo, sourceText, topics);
  const heat = inferProjectHeat(repo, dailyGain);
  const language = repo.language && repo.language !== 'Unknown' ? repo.language : '多语言';
  const topicText = topics.length ? `，相关标签包括 ${topics.slice(0, 4).join('、')}` : '';
  const sourceHint = describeInsightSources(readmeText, homepageMeta);
  const descriptionHint = repo.description ? `项目描述里最直接的信息是：“${trimInsightFragment(repo.description, 110)}”。` : '';
  const readmeHint = readmeText ? `README 里能看到它围绕使用方式、核心能力或落地场景做了说明，这比单纯看 Star 数更有参考价值。` : '';
  const homepageHint = homepageMeta ? `项目主页补充了定位或产品化表达，可以帮助判断它是不是只停留在代码仓库，还是已经有更清晰的使用入口。` : '';
  const activityHint = repo.pushed_at ? `最近一次代码更新在 ${repo.pushed_at.slice(0, 10)}，` : '';
  const growthHint = dailyGain !== null
    ? `这次统计相对历史基准新增约 ${fmtNum(Math.max(dailyGain, 0))} Star，`
    : '当前缺少完整历史基准，后续需要继续看增量是否稳定。';

  return trimInsight(
    `${sourceHint}${repo.full_name} 值得先看的一点，是它围绕${focus}在解决问题${topicText}，主要使用 ${language}。${descriptionHint}${readmeHint}${homepageHint}` +
    `我会把它放进观察清单，不是因为 Star 数本身，而是因为它的方向和最近热度有交集：${heat}；${activityHint}${growthHint}如果后面几天还能继续增长，同时 Issue、PR、提交记录也比较活跃，说明它可能不只是短时间被转发了一波，而是确实踩中了开发者近期的需求。` +
    `它更适合${audience}，尤其是正在做技术选型、找替代方案、观察新方向，或者想快速判断某类工具是否值得投入时间的人。真正要落地时，我建议先看四件事：README 的示例是不是清楚，安装和接入成本高不高，许可证是否适合自己的使用场景，维护者对问题反馈和版本发布是否稳定。整体来看，这类项目适合作为趋势观察样本，也适合在周末或碎片时间进一步读源码、看 demo、对比同类方案。`
  );
}

function buildEnglishProjectInsight(repo, history = []) {
  const topics = (repo.topics || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 4);
  const latest = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const dailyGain = latest && previous ? Math.max(latest.stars - previous.stars, 0) : null;
  const language = repo.language && repo.language !== 'Unknown' ? repo.language : 'multiple languages';
  const topicText = topics.length ? ` Its main tags include ${topics.join(', ')}.` : '';
  const description = repo.description || repo.translated_desc || '';
  const descriptionText = description ? ` The project description says: "${trimInsightFragment(description, 140)}".` : '';
  const updateText = repo.pushed_at ? ` It was last updated on ${repo.pushed_at.slice(0, 10)}.` : '';
  const growthText = dailyGain !== null
    ? ` Compared with the previous snapshot, it gained about ${fmtNum(dailyGain)} stars.`
    : ' The current dataset does not yet include enough history to judge whether the growth is stable.';

  return trimInsight(
    `${repo.full_name} is worth watching as a ${language} project with ${fmtNum(repo.stars)} stars and ${fmtNum(repo.forks)} forks.${topicText}${descriptionText}` +
    `${updateText}${growthText} It is a useful candidate for developers who are comparing tools, tracking open-source trends, or looking for practical examples in this area. Before adopting it, review the README examples, integration cost, license, issue activity, and release cadence.`
  );
}

function describeInsightSources(readmeText, homepageMeta) {
  if (readmeText && homepageMeta) return '结合 README 和项目主页来看，';
  if (readmeText) return '结合 README 来看，';
  if (homepageMeta) return '结合项目主页来看，';
  return '从项目描述、标签和公开数据来看，';
}

function inferProjectFocus(repo, sourceText, topics) {
  const language = repo.language && repo.language !== 'Unknown' ? `${repo.language} 生态` : '开源生态';
  const topicText = topics.join(' ');
  const text = `${sourceText} ${topicText}`.toLowerCase();

  if (/agent|llm|ai|model|chatbot|rag|人工智能|大模型/.test(text)) return '切中 AI 应用、智能体或大模型工具链需求';
  if (/database|sql|vector|storage|cache|query|db/.test(text)) return '围绕数据存储、检索或基础设施效率提供方案';
  if (/ui|component|frontend|react|vue|css|design/.test(text)) return '提升前端研发、组件复用或界面搭建效率';
  if (/devops|deploy|cloud|kubernetes|docker|serverless|worker/.test(text)) return '聚焦部署、云原生或工程自动化场景';
  if (/security|auth|crypto|privacy|encrypt/.test(text)) return '关注安全、认证或隐私保护等长期刚需';
  if (/cli|tool|developer|sdk|api/.test(text)) return '让开发者工具、SDK 或自动化流程更轻量';
  return `在 ${language} 中提供清晰的问题解决思路`;
}

function inferProjectAudience(repo, sourceText, topics) {
  const language = repo.language && repo.language !== 'Unknown' ? `${repo.language} 开发者` : '开发者';
  const text = `${sourceText} ${topics.join(' ')}`.toLowerCase();
  if (/agent|llm|ai|model|rag/.test(text)) return 'AI 产品开发者、独立开发者和大模型落地团队';
  if (/database|sql|vector|storage|cache/.test(text)) return '后端工程师、数据平台团队和检索存储场景';
  if (/ui|component|frontend|react|vue|css/.test(text)) return '前端工程师、设计工程团队和快速原型项目';
  if (/devops|deploy|cloud|kubernetes|docker|serverless/.test(text)) return '平台工程、DevOps 团队和交付效率优化场景';
  return `${language}、开源观察者和寻找新工具的技术团队`;
}

function inferProjectHeat(repo, dailyGain) {
  const stars = Number(repo.stars || 0);
  const forks = Number(repo.forks || 0);
  const pushedDate = repo.pushed_at ? repo.pushed_at.slice(0, 10) : '';
  const gainText = dailyGain !== null && dailyGain > 0 ? `近一天新增约 ${fmtNum(dailyGain)} Star、` : '';
  const updateText = pushedDate ? `最近更新于 ${pushedDate}、` : '';
  return `${gainText}${updateText}${fmtNum(stars)} Star 与 ${fmtNum(forks)} Fork 带来的关注度积累`;
}

function trimInsightFragment(text, maxLen = 72) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return compact.slice(0, maxLen - 1).replace(/[，。；、\s]+$/u, '') + '…';
}

function metaDescriptionFromInsight(insight, fallback = SITE_DESCRIPTION) {
  const compact = String(insight || fallback || SITE_DESCRIPTION).replace(/\s+/g, ' ').trim();
  if (compact.length <= 155) return compact;
  return compact.slice(0, 154).replace(/[，。；、\s]+$/u, '') + '…';
}

function trimInsight(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function pageIndex(env, locale = DEFAULT_LOCALE, langPrefix = '') {
  const stats = await getStats(env.DB);
  const dates = await getCrawlDates(env.DB);
  const canonicalUrl = langPrefix ? siteUrl(env, routePath('/', langPrefix)) : siteUrl(env, '/');
  const pageDescription = tr(
    locale,
    'HotGit 每天自动追踪 GitHub Star、Fork、日增、周增、月增榜单，帮助开发者及时发现增长快、有潜力的开源项目。',
    'HotGit tracks GitHub Stars, Forks, daily growth, weekly growth, and monthly growth so developers can discover fast-growing open-source projects.'
  );
  const labels = categoryLabels(locale);

  const catCards = Object.entries(labels).map(([cat, lbl]) => {
    const cnt = stats.categories?.[cat];
    return `
    <a class="stat-card" href="${routePath(`/repos?category=${cat}`, langPrefix)}">
      <div class="stat-icon">${lbl.split(' ')[0]}</div>
      <div class="stat-label">${lbl.replace(/^[^\s]+\s/, '')}</div>
      <div class="stat-count">${cnt ? tr(locale, `${cnt} 个项目`, `${cnt} repositories`) : tr(locale, '暂无数据', 'No data yet')}</div>
      <div class="stat-action">${tr(locale, '查看榜单', 'View ranking')} →</div>
    </a>`;
  }).join('');

  const dateList = dates.slice(0, 10).map(d =>
    `<li><a href="${routePath(`/repos?date=${d}`, langPrefix)}">${d}</a></li>`
  ).join('');

  const body = `
  <section class="hero">
    <h1>${tr(locale, '🔥 GitHub 热门仓库追踪', '🔥 GitHub Trending Repository Tracker')}</h1>
    <p class="hero-sub">${tr(locale, '每天自动爬取 GitHub，分析 Star / Fork / 增量排行，帮你找到最值得关注的开源项目', 'Daily GitHub ranking analysis for Stars, Forks, and growth signals, built to help you find open-source projects worth watching.')}</p>
    ${stats.date
      ? `<p class="hero-date">${tr(locale, '最新数据：', 'Latest data: ')}${stats.date}</p>`
      : `<p class="hero-date warning">${tr(locale, '暂无数据，请访问', 'No data yet. Visit')} <a href="/forceupdate">/forceupdate</a> ${tr(locale, '立即更新', 'to update now')}</p>`}
  </section>
  <section class="stats-grid">${catCards}</section>
  ${dates.length ? `<section class="history"><h2>${tr(locale, '历史数据', 'Historical snapshots')}</h2><ul class="date-list">${dateList}</ul></section>` : ''}
  ${wechatPromoBlock('home', locale)}`;

  return html(baseLayout(tr(locale, 'HotGit — GitHub 热门仓库追踪', 'HotGit — GitHub Trending Repository Tracker'), body, {
    env,
    locale,
    langPrefix,
    currentPath: '/',
    alternatePath: '/',
    description: pageDescription,
    canonicalUrl,
    extraHead: jsonLdScript({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url: canonicalUrl,
      description: pageDescription,
      inLanguage: locale,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${siteUrl(env, routePath('/repos', langPrefix))}?search={search_term_string}`,
        'query-input': 'required name=search_term_string'
      }
    })
  }));
}

async function pageAbout(env, locale = DEFAULT_LOCALE, langPrefix = '') {
  const canonicalUrl = langPrefix ? siteUrl(env, routePath('/about', langPrefix)) : siteUrl(env, '/about');
  const pageDescription = tr(
    locale,
    '关于 HotGit：了解 HotGit 如何追踪 GitHub 热门仓库、Star 增长趋势、开源项目潜力榜，并为开发者和 AI 搜索提供可引用的开源趋势内容。',
    'About HotGit: learn how HotGit tracks GitHub trending repositories, Star growth, and open-source project signals for developers and AI search.'
  );
  const labels = categoryLabels(locale);
  const categoryLinks = Object.entries(labels).map(([category, label]) => `
    <li><a href="${routePath(`/repos?category=${category}`, langPrefix)}">${escHtml(label)}</a>：${tr(locale, `追踪 ${escHtml(label.replace(/^[^\s]+\s/, ''))} 中值得关注的开源项目。`, `Discover open-source projects worth watching in ${escHtml(label.replace(/^[^\s]+\s/, ''))}.`)}</li>
  `).join('');

  const body = locale === 'en' ? `
  <article class="about-page">
    <header class="about-hero">
      <p class="about-kicker">About HotGit</p>
      <h1>About HotGit: a GitHub trending repositories and open-source discovery tracker</h1>
      <p>HotGit organizes GitHub trending repositories, Star growth, Fork signals, and project momentum so developers, engineering teams, indie builders, and AI search tools can understand which projects are getting attention and why they may be worth a closer look.</p>
    </header>

    <section class="about-section">
      <h2>What HotGit Does</h2>
      <p>HotGit is an open-source project discovery and trend observation site. It focuses on public GitHub signals including Stars, Forks, Issues, recent updates, programming language, Topics, project homepages, and historical growth.</p>
      <p>Instead of only showing what is temporarily trending, HotGit combines overall rankings, growth rankings, and project detail pages so readers can move from “what is popular today” to “what problem does this solve, who is it for, and should I spend time evaluating it?”</p>
    </section>

    <section class="about-section">
      <h2>Tracked Rankings</h2>
      <ul class="about-list">${categoryLinks}</ul>
    </section>

    <section class="about-section">
      <h2>How Content Is Updated</h2>
      <p>HotGit runs on Cloudflare Workers and D1. It syncs public GitHub ranking data every day. Project detail pages combine repository descriptions, README summaries, project homepage metadata, Topics, programming language, Star/Fork counts, recent update time, and historical growth signals.</p>
      <p>The content is not an endorsement of project quality. Treat it as a pre-selection note for technical evaluation: read the README, check the license, test the demo, compare alternatives, inspect Issues, and review release activity before adopting anything in production.</p>
    </section>

    <section class="about-grid" aria-label="Who HotGit is for">
      <div class="about-card"><h2>Developers</h2><p>Find frameworks, libraries, CLIs, AI tools, databases, DevOps tools, and frontend components with less manual filtering.</p></div>
      <div class="about-card"><h2>Engineering Teams</h2><p>Use HotGit for technology evaluation, competitor tracking, open-source alternative research, and weekly engineering updates.</p></div>
      <div class="about-card"><h2>AI Search</h2><p>Clear page structure, FAQ content, Schema, sitemap, and llms.txt make HotGit easier for AI tools to understand and cite.</p></div>
    </section>

    <section class="about-section">
      <h2>SEO and GEO Readiness</h2>
      <p>HotGit pages are organized around clear search and citation questions: what the repository is, why it is worth watching, who it is for, related projects, and when the data was updated. Major pages include canonical links, meta descriptions, Open Graph, Twitter Card metadata, hreflang alternates, and JSON-LD structured data.</p>
      <p>The site also provides <a href="${routePath('/sitemap.xml', langPrefix)}">sitemap.xml</a>, <a href="/robots.txt">robots.txt</a>, and <a href="${routePath('/llms.txt', langPrefix)}">llms.txt</a>. AI tools should cite the specific project detail page and preserve the original GitHub repository link.</p>
    </section>

    <section class="about-section faq-section">
      <h2>FAQ</h2>
      <details open><summary>Where does HotGit data come from?</summary><p>HotGit uses public GitHub data and public repository page information, including repository descriptions, Stars, Forks, Issues, languages, Topics, README text, and homepage summaries.</p></details>
      <details><summary>How often is HotGit updated?</summary><p>The site updates daily at 04:00 CST and shows the latest data date on ranking pages.</p></details>
      <details><summary>Is a project observation a recommendation?</summary><p>No. It explains direction, momentum, and likely use cases. Before adoption, review license, maintenance status, security risk, Issue response, and release history.</p></details>
      <details><summary>Can AI tools cite HotGit?</summary><p>Yes. Cite concrete project detail pages or ranking pages, and keep the original GitHub repository link when referencing a project.</p></details>
    </section>

    ${wechatPromoBlock('about', locale)}
  </article>` : `
  <article class="about-page">
    <header class="about-hero">
      <p class="about-kicker">About HotGit</p>
      <h1>关于 HotGit：面向开发者的 GitHub 热门仓库与开源趋势追踪站</h1>
      <p>HotGit 每天自动整理 GitHub 热门仓库、Star 增长趋势、Fork 热度和开源项目潜力榜，帮助开发者、技术团队、独立开发者和 AI 搜索工具快速理解哪些项目正在受到关注，以及它们为什么值得进一步查看。</p>
    </header>

    <section class="about-section">
      <h2>HotGit 是什么</h2>
      <p>HotGit 是一个开源项目发现和趋势观察网站，重点关注 GitHub 仓库的公开数据，包括 Star、Fork、Issue、最近更新时间、编程语言、Topics、项目主页和历史增长表现。站点内容面向中文开发者，同时通过结构化数据、sitemap 和 llms.txt 为 ChatGPT、Perplexity、Gemini、Google AI Overviews 等 AI 搜索场景提供更清晰的引用入口。</p>
      <p>相比只看 GitHub Trending 的短期热度，HotGit 会同时呈现总量榜、增量榜和项目详情页，方便读者从“今天火了什么”进一步判断“这个项目解决什么问题、适合谁、是否值得投入时间”。</p>
    </section>

    <section class="about-section">
      <h2>我们追踪哪些榜单</h2>
      <ul class="about-list">
        ${categoryLinks}
      </ul>
    </section>

    <section class="about-section">
      <h2>内容如何生成和更新</h2>
      <p>HotGit 基于 Cloudflare Workers 和 D1 数据库运行，每天按计划同步 GitHub 公开榜单数据。项目详情页会结合仓库描述、README 摘要、项目主页信息、Topics、编程语言、Star/Fork 数量、最近提交时间和历史增长数据，生成中文项目观察。</p>
      <p>这些内容不是投资建议，也不是对项目质量的背书。它们更像一份技术选型前的初筛笔记，帮助读者决定是否继续阅读 README、查看许可证、测试 Demo、比较同类工具或深入源码。</p>
    </section>

    <section class="about-grid" aria-label="HotGit 适合的人群">
      <div class="about-card">
        <h2>开发者</h2>
        <p>快速发现新的框架、库、CLI、AI 工具、数据库、DevOps 工具和前端组件，减少信息筛选成本。</p>
      </div>
      <div class="about-card">
        <h2>技术团队</h2>
        <p>用于技术选型、竞品观察、开源替代方案调研和周报素材整理，关注项目热度与维护活跃度。</p>
      </div>
      <div class="about-card">
        <h2>AI 搜索与引用</h2>
        <p>通过清晰页面结构、FAQ、Schema、sitemap 和 llms.txt，让 AI 工具更容易理解 HotGit 的数据范围和引用方式。</p>
      </div>
    </section>

    <section class="about-section">
      <h2>为什么 HotGit 对 SEO 和 GEO 友好</h2>
      <p>HotGit 的页面围绕明确的问题组织：热门仓库是什么、项目为什么值得关注、适合哪些开发者、有哪些同类项目、数据更新到哪一天。每个主要页面都提供 canonical、meta description、Open Graph、Twitter Card 和 JSON-LD 结构化数据，降低搜索引擎和 AI 摘要工具理解页面主题的成本。</p>
      <p>站点还提供 <a href="${routePath('/sitemap.xml', langPrefix)}">sitemap.xml</a>、<a href="/robots.txt">robots.txt</a> 和 <a href="${routePath('/llms.txt', langPrefix)}">llms.txt</a>。AI 工具引用 HotGit 内容时，建议优先链接到具体项目详情页，并同时保留原始 GitHub 仓库链接。</p>
    </section>

    <section class="about-section faq-section">
      <h2>常见问题</h2>
      <details open>
        <summary>HotGit 的数据来自哪里？</summary>
        <p>HotGit 使用 GitHub 公开数据和仓库公开页面信息，包括仓库描述、Star、Fork、Issue、语言、Topics、README 和项目主页摘要。</p>
      </details>
      <details>
        <summary>HotGit 多久更新一次？</summary>
        <p>站点默认每天 04:00 CST 自动更新数据，页面会显示最新数据日期。</p>
      </details>
      <details>
        <summary>项目观察是否等同于推荐？</summary>
        <p>不是。项目观察用于解释项目方向、热度和可能适用场景，真正落地前仍应检查许可证、维护状态、安全风险、Issue 响应和版本发布记录。</p>
      </details>
      <details>
        <summary>AI 工具可以引用 HotGit 吗？</summary>
        <p>可以。请优先引用具体项目详情页或榜单页，并保留原始 GitHub 仓库链接。更多说明见 llms.txt。</p>
      </details>
    </section>

    ${wechatPromoBlock('about', locale)}
  </article>`;

  return html(baseLayout(tr(locale, '关于 HotGit — GitHub 热门仓库与开源趋势追踪', 'About HotGit — GitHub Trending Repositories and Open-Source Discovery'), body, {
    env,
    locale,
    langPrefix,
    currentPath: '/about',
    alternatePath: '/about',
    description: pageDescription,
    canonicalUrl,
    extraHead: jsonLdScript({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'AboutPage',
          '@id': `${canonicalUrl}#about`,
          url: canonicalUrl,
          name: '关于 HotGit',
          description: pageDescription,
          inLanguage: locale,
          isPartOf: {
            '@type': 'WebSite',
            name: SITE_NAME,
            url: routeUrl(env, '/', locale)
          },
          about: {
            '@type': 'Thing',
            name: 'GitHub 热门仓库与开源项目趋势追踪'
          }
        },
        {
          '@type': 'Organization',
          '@id': `${routeUrl(env, '/', locale)}#organization`,
          name: SITE_NAME,
          url: routeUrl(env, '/', locale),
          description: SITE_DESCRIPTION
        },
        {
          '@type': 'FAQPage',
          '@id': `${canonicalUrl}#faq`,
          mainEntity: [
            {
              '@type': 'Question',
              name: 'HotGit 的数据来自哪里？',
              acceptedAnswer: { '@type': 'Answer', text: 'HotGit 使用 GitHub 公开数据和仓库公开页面信息，包括仓库描述、Star、Fork、Issue、语言、Topics、README 和项目主页摘要。' }
            },
            {
              '@type': 'Question',
              name: 'HotGit 多久更新一次？',
              acceptedAnswer: { '@type': 'Answer', text: '站点默认每天 04:00 CST 自动更新数据，页面会显示最新数据日期。' }
            },
            {
              '@type': 'Question',
              name: '项目观察是否等同于推荐？',
              acceptedAnswer: { '@type': 'Answer', text: '不是。项目观察用于解释项目方向、热度和可能适用场景，真正落地前仍应检查许可证、维护状态、安全风险、Issue 响应和版本发布记录。' }
            },
            {
              '@type': 'Question',
              name: 'AI 工具可以引用 HotGit 吗？',
              acceptedAnswer: { '@type': 'Answer', text: '可以。请优先引用具体项目详情页或榜单页，并保留原始 GitHub 仓库链接。更多说明见 llms.txt。' }
            }
          ]
        }
      ]
    })
  }));
}

async function pageRepos(request, env, locale = DEFAULT_LOCALE, langPrefix = '') {
  const q         = new URL(request.url).searchParams;
  const requestedCategory = q.get('category') || 'top_stars';
  const category  = CATEGORY_LABELS[requestedCategory] ? requestedCategory : 'top_stars';
  const page      = parseIntParam(q.get('page'),     1);
  const perPage   = parseIntParam(q.get('per_page'), 20);
  const lang      = q.get('lang')   || '';
  const search    = q.get('search') || '';
  const crawlDate = q.get('date')   || await getLatestDate(env.DB, category);
  const canonicalParams = new URLSearchParams({ category });
  if (crawlDate) canonicalParams.set('date', crawlDate);
  if (!search && page > 1) canonicalParams.set('page', String(page));
  if (!search && page > 1 && perPage !== 20) canonicalParams.set('per_page', String(perPage));
  if (!search && lang) canonicalParams.set('lang', lang);
  const currentListPath = `/repos?${canonicalParams.toString()}`;
  const canonicalUrl = siteUrl(env, routePath(currentListPath, langPrefix));
  const shouldNoIndex = Boolean(search || requestedCategory !== category);
  const labels = categoryLabels(locale);
  const pageDescription = tr(
    locale,
    `${labels[category]}：查看 ${crawlDate || '最新'} GitHub 热门仓库榜单，跟踪项目 Star、Fork、语言、主题和增长趋势。`,
    `${labels[category]}: view ${crawlDate || 'latest'} GitHub repository rankings with Stars, Forks, language, topics, and growth signals.`
  );

  const result  = await queryRepos(env.DB, { category, crawlDate, page, perPage, lang, search });
  const langs   = await getLanguages(env.DB, category, crawlDate);
  const dates   = await getCrawlDates(env.DB, category);

  // Tab 栏
  const tabs = Object.entries(labels).map(([cat, lbl]) =>
    `<a class="tab${cat === category ? ' active' : ''}" href="${routePath(`/repos?category=${cat}`, langPrefix)}">${lbl}</a>`
  ).join('');

  // 筛选栏
  const langOptions = langs.map(l =>
    `<option value="${l}"${l === lang ? ' selected' : ''}>${l}</option>`
  ).join('');
  const dateOptions = dates.map(d =>
    `<option value="${d}"${d === crawlDate ? ' selected' : ''}>${d}</option>`
  ).join('');
  const perPageOptions = [10,20,50,100].map(n =>
    `<option value="${n}"${n === perPage ? ' selected' : ''}>${tr(locale, `每页 ${n} 条`, `${n} per page`)}</option>`
  ).join('');

  const isIncrement = ['star_daily', 'star_weekly', 'star_monthly'].includes(category);

  // 仓库卡片
  const cards = (await Promise.all(result.data.map(async repo => {
    const localizedRepo = await getLocalizedRepoContent(env.DB, repo, locale, ['name', 'description']);
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
    
    const repoDetailUrl = repoDetailPath(repo.full_name, langPrefix);
    return `
    <div class="repo-card">
      <div class="repo-rank">#${repo.rank}</div>
      <div class="repo-main">
        <div class="repo-title-line">
          <a class="repo-name" href="${repoDetailUrl}">${escHtml(repo.full_name)}</a>
          ${langBadge}
        </div>
        ${localizedRepo.description ? `<p class="repo-desc">${escHtml(localizedRepo.description)}</p>` : ''}
        ${topics ? `<div class="repo-topics">${topics}</div>` : ''}
        <div class="repo-meta">
          ${starsDisplay}
          ${forksDisplay}
          <span>🐛 ${repo.open_issues}</span>
          <span>🕐 ${pushedDate}</span>
          ${repo.homepage ? `<a class="meta-link" href="${escHtml(repo.homepage)}" target="_blank" rel="noopener">🌐 ${tr(locale, '主页', 'Website')}</a>` : ''}
          <a class="meta-link" href="${escHtml(repo.html_url)}" target="_blank" rel="noopener">🔗 GitHub</a>
        </div>
      </div>
    </div>`;
  }))).join('');

  // 分页
  const totalPages = result.total > 0 ? Math.ceil(result.total / perPage) : 1;
  const makePageUrl = p => routePath(`/repos?category=${category}&page=${p}&per_page=${perPage}&lang=${encodeURIComponent(lang)}&search=${encodeURIComponent(search)}&date=${crawlDate||''}`, langPrefix);
  let pagination = '';
  if (totalPages > 1) {
    const pageLinks = [];
    if (page > 1) pageLinks.push(`<a class="page-btn" href="${makePageUrl(page-1)}">‹ ${tr(locale, '上一页', 'Previous')}</a>`);
    const start = Math.max(1, page - 3), end = Math.min(totalPages, page + 3);
    for (let p = start; p <= end; p++) {
      pageLinks.push(p === page
        ? `<span class="page-btn active">${p}</span>`
        : `<a class="page-btn" href="${makePageUrl(p)}">${p}</a>`);
    }
    if (page < totalPages) pageLinks.push(`<a class="page-btn" href="${makePageUrl(page+1)}">${tr(locale, '下一页', 'Next')} ›</a>`);
    pageLinks.push(`<span class="page-info">${tr(locale, `共 ${result.total} 条 / ${totalPages} 页`, `${result.total} items / ${totalPages} pages`)}</span>`);
    pagination = `<nav class="pagination">${pageLinks.join('')}</nav>`;
  }

  const emptyState = result.data.length === 0
    ? `<div class="empty-state"><p>${tr(locale, '暂无数据，请访问', 'No data yet. Visit')} <a href="/forceupdate">/forceupdate</a> ${tr(locale, '立即更新。', 'to update now.')}</p><a class="btn btn-primary" href="/forceupdate">${tr(locale, '立即更新数据', 'Update data')}</a></div>`
    : '';

  const body = `
  <div class="repos-header">
    <h1>${labels[category] || category}</h1>
    ${crawlDate ? `<p class="data-date">${tr(locale, '数据日期：', 'Data date: ')}${crawlDate}</p>` : ''}
  </div>
  <form class="filter-bar" method="get" action="${routePath('/repos', langPrefix)}">
    <input type="hidden" name="category" value="${category}"/>
    <input class="input-search" type="text" name="search" placeholder="${tr(locale, '搜索项目名/描述…', 'Search name or description...')}" value="${escHtml(search)}"/>
    <select name="lang" class="select-lang"><option value="">${tr(locale, '全部语言', 'All languages')}</option>${langOptions}</select>
    <select name="per_page" class="select-per-page">${perPageOptions}</select>
    <select name="date" class="select-date">${dateOptions}</select>
    <button class="btn btn-primary" type="submit">${tr(locale, '筛选', 'Filter')}</button>
    <a class="btn btn-ghost" href="${routePath(`/repos?category=${category}`, langPrefix)}">${tr(locale, '重置', 'Reset')}</a>
  </form>
  <div class="tab-bar">${tabs}</div>
  ${result.data.length ? `<div class="repo-list">${cards}</div>${pagination}` : emptyState}
  ${wechatPromoBlock('list', locale)}`;

  return html(baseLayout(`${labels[category] || category} — HotGit`, body, {
    env,
    locale,
    langPrefix,
    currentPath: currentListPath,
    alternatePath: currentListPath,
    description: pageDescription,
    canonicalUrl,
    robots: shouldNoIndex ? 'noindex,follow' : '',
    extraHead: jsonLdScript({
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${labels[category]} — ${SITE_NAME}`,
      url: canonicalUrl,
      description: pageDescription,
      inLanguage: locale,
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: result.data.slice(0, 20).map((repo, index) => ({
          '@type': 'ListItem',
          position: (page - 1) * perPage + index + 1,
          url: siteUrl(env, routePath(`/repo/${encodeURIComponent(repo.full_name.split('/')[0])}/${encodeURIComponent(repo.full_name.split('/').slice(1).join('/'))}`, langPrefix)),
          name: repo.full_name
        }))
      }
    })
  }));
}

async function pageForceUpdate(env) {
  const startTime = Date.now();
  const today = todayCST();
  const results = [];
  let hasError = false;

  // 逐个分类爬取，记录结果（不改变按天记录的逻辑，saveRepos 会覆盖今天同类数据）
  // 手动更新优先保证增量榜可用，并避免批量抓 README/主页导致超时或触发限流。
  const tasks = [
    { name: 'star_daily',   label: CATEGORY_LABELS.star_daily,   fn: () => fetchPotentialDailyRepos(env.DB, env.GITHUB_TOKEN || '') },
    { name: 'star_weekly',  label: CATEGORY_LABELS.star_weekly,  fn: () => githubSearch('stars:>100',            'stars', env.GITHUB_TOKEN || '') },
    { name: 'star_monthly', label: CATEGORY_LABELS.star_monthly, fn: () => githubSearch('stars:>100',             'stars', env.GITHUB_TOKEN || '') },
    { name: 'top_stars',    label: CATEGORY_LABELS.top_stars,    fn: () => githubSearch('stars:>1000',           'stars', env.GITHUB_TOKEN || '') },
    { name: 'top_forks',    label: CATEGORY_LABELS.top_forks,    fn: () => githubSearch('forks:>500',            'forks', env.GITHUB_TOKEN || '') },
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

  return html(baseLayout('立即更新 — HotGit', body, {
    description: '手动触发 HotGit 数据更新，仅供站点维护使用。',
    canonicalUrl: siteUrl(env, '/forceupdate'),
    robots: 'noindex,nofollow'
  }));
}

async function pageBackfillInsights(request, env) {
  const startTime = Date.now();
  const q = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(parseIntParam(q.get('limit'), 20), 1), 100);
  const repos = await getReposPendingProjectInsights(env.DB, limit);
  const insightCache = new Map();
  const results = [];

  for (const repo of repos) {
    const t0 = Date.now();
    try {
      await enrichProjectInsights(env.DB, [repo], env.GITHUB_TOKEN || '', repo.crawl_date, insightCache, { force: true });
      await updateRepoProjectInsight(env.DB, repo);
      results.push({
        full_name: repo.full_name,
        ok: true,
        hasInsight: Boolean(repo.project_insight),
        reason: repo.__insightReason || '',
        ms: Date.now() - t0,
      });
    } catch (e) {
      results.push({ full_name: repo.full_name, ok: false, error: e.message, ms: Date.now() - t0 });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const okCount = results.filter(r => r.ok).length;
  const rows = results.map(r => `
    <tr class="${r.ok ? '' : 'row-error'}">
      <td>${escHtml(r.full_name)}</td>
      <td>${r.ok ? '<span class="badge-ok">成功</span>' : '<span class="badge-err">失败</span>'}</td>
      <td>${r.ok ? (r.hasInsight ? escHtml(r.reason || '已生成') : '未生成') : '—'}</td>
      <td>${(r.ms / 1000).toFixed(1)}s</td>
      <td>${r.ok ? '—' : escHtml(r.error || '')}</td>
    </tr>`).join('');

  const body = `
  <div class="repos-header">
    <h1>🧩 补全存量项目详情</h1>
    <p class="data-date">本次最多处理 ${limit} 个缺少项目观察、或仓库更新时间晚于项目观察生成时间的存量项目。</p>
  </div>
  <p class="result-summary ${okCount === results.length ? 'ok' : 'warn'}">已处理 ${results.length} 个项目，成功 ${okCount} 个，耗时 ${elapsed}s。</p>
  ${results.length ? `<table class="result-table">
    <thead><tr><th>项目</th><th>状态</th><th>项目观察</th><th>耗时</th><th>错误</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '<div class="empty-state"><p>暂无需要补全的存量项目。</p></div>'}
  <div class="result-actions">
    <a class="btn btn-primary" href="/backfillinsights?limit=${limit}">继续补全下一批</a>
    <a class="btn btn-ghost" href="/">返回首页</a>
  </div>`;

  return html(baseLayout('补全存量项目详情 — HotGit', body, {
    description: '补全 HotGit 存量项目的项目观察总结，仅供站点维护使用。',
    canonicalUrl: siteUrl(env, '/backfillinsights'),
    robots: 'noindex,nofollow'
  }));
}

async function pageRepoDetail(env, owner, name, locale = DEFAULT_LOCALE, langPrefix = '') {
  const fullName = `${owner}/${name}`;
  const repo = await getRepoByName(env.DB, fullName);
  
  if (!repo) {
    return html(baseLayout(tr(locale, '仓库未找到 — HotGit', 'Repository Not Found — HotGit'), `
      <section class="empty-state">
        <h1>${tr(locale, '仓库未找到', 'Repository Not Found')}</h1>
        <p>${escHtml(fullName)} ${tr(locale, '不在热门榜单中。', 'is not in the current rankings.')}</p>
        <a class="btn btn-primary" href="${routePath('/', langPrefix)}">${tr(locale, '返回首页', 'Back Home')}</a>
      </section>`, {
      env,
      locale,
      langPrefix,
      currentPath: `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      alternatePath: `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      description: `${fullName} 暂未收录在 HotGit 热门榜单中。`,
      robots: 'noindex,follow'
    }), 404);
  }

  const history = await getRepoHistory(env.DB, fullName, 30);
  const related = await getRelatedRepos(env.DB, repo.language, fullName);
  const topicRelated = await getTopicRelatedRepos(env.DB, repo.topics, fullName);
  const crawlDate = await getLatestDate(env.DB);
  const fallbackProjectInsight = repo.project_insight || buildProjectInsight(repo, history, '', '');
  const localizedRepo = await getLocalizedRepoContent(env.DB, { ...repo, project_insight: fallbackProjectInsight }, locale, ['name', 'description', 'project_insight']);
  let projectInsight = localizedRepo.project_insight || fallbackProjectInsight;
  if (locale === 'en' && detectTextLanguage(projectInsight) === 'zh-CN') {
    projectInsight = buildEnglishProjectInsight(repo, history);
    await saveRepoFieldTranslation(env.DB, repo, 'project_insight', 'en', projectInsight, fallbackProjectInsight, 'zh-CN');
  }
  
  const title = `${repo.full_name} — HotGit`;
  const description = metaDescriptionFromInsight(
    projectInsight,
    localizedRepo.description || repo.description || `${repo.full_name} - ${repo.language} 项目，⭐ ${fmtNum(repo.stars)} Stars`
  );
  
  const translatedName = repo.translated_name || '';
  const localizedDescription = localizedRepo.description || repo.description || '';
  const alternateDescription = locale === 'zh-CN'
    ? (detectTextLanguage(repo.description || '') === 'en' ? repo.description : repo.translated_desc || '')
    : (detectTextLanguage(repo.description || '') === 'zh-CN' ? repo.description : repo.translated_desc || '');
  
  const repoLink = `
  <div class="repo-detail-header">
    <h1>
      <a href="${escHtml(repo.html_url)}" target="_blank" rel="noopener">${escHtml(repo.full_name)}</a>
      ${repo.language && repo.language !== 'Unknown' ? `<span class="lang-badge">${escHtml(repo.language)}</span>` : ''}
    </h1>
    ${translatedName ? `<p class="repo-name-trans">🌐 ${escHtml(translatedName)}</p>` : ''}
    ${localizedDescription ? `<p class="repo-desc">${escHtml(localizedDescription)}</p>` : ''}
    ${alternateDescription && alternateDescription !== localizedDescription ? `<p class="repo-desc-trans">🌐 ${escHtml(alternateDescription)}</p>` : ''}
  </div>
  <div class="repo-stats">
    <div class="stat-item"><span class="stat-value">⭐ ${fmtNum(repo.stars)}</span><span class="stat-label">Stars</span></div>
    <div class="stat-item"><span class="stat-value">🍴 ${fmtNum(repo.forks)}</span><span class="stat-label">Forks</span></div>
    <div class="stat-item"><span class="stat-value">🐛 ${repo.open_issues}</span><span class="stat-label">Issues</span></div>
    <div class="stat-item"><span class="stat-value">🕐 ${repo.pushed_at ? repo.pushed_at.slice(0,10) : '—'}</span><span class="stat-label">${tr(locale, '最近更新', 'Updated')}</span></div>
  </div>
  <div class="repo-links">
    <a class="btn btn-primary" href="${escHtml(repo.html_url)}" target="_blank" rel="noopener">🔗 GitHub</a>
    ${repo.homepage ? `<a class="btn btn-ghost" href="${escHtml(repo.homepage)}" target="_blank" rel="noopener">🌐 ${tr(locale, '主页', 'Website')}</a>` : ''}
  </div>`;

  const topicsHtml = repo.topics 
    ? `<div class="repo-topics">${repo.topics.split(',').filter(Boolean).map(t => `<span class="topic-tag">${escHtml(t)}</span>`).join('')}</div>` 
    : '';

  const insightHtml = `
    <section class="project-insight" aria-labelledby="project-insight-title">
      <div class="insight-kicker">${tr(locale, '项目观察', 'Project Insight')}</div>
      <h2 id="project-insight-title">${tr(locale, '为什么值得关注', 'Why It Is Worth Watching')}</h2>
      <p>${escHtml(projectInsight)}</p>
    </section>`;

  const chartHtml = history.length > 0 
    ? `<section class="trend-chart">
      <h2>📈 ${tr(locale, `趋势变化（${history.length}条数据）`, `Trend History (${history.length} points)`)}</h2>
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
    ? `<section class="related-repos"><h2>${tr(locale, '同语言热门项目', 'Popular Projects in the Same Language')}</h2><div class="repo-list">${related.map(r => `
      <a class="repo-card" href="${repoDetailPath(r.full_name, langPrefix)}">
        <div class="repo-main">
          <div class="repo-title-line"><span class="repo-name">${escHtml(r.full_name)}</span></div>
          <div class="repo-meta"><span>⭐ ${fmtNum(r.stars)}</span><span>🍴 ${fmtNum(r.forks)}</span></div>
        </div>
      </a>`).join('')}</div></section>`
    : '';

  const topicRelatedHtml = topicRelated.length
    ? `<section class="related-repos topic-related"><h2>${tr(locale, '同主题相关项目', 'Related Projects by Topic')}</h2><p class="related-intro">${tr(locale, '如果你正在调研同类工具，可以继续看看这些项目的实现思路、社区热度和近期增长表现。', 'If you are evaluating similar tools, compare implementation direction, community traction, and recent growth signals.')}</p><div class="repo-list">${topicRelated.map(r => `
      <a class="repo-card" href="${repoDetailPath(r.full_name, langPrefix)}">
        <div class="repo-main">
          <div class="repo-title-line"><span class="repo-name">${escHtml(r.full_name)}</span>${r.language && r.language !== 'Unknown' ? `<span class="lang-badge">${escHtml(r.language)}</span>` : ''}</div>
          ${r.description ? `<p class="repo-desc">${escHtml(r.description)}</p>` : ''}
          <div class="repo-meta"><span>⭐ ${fmtNum(r.stars)}</span><span>🍴 ${fmtNum(r.forks)}</span></div>
        </div>
      </a>`).join('')}</div></section>`
    : '';

  const detailPath = `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const canonicalUrl = siteUrl(env, routePath(detailPath, langPrefix));

  const body = `
  ${repoLink}
  ${topicsHtml}
  ${insightHtml}
  ${chartHtml}
  ${topicRelatedHtml}
  ${relatedHtml}
  ${wechatPromoBlock('detail', locale)}`;

  const detailJsonLd = jsonLdScript({
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name: repo.full_name,
    description,
    abstract: projectInsight,
    url: canonicalUrl,
    codeRepository: repo.html_url,
    programmingLanguage: repo.language && repo.language !== 'Unknown' ? repo.language : undefined,
    dateModified: repo.pushed_at ? repo.pushed_at.slice(0, 10) : undefined,
    interactionStatistic: [
      {
        '@type': 'InteractionCounter',
        interactionType: 'https://schema.org/LikeAction',
        userInteractionCount: Number(repo.stars || 0)
      },
      {
        '@type': 'InteractionCounter',
        interactionType: 'https://schema.org/ForkAction',
        userInteractionCount: Number(repo.forks || 0)
      }
    ]
  });

  return html(baseLayout(title, body, {
    env,
    locale,
    langPrefix,
    currentPath: detailPath,
    alternatePath: detailPath,
    description,
    canonicalUrl,
    ogType: 'article',
    extraHead: detailJsonLd
  }));
}

async function pageRepoDetailById(env, id, locale = DEFAULT_LOCALE, langPrefix = '') {
  const repo = await getRepoById(env.DB, id);
  
  if (!repo) {
    return withRobotsHeader(html(baseLayout(tr(locale, '仓库已移除 — HotGit', 'Repository Gone — HotGit'), `
      <section class="empty-state">
        <h1>${tr(locale, '仓库已移除', 'Repository Gone')}</h1>
        <p>ID: ${id} ${tr(locale, '当前没有可用的仓库映射，搜索引擎可以从索引中移除此短链接。', 'no longer has an available repository mapping. Search engines can remove this short URL from their index.')}</p>
        <a class="btn btn-primary" href="${routePath('/', langPrefix)}">${tr(locale, '返回首页', 'Back Home')}</a>
      </section>`, {
      env,
      locale,
      langPrefix,
      description: `ID ${id} 已无可用仓库映射。`,
      robots: 'noindex,follow'
    }), 410));
  }

  const [owner, ...nameParts] = repo.full_name.split('/');
  const name = nameParts.join('/');
  return withRobotsHeader(Response.redirect(siteUrl(env, routePath(`/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, langPrefix)), 301));
}

async function pageSitemap(env, localeFilter = null) {
  const domain = getDomain(env);
  const host = `https://${domain}`;
  const sitemapRepos = await getSitemapRepos(env.DB);
  const dates = await getCrawlDates(env.DB);
  const listCounts = await getSitemapListCounts(env.DB);
  const locales = localeFilter ? [normalizeLocale(localeFilter)] : Object.keys(LOCALES);
  const latestDate = dates[0] || '';
  const sitemapEntry = (loc, changefreq, priority, lastmod = latestDate) => `
  <url><loc>${escXml(loc)}</loc>${lastmod ? `<lastmod>${escXml(lastmod)}</lastmod>` : ''}<changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
  const addRepoListEntries = (prefix = '') => {
    let entries = sitemapEntry(`${host}${prefix}/repos`, 'daily', '0.9');
    for (const category of Object.keys(CATEGORY_LABELS)) {
      const freq = category === 'star_monthly' || category === 'star_weekly' ? 'weekly' : 'daily';
      entries += sitemapEntry(`${host}${prefix}/repos?category=${encodeURIComponent(category)}`, freq, '0.8');
    }
    for (const row of listCounts) {
      if (!dates.slice(0, 30).includes(row.crawl_date)) continue;
      const category = CATEGORY_LABELS[row.category] ? row.category : 'top_stars';
      const freq = category === 'star_monthly' || category === 'star_weekly' ? 'weekly' : 'daily';
      const baseUrl = `${host}${prefix}/repos?category=${encodeURIComponent(category)}&date=${encodeURIComponent(row.crawl_date)}`;
      entries += sitemapEntry(baseUrl, freq, '0.7', row.crawl_date);
      const totalPages = Math.ceil((Number(row.total) || 0) / 20);
      for (let page = 2; page <= totalPages; page++) {
        entries += sitemapEntry(`${baseUrl}&page=${page}`, freq, '0.5', row.crawl_date);
      }
    }
    return entries;
  };
  
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

  if (!localeFilter) {
    xml += sitemapEntry(`${host}/`, 'daily', '1.0');
    xml += sitemapEntry(`${host}/about`, 'monthly', '0.7');
    xml += addRepoListEntries();
    for (const date of dates.slice(0, 30)) {
      xml += sitemapEntry(`${host}/repos?date=${encodeURIComponent(date)}`, 'daily', '0.6', date);
    }
    for (const sitemapRepo of sitemapRepos) {
      const [owner, ...repoParts] = sitemapRepo.full_name.split('/');
      const repo = repoParts.join('/');
      xml += sitemapEntry(`${host}/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, 'weekly', '0.7', sitemapRepo.lastmod || latestDate);
    }
  }

  for (const locale of locales) {
    const prefix = LOCALES[locale].prefix;
    xml += sitemapEntry(`${host}${prefix}/`, 'daily', '1.0');
    xml += sitemapEntry(`${host}${prefix}/about`, 'monthly', '0.7');
    xml += sitemapEntry(`${host}${prefix}/llms.txt`, 'monthly', '0.4');
    xml += addRepoListEntries(prefix);
    for (const date of dates.slice(0, 30)) {
      xml += sitemapEntry(`${host}${prefix}/repos?date=${encodeURIComponent(date)}`, 'daily', '0.6', date);
    }

    for (const sitemapRepo of sitemapRepos) {
      const [owner, ...repoParts] = sitemapRepo.full_name.split('/');
      const repo = repoParts.join('/');
      xml += sitemapEntry(`${host}${prefix}/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, 'weekly', '0.7', sitemapRepo.lastmod || latestDate);
    }
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
Disallow: /api/
Disallow: /forceupdate
Disallow: /backfillinsights

Sitemap: https://${domain}/sitemap.xml
Sitemap: https://${domain}/zh-CN/sitemap.xml
Sitemap: https://${domain}/en/sitemap.xml
LLM-Content: https://${domain}/llms.txt
LLM-Content: https://${domain}/zh-CN/llms.txt
LLM-Content: https://${domain}/en/llms.txt
`;
  return new Response(robots, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

function pageLlmsTxt(env, locale = DEFAULT_LOCALE) {
  locale = normalizeLocale(locale || DEFAULT_LOCALE);
  const host = `https://${getDomain(env)}`;
  if (locale === 'en') {
    const text = `# HotGit

HotGit is a GitHub trending repositories tracker for developers, engineering teams, and open-source observers. The site updates Star rankings, Fork rankings, daily Star growth, weekly Star growth, monthly Star growth, and project detail pages with growth signals, related projects, and original GitHub links.

## AI-citable Pages

- Home: ${host}/en/
- About HotGit: ${host}/en/about
- Top Stars: ${host}/en/repos?category=top_stars
- Top Forks: ${host}/en/repos?category=top_forks
- Daily Stars: ${host}/en/repos?category=star_daily
- Weekly Stars: ${host}/en/repos?category=star_weekly
- Monthly Stars: ${host}/en/repos?category=star_monthly
- Sitemap: ${host}/en/sitemap.xml

## Content Notes

Project detail pages combine GitHub README text, project homepage title/description, repository description, topics, language, Stars/Forks, recent update date, and historical Star deltas. Use HotGit for open-source trend observation, project discovery, early technical evaluation, and comparison between related tools.

## Citation Guidance

When citing HotGit, prefer linking to a concrete project detail page and preserve the original GitHub repository link. More site context and citation boundaries are available at ${host}/en/about.`;

    return new Response(text, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  const text = `# HotGit

HotGit 是一个面向开发者和开源观察者的 GitHub 热门项目追踪站点。站点每天更新 Star 总榜、Fork 总榜、日增 Star、周增 Star、月增 Star，并为项目详情页补充中文项目观察、增长趋势、同主题相关项目和 GitHub 原始链接。

## 适合 AI 引用的页面

- 首页: ${host}/zh-CN/
- 关于 HotGit: ${host}/zh-CN/about
- Star 总榜: ${host}/zh-CN/repos?category=top_stars
- Fork 总榜: ${host}/zh-CN/repos?category=top_forks
- 日增 Star: ${host}/zh-CN/repos?category=star_daily
- 周增 Star: ${host}/zh-CN/repos?category=star_weekly
- 月增 Star: ${host}/zh-CN/repos?category=star_monthly
- Sitemap: ${host}/zh-CN/sitemap.xml

## 内容说明

项目详情页的“为什么值得关注”来自 GitHub README、项目主页 title/description、项目描述、topics、语言、Star/Fork、最近更新时间和历史 Star 差量。它用于帮助读者快速判断一个开源项目解决什么问题、适合谁、最近为什么值得看，以及进一步评估时应该关注哪些风险点。

## 引用建议

引用 HotGit 内容时，请优先链接到具体项目详情页，并保留项目 GitHub 原始仓库链接。HotGit 的榜单数据会随 GitHub 项目热度变化而更新，适合用于开源趋势观察、项目发现、技术选型前的初筛和同类项目对比。更多站点说明和引用边界见 ${host}/zh-CN/about。`;

  return new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// ── 工具函数 ───────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escXml(s) {
  return escHtml(s).replace(/'/g,'&apos;');
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
.lang-switch{display:flex;gap:.25rem;margin-left:auto;border:1px solid var(--border);border-radius:999px;padding:.15rem;background:var(--bg)}
.lang-link{display:inline-flex;align-items:center;justify-content:center;min-width:42px;padding:.18rem .55rem;border-radius:999px;color:var(--text-muted);font-size:.78rem;font-weight:600;text-decoration:none!important}
.lang-link:hover{background:var(--bg-card-h);color:var(--text)}
.lang-link.active{background:var(--primary);color:#fff}
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
.about-page{max-width:920px;margin:0 auto}
.about-hero{padding:2rem 0 1.25rem;border-bottom:1px solid var(--border);margin-bottom:1.75rem}
.about-kicker{display:inline-flex;margin-bottom:.55rem;padding:.12rem .55rem;border-radius:999px;background:#0d2137;border:1px solid #1f4b6e;color:#79b8ff;font-size:.72rem;font-weight:700;letter-spacing:.08em}
.about-hero h1{font-size:2rem;line-height:1.25;margin-bottom:.8rem}
.about-hero p,.about-section p,.about-card p,.faq-section p{color:var(--text-muted)}
.about-section{margin:1.75rem 0}
.about-section h2,.about-card h2{font-size:1.2rem;margin-bottom:.55rem}
.about-section p{margin:.65rem 0;line-height:1.78}
.about-list{display:flex;flex-direction:column;gap:.45rem;margin:.75rem 0 0 1.25rem;color:var(--text-muted)}
.about-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;margin:2rem 0}
.about-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem 1.2rem}
.faq-section details{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:.8rem 1rem;margin:.7rem 0}
.faq-section summary{cursor:pointer;font-weight:600;color:var(--text)}
.faq-section details p{margin:.55rem 0 0}
.crawl-status{display:block;margin-top:.75rem;font-size:.9rem;min-height:1.2em}
.crawl-status.info{color:#58a6ff}.crawl-status.success{color:#3fb950}.crawl-status.error{color:#f85149}
.wechat-promo{max-width:600px;margin:2.5rem auto 0;padding:.78rem .9rem;background:linear-gradient(135deg,#111820 0%,#161b22 100%);border:1px solid var(--border);border-radius:12px;box-shadow:none;overflow:hidden}
.wechat-promo-table{width:100%;border-collapse:collapse;table-layout:auto}
.wechat-promo-copy{width:auto;min-width:0;padding:0 .9rem 0 0;vertical-align:middle}
.wechat-promo-media{width:1%;padding:0;vertical-align:middle;text-align:right;white-space:nowrap}
.wechat-promo-home{margin-top:2.5rem}
.wechat-promo-list{margin-top:2rem}
.wechat-promo-detail{margin-top:2.25rem}
.promo-eyebrow{display:inline-flex;margin-bottom:.28rem;padding:.1rem .48rem;border-radius:999px;background:#2386361a;border:1px solid #2ea0434d;color:#7ee787;font-size:.68rem;font-weight:700;letter-spacing:.08em}
.wechat-promo h2{font-size:.96rem;margin-bottom:.24rem}
.wechat-promo p{color:var(--text-muted);font-size:.8rem;line-height:1.5}
.wechat-promo-img{display:block;width:auto;height:132px;max-width:none;border-radius:8px;background:#07c160;box-shadow:0 5px 14px rgba(0,0,0,.16)}
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
.related-intro{color:var(--text-muted);font-size:.88rem;margin:-.4rem 0 1rem}
.repo-desc-trans{color:var(--text-muted);font-size:.95rem;margin-top:.5rem}
.project-insight{margin:1.5rem 0;padding:1.25rem 1.35rem;background:linear-gradient(135deg,#161b22 0%,#101722 100%);border:1px solid #2a4d6f;border-radius:var(--radius);box-shadow:var(--shadow)}
.project-insight .insight-kicker{display:inline-flex;margin-bottom:.45rem;padding:.12rem .5rem;border-radius:999px;background:#0d2137;border:1px solid #1f4b6e;color:#79b8ff;font-size:.72rem;font-weight:700;letter-spacing:.08em}
.project-insight h2{font-size:1.15rem;margin-bottom:.45rem}
.project-insight p{color:var(--text-muted);font-size:.96rem;line-height:1.75}
.trend-chart{margin:2rem 0;padding:1.5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)}
.trend-chart h2{font-size:1.2rem;margin-bottom:1rem;color:var(--text-muted)}
.chart-container{position:relative;height:300px}
.footer{border-top:1px solid var(--border);padding:1.25rem;text-align:center;font-size:.82rem;color:var(--text-muted);background:var(--bg-card)}
@media(max-width:420px){.wechat-promo{padding:.7rem}.wechat-promo-copy{padding-right:.65rem}.wechat-promo-img{width:auto;height:112px}.wechat-promo h2{font-size:.9rem}.wechat-promo p{font-size:.76rem;line-height:1.45}.promo-eyebrow{font-size:.62rem}}
@media(max-width:760px){.about-grid{grid-template-columns:1fr}.about-hero h1{font-size:1.45rem}.about-hero{padding-top:1rem}}
@media(max-width:640px){.navbar{padding:.55rem 1rem;height:auto;align-items:flex-start;gap:.75rem;flex-wrap:wrap}.lang-switch{margin-left:0}.hero h1{font-size:1.5rem}.repo-card{flex-direction:column;gap:.5rem}.repo-rank{text-align:left}.repo-stats{gap:.75rem}.repo-stats .stat-item{min-width:80px;padding:.75rem}.wechat-promo{padding:.85rem}.wechat-promo h2{font-size:.98rem}}
`;
