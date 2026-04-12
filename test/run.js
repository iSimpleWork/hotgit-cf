/**
 * HotGit CF — 测试套件（独立版，不动态 import worker.js）
 * 运行：node test/run.js
 */

// ── 颜色输出 ────────────────────────────────────────────────────────
const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const BOLD   = s => `\x1b[1m${s}\x1b[0m`;

let passed = 0, failed = 0;

function assert(desc, condition, detail = '') {
  if (condition) {
    console.log(GREEN('  ✓') + ' ' + desc);
    passed++;
  } else {
    console.log(RED('  ✗') + ' ' + desc + (detail ? `\n      ${RED(detail)}` : ''));
    failed++;
  }
}
function assertEqual(desc, a, b) {
  assert(desc, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertContains(desc, str, sub) {
  assert(desc, String(str).includes(sub), `"${sub}" not found`);
}

// ════════════════════════════════════════════════════════════════════
// 从 worker.js 复制的纯函数（保持与源码一致，测试其正确性）
// ════════════════════════════════════════════════════════════════════

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

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

function todayCST() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function sinceDate(days) {
  const d = new Date(Date.now() + 8 * 3600_000 - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

function parseIntParam(v, def) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
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

// ════════════════════════════════════════════════════════════════════
// Mock D1 Database（内存实现，满足 Worker 中的 D1 接口）
// ════════════════════════════════════════════════════════════════════

class MockD1 {
  constructor() {
    this._repos    = [];
    this._logs     = [];
    this._history  = [];
    this._nextId   = 1;
  }
  prepare(sql) { return new MockStatement(sql, this); }
  async batch(stmts) { for (const s of stmts) await s.run(); }
}

class MockStatement {
  constructor(sql, db) { this._sql = sql.trim(); this._db = db; this._p = []; }
  bind(...p) { this._p = p; return this; }
  async run()   { return this._exec(); }
  async first() { const r = this._exec(); return r?.results?.[0] ?? null; }
  async all()   { return this._exec(); }

  _exec() {
    const { _sql: sql, _p: p, _db: db } = this;

    if (/^INSERT INTO repos/i.test(sql)) {
      db._repos.push({ id: db._nextId++, crawl_date:p[0], category:p[1], rank:p[2],
        full_name:p[3], html_url:p[4], description:p[5], language:p[6],
        stars:p[7], forks:p[8], open_issues:p[9], pushed_at:p[10], topics:p[11], homepage:p[12] });
      return { results:[], success:true };
    }
    if (/^INSERT INTO repo_stars_history/i.test(sql)) {
      const existing = db._history.findIndex(h => h.full_name === p[0] && h.crawl_date === p[1]);
      if (existing >= 0) {
        db._history[existing] = { id: db._history[existing].id, full_name: p[0], crawl_date: p[1], stars: p[2], forks: p[3] };
      } else {
        db._history.push({ id: db._nextId++, full_name: p[0], crawl_date: p[1], stars: p[2], forks: p[3] });
      }
      return { results:[], success:true };
    }
    if (/^SELECT.*FROM repo_stars_history.*WHERE.*full_name/i.test(sql)) {
      const h = db._history.find(h => h.full_name === p[0] && h.crawl_date === p[1]);
      return { results: h ? [h] : [], success: true };
    }
    if (/^INSERT INTO crawl_log/i.test(sql)) {
      db._logs.push({ crawl_date:p[0], category:p[1], count:p[2], status:p[3], message:p[4] });
      return { results:[], success:true };
    }
    if (/^DELETE FROM repos/i.test(sql)) {
      db._repos = db._repos.filter(r => !(r.crawl_date===p[0] && r.category===p[1]));
      return { results:[], success:true };
    }
    if (/SELECT MAX\(crawl_date\)/i.test(sql)) {
      const dates = db._repos.map(r=>r.crawl_date).sort();
      return { results:[{ d: dates.length ? dates[dates.length-1] : null }], success:true };
    }
    if (/SELECT COUNT\(\*\) AS n FROM repos/i.test(sql)) {
      return { results:[{ n: this._filter(p).length }], success:true };
    }
    if (/GROUP BY category/i.test(sql)) {
      const bycat = {};
      db._repos.filter(r=>r.crawl_date===p[0]).forEach(r=>{ bycat[r.category]=(bycat[r.category]||0)+1; });
      return { results:Object.entries(bycat).map(([category,cnt])=>({category,cnt})), success:true };
    }
    if (/SELECT DISTINCT crawl_date/i.test(sql)) {
      const dates = [...new Set(db._repos.map(r=>r.crawl_date))].sort().reverse();
      return { results:dates.map(d=>({crawl_date:d})), success:true };
    }
    if (/SELECT DISTINCT language/i.test(sql)) {
      const langs = [...new Set(db._repos.filter(r=>r.crawl_date===p[0]&&r.category===p[1]&&r.language).map(r=>r.language))].sort();
      return { results:langs.map(l=>({language:l})), success:true };
    }
    if (/SELECT \* FROM repos/i.test(sql)) {
      const limit = p[p.length-2], offset = p[p.length-1];
      const filtered = this._filter(p.slice(0,p.length-2)).sort((a,b)=>a.rank-b.rank);
      return { results:filtered.slice(offset, offset+limit), success:true };
    }
    return { results:[], success:true };
  }

  _filter(p) {
    // p[0]=crawl_date, p[1]=category, p[2]?=lang or search
    return this._db._repos.filter(r => {
      if (r.crawl_date!==p[0] || r.category!==p[1]) return false;
      if (p.length>=3) {
        if (!p[2].includes('%')) {
          if (r.language!==p[2]) return false;  // lang filter
        } else {
          const q = p[2].replace(/%/g,'').toLowerCase();
          if (!r.full_name.toLowerCase().includes(q) && !(r.description||'').toLowerCase().includes(q)) return false;
        }
      }
      return true;
    });
  }
}

// ════════════════════════════════════════════════════════════════════
// 数据库操作（与 worker.js 保持一致）
// ════════════════════════════════════════════════════════════════════

async function saveRepos(db, repos, crawlDate) {
  if (!repos.length) return;
  const category = repos[0].category;
  await db.prepare('DELETE FROM repos WHERE crawl_date = ? AND category = ?').bind(crawlDate, category).run();
  const stmts = repos.map(r =>
    db.prepare(`INSERT INTO repos (crawl_date,category,rank,full_name,html_url,description,language,stars,forks,open_issues,pushed_at,topics,homepage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(crawlDate, r.category, r.rank, r.full_name, r.html_url, r.description, r.language, r.stars, r.forks, r.open_issues, r.pushed_at, r.topics, r.homepage)
  );
  await db.batch(stmts);
}

async function getLatestDate(db) {
  const row = await db.prepare('SELECT MAX(crawl_date) AS d FROM repos').first();
  return row?.d || null;
}

async function getStats(db) {
  const date = await getLatestDate(db);
  if (!date) return { date: null, categories: {} };
  const rows = await db.prepare('SELECT category, COUNT(*) AS cnt FROM repos WHERE crawl_date = ? GROUP BY category').bind(date).all();
  const categories = {};
  for (const r of rows.results) categories[r.category] = r.cnt;
  return { date, categories };
}

async function queryRepos(db, { category, crawlDate, page, perPage, lang, search }) {
  if (!crawlDate) crawlDate = await getLatestDate(db);
  if (!crawlDate) return { total:0, page, per_page:perPage, data:[] };
  const conditions = ['crawl_date = ?', 'category = ?'];
  const params = [crawlDate, category];
  if (lang)   { conditions.push('language = ?'); params.push(lang); }
  if (search) { conditions.push('(full_name LIKE ? OR description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const where = conditions.join(' AND ');
  const countRow = await db.prepare(`SELECT COUNT(*) AS n FROM repos WHERE ${where}`).bind(...params).first();
  const total = countRow?.n || 0;
  const offset = (page-1)*perPage;
  const rows = await db.prepare(`SELECT * FROM repos WHERE ${where} ORDER BY rank ASC LIMIT ? OFFSET ?`).bind(...params, perPage, offset).all();
  return { total, page, per_page:perPage, data:rows.results };
}

// ── 生成测试数据 ────────────────────────────────────────────────────
function makeSampleRepos(category, count = 25) {
  return Array.from({ length: count }, (_, i) => ({
    category,
    rank: i + 1,
    full_name: `owner/repo-${i}`,
    html_url: `https://github.com/owner/repo-${i}`,
    description: `Description of repo ${i}`,
    language: i % 2 === 0 ? 'Python' : 'JavaScript',
    stars: 50000 - i * 100,
    forks: 10000 - i * 50,
    open_issues: i * 2,
    pushed_at: '2026-03-14 10:00:00',
    topics: 'test,open-source',
    homepage: '',
  }));
}

// ════════════════════════════════════════════════════════════════════
// 测试套件
// ════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(BOLD('\n========================================'));
console.log(BOLD(' HotGit CF — Test Suite'));
console.log(BOLD('========================================\n'));

// ── Suite 1: 工具函数 ───────────────────────────────────────────────
console.log(YELLOW('Suite 1: Utility Functions'));

{
  const repo = fmtRepo({
    full_name: 'torvalds/linux',
    html_url: 'https://github.com/torvalds/linux',
    description: 'Linux kernel',
    language: 'C',
    stargazers_count: 200000,
    forks_count: 50000,
    open_issues_count: 500,
    pushed_at: '2026-03-14T08:00:00Z',
    topics: ['kernel', 'os'],
    homepage: 'https://www.kernel.org',
  }, 'top_stars', 1);

  assertEqual('fmtRepo: full_name',        repo.full_name,  'torvalds/linux');
  assertEqual('fmtRepo: stars',             repo.stars,      200000);
  assertEqual('fmtRepo: forks',             repo.forks,      50000);
  assertEqual('fmtRepo: category',          repo.category,   'top_stars');
  assertEqual('fmtRepo: rank',              repo.rank,       1);
  // pushed_at = UTC 08:00 = CST 16:00，+8h 后日期仍是 2026-03-14
  assert('fmtRepo: pushed_at date is CST 2026-03-14', repo.pushed_at.startsWith('2026-03-14'));
  assertEqual('fmtRepo: topics joined',     repo.topics,     'kernel,os');
  assertEqual('fmtRepo: language',          repo.language,   'C');
}

{
  // 跨日边界：UTC 2026-03-15T00:30:00Z = CST 2026-03-15T08:30:00+08
  // 不加 +8h 时 toISOString() 取的是 UTC 日期 2026-03-15，恰好相同；
  // 但 UTC 2026-03-13T23:00:00Z = CST 2026-03-14T07:00:00+08 → 应显示 2026-03-14 而非 2026-03-13
  const rEdge = fmtRepo({
    full_name: 'edge/case', html_url: 'https://github.com/edge/case',
    pushed_at: '2026-03-13T23:00:00Z',  // UTC 23:00 = CST 次日 07:00
  }, 'top_stars', 1);
  assert('fmtRepo: UTC 23:00 → CST 次日日期', rEdge.pushed_at.startsWith('2026-03-14'));
}

{
  const r = fmtRepo({ full_name:'a/b', html_url:'https://github.com/a/b' }, 'top_forks', 5);
  assertEqual('fmtRepo minimal: stars=0',       r.stars,       0);
  assertEqual('fmtRepo minimal: description=""', r.description, '');
  assertEqual('fmtRepo minimal: language Unknown', r.language, 'Unknown');
  assertEqual('fmtRepo minimal: topics=""',     r.topics,      '');
}

{
  const html = `
    <article><h2><a href="/foo/bar">foo/bar</a></h2></article>
    <article><h2><a href="/baz/qux">baz/qux</a></h2></article>
    <a href="/foo/bar/issues">issues</a>
    <a href="/foo/bar/pulls">pulls</a>
  `;
  const names = parseTrendingRepoNames(html);
  assertEqual('parseTrendingRepoNames: first repo', names[0], 'foo/bar');
  assertEqual('parseTrendingRepoNames: second repo', names[1], 'baz/qux');
  assertEqual('parseTrendingRepoNames: ignores issue/pull links', names.length, 2);
}

{
  const now = Date.parse('2026-04-12T00:00:00Z');
  const repo = {
    stargazers_count: 300,
    created_at: '2026-04-05T00:00:00Z',
    pushed_at: '2026-04-11T12:00:00Z',
  };
  const scored = scorePotentialDailyRepo(repo, {
    historyDay: { stars: 220 },
    historyWeek: { stars: 80 },
    isTrending: true,
    now,
  });
  assertEqual('scorePotentialDailyRepo: daily gain', scored.dailyGain, 80);
  assertEqual('scorePotentialDailyRepo: weekly gain', scored.weeklyGain, 220);
  assert('scorePotentialDailyRepo: trending boosts score', scored.score > 500);
}

{
  const now = Date.parse('2026-04-12T00:00:00Z');
  const repo = {
    stargazers_count: 120,
    created_at: '2026-04-10T00:00:00Z',
    pushed_at: '2026-04-11T08:00:00Z',
  };
  const scored = scorePotentialDailyRepo(repo, {
    historyDay: null,
    historyWeek: null,
    isTrending: false,
    now,
  });
  assertEqual('scorePotentialDailyRepo: no daily history means no daily gain', scored.dailyGain, 0);
  assert('scorePotentialDailyRepo: cold start still gets positive score', scored.score > 0);
}

{
  const items = [
    {
      repo: { full_name: 'b/non-trending-high', stargazers_count: 9999 },
      sources: new Set(),
      dailyGain: 500,
      weeklyGain: 900,
      score: 3000,
    },
    {
      repo: { full_name: 'a/trending-lower', stargazers_count: 5000 },
      sources: new Set(['trending']),
      dailyGain: 200,
      weeklyGain: 300,
      score: 1200,
    },
    {
      repo: { full_name: 'c/trending-higher-stars', stargazers_count: 6000 },
      sources: new Set(['trending']),
      dailyGain: 200,
      weeklyGain: 250,
      score: 1100,
    },
  ];
  items.sort(comparePotentialDailyRepo);
  assertEqual('comparePotentialDailyRepo: trending group comes first', items[0].repo.full_name, 'c/trending-higher-stars');
  assertEqual('comparePotentialDailyRepo: trending tie breaks by stars', items[1].repo.full_name, 'a/trending-lower');
  assertEqual('comparePotentialDailyRepo: non-trending comes after trending', items[2].repo.full_name, 'b/non-trending-high');
}

assertEqual('escHtml: & → &amp;',      escHtml('a & b'),   'a &amp; b');
assertEqual('escHtml: < → &lt;',       escHtml('<script>'), '&lt;script&gt;');
assertEqual('escHtml: " → &quot;',     escHtml('"x"'),      '&quot;x&quot;');
assertEqual('escHtml: null → ""',      escHtml(null),       '');
assertEqual('escHtml: empty → ""',     escHtml(''),         '');

assertEqual('fmtNum: 1000 → 1,000',    fmtNum(1000),   '1,000');
assertEqual('fmtNum: 0 → 0',           fmtNum(0),      '0');
assertEqual('fmtNum: 1500000',         fmtNum(1500000), '1,500,000');

assert('sinceDate(1) < todayCST',      sinceDate(1) < todayCST());
assert('sinceDate(7) < sinceDate(1)',  sinceDate(7) < sinceDate(1));
assert('sinceDate(30) < sinceDate(7)', sinceDate(30) < sinceDate(7));

// todayCST 返回 YYYY-MM-DD 格式
assert('todayCST: format YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(todayCST()));
// todayCST 应 >= UTC 日期（CST 比 UTC 早 8 小时，日期只会相同或更大）
assert('todayCST >= UTC date', todayCST() >= new Date().toISOString().slice(0, 10));

assertEqual('parseIntParam valid "42"', parseIntParam('42', 1),  42);
assertEqual('parseIntParam invalid',    parseIntParam('abc', 5), 5);
assertEqual('parseIntParam null',       parseIntParam(null, 3),  3);
assertEqual('parseIntParam "0"',        parseIntParam('0', 10),  0);

// ── Suite 2: Mock D1 数据库操作 ─────────────────────────────────────
console.log(YELLOW('\nSuite 2: Database Operations (Mock D1)'));

{
  const db = new MockD1();
  assertEqual('empty DB: latest date null', await getLatestDate(db), null);
  const stats = await getStats(db);
  assertEqual('empty DB: stats.date null', stats.date, null);
  const result = await queryRepos(db, { category:'top_stars', crawlDate:null, page:1, perPage:20, lang:'', search:'' });
  assertEqual('empty DB: total=0', result.total, 0);
  assertEqual('empty DB: data empty', result.data.length, 0);
}

{
  const db = new MockD1();
  const repos = makeSampleRepos('top_stars', 25);
  await saveRepos(db, repos, '2026-03-14');

  assertEqual('after save: latest date', await getLatestDate(db), '2026-03-14');

  const stats = await getStats(db);
  assertEqual('getStats: date', stats.date, '2026-03-14');
  assertEqual('getStats: count', stats.categories['top_stars'], 25);

  const p1 = await queryRepos(db, { category:'top_stars', crawlDate:'2026-03-14', page:1, perPage:10, lang:'', search:'' });
  assertEqual('page1: total=25',     p1.total, 25);
  assertEqual('page1: 10 items',     p1.data.length, 10);
  assertEqual('page1: first rank=1', p1.data[0].rank, 1);

  const p2 = await queryRepos(db, { category:'top_stars', crawlDate:'2026-03-14', page:2, perPage:10, lang:'', search:'' });
  assertEqual('page2: first rank=11', p2.data[0].rank, 11);

  const p3 = await queryRepos(db, { category:'top_stars', crawlDate:'2026-03-14', page:3, perPage:10, lang:'', search:'' });
  assertEqual('page3: 5 items (last page)', p3.data.length, 5);
}

{
  const db = new MockD1();
  const repos = makeSampleRepos('top_stars', 20);
  await saveRepos(db, repos, '2026-03-14');

  const pyFilter = await queryRepos(db, { category:'top_stars', crawlDate:'2026-03-14', page:1, perPage:20, lang:'Python', search:'' });
  assert('lang filter: all Python', pyFilter.data.every(r => r.language==='Python'));
  assert('lang filter: count>0', pyFilter.total > 0);
}

{
  const db = new MockD1();
  const repos = makeSampleRepos('top_stars', 25);
  // 同一天同类别写两次，不应重复
  await saveRepos(db, repos, '2026-03-14');
  await saveRepos(db, repos, '2026-03-14');
  const result = await queryRepos(db, { category:'top_stars', crawlDate:'2026-03-14', page:1, perPage:100, lang:'', search:'' });
  assertEqual('no duplicates on re-save', result.total, 25);
}

{
  // 多类别
  const db = new MockD1();
  await saveRepos(db, makeSampleRepos('top_stars', 10), '2026-03-14');
  await saveRepos(db, makeSampleRepos('top_forks', 10), '2026-03-14');
  const stats = await getStats(db);
  assertEqual('multi-category: top_stars', stats.categories['top_stars'], 10);
  assertEqual('multi-category: top_forks', stats.categories['top_forks'], 10);
}

// ── Suite 3: 配置文件校验 ───────────────────────────────────────────
console.log(YELLOW('\nSuite 3: Configuration Validation'));

{
  const toml = readFileSync(path.join(__dirname, '../wrangler.toml'), 'utf8');
  assertContains('wrangler.toml: cron trigger',     toml, 'crons');
  assertContains('wrangler.toml: 20:00 UTC cron',   toml, '0 20 * * *');
  assertContains('wrangler.toml: D1 binding',        toml, 'd1_databases');
  assertContains('wrangler.toml: binding DB',         toml, 'binding');
  assertContains('wrangler.toml: main worker',       toml, 'src/worker.js');
}

{
  const sql = readFileSync(path.join(__dirname, '../migrations/0001_init.sql'), 'utf8');
  assertContains('migration: repos table',           sql, 'CREATE TABLE IF NOT EXISTS repos');
  assertContains('migration: crawl_log table',       sql, 'CREATE TABLE IF NOT EXISTS crawl_log');
  assertContains('migration: date+cat index',        sql, 'idx_repos_date_cat');
  assertContains('migration: crawl_date column',     sql, 'crawl_date');
  assertContains('migration: stars column',          sql, 'stars');
  assertContains('migration: forks column',          sql, 'forks');
}

// ── Suite 4: Worker 源码结构校验 ────────────────────────────────────
console.log(YELLOW('\nSuite 4: Worker Source Validation'));

{
  const src = readFileSync(path.join(__dirname, '../src/worker.js'), 'utf8');
  assertContains('worker: export default',           src, 'export default');
  assertContains('worker: scheduled handler',        src, 'async scheduled');
  assertContains('worker: fetch handler',            src, 'async fetch');
  assertContains('worker: runCrawl function',        src, 'async function runCrawl');
  assertContains('worker: fetchAll function',        src, 'async function fetchAll');
  assertContains('worker: saveRepos function',       src, 'async function saveRepos');
  assertContains('worker: /api/repos route',         src, "'/api/repos'");
  assertContains('worker: /api/stats route',         src, "'/api/stats'");
  assertContains('worker: /api/crawl route',         src, "'/api/crawl'");
  assertContains('worker: D1 batch insert',          src, 'db.batch');
  assertContains('worker: cron comment 20:00 UTC',   src, '20:00 UTC');
  assertContains('worker: todayCST function',        src, 'function todayCST');
  assertContains('worker: CST offset +8h',           src, '8 * 3600_000');
  assertContains('worker: analytics snippet const',  src, 'const ANALYTICS_HEAD_SNIPPET');
  assertContains('worker: Adsense account meta',     src, 'ca-pub-0790471852661955');
  assertContains('worker: gtag id',                  src, 'G-RJDEV8XM5Y');
  assertContains('worker: html helper supports status', src, 'function html(content, status = 200)');
  assertContains('worker: trending parser',          src, 'function parseTrendingRepoNames');
  assertContains('worker: daily fetch uses potential pool', src, "fn: () => fetchPotentialDailyRepos");
  assertContains('worker: potential daily scorer',   src, 'function scorePotentialDailyRepo');
  assertContains('worker: potential daily comparator', src, 'function comparePotentialDailyRepo');
  assertContains('worker: increment uses history table', src, 'LEFT JOIN repo_stars_history h');
}

// ── Suite 4b: 日期筛选 Bug 修复验证 ─────────────────────────────────
console.log(YELLOW('\nSuite 4b: Date Filter Bug Fix Validation'));

{
  const src = readFileSync(path.join(__dirname, '../src/worker.js'), 'utf8');

  // 提取 filter-bar 表单代码块（从 filter-bar 到 </form>）
  const formMatch = src.match(/<form class="filter-bar"[\s\S]*?<\/form>/);
  assert('filter-bar form exists in source', !!formMatch);

  if (formMatch) {
    const formHtml = formMatch[0];

    // 统计 name="date" 出现次数，应恰好只有 1 次（select，无 hidden input）
    const dateNameCount = (formHtml.match(/name="date"/g) || []).length;
    assertEqual('form has exactly 1 name="date" field (no duplicate)', dateNameCount, 1);

    // 不应包含 hidden date input
    assert('no hidden date input in form',
      !formHtml.includes('type="hidden"') || !formHtml.includes('name="date"') ||
      // 更精确：hidden input 里不含 name="date"
      !/<input[^>]*type="hidden"[^>]*name="date"/.test(formHtml) &&
      !/<input[^>]*name="date"[^>]*type="hidden"/.test(formHtml)
    );

    // select name="date" 存在
    assert('select[name="date"] exists in form', /<select[^>]*name="date"/.test(formHtml));
  }
}

// ── Suite 6: 增量计算功能测试 ───────────────────────────────────────
console.log(YELLOW('\nSuite 6: Star Increment Calculation'));

{
  assertEqual('getHistoryDate: 2026-03-28 - 1 day', getHistoryDate('2026-03-28', 1), '2026-03-27');
  assertEqual('getHistoryDate: 2026-03-28 - 7 days', getHistoryDate('2026-03-28', 7), '2026-03-21');
  assertEqual('getHistoryDate: 2026-03-28 - 30 days', getHistoryDate('2026-03-28', 30), '2026-02-26');
}

{
  const db = new MockD1();
  await db.prepare('INSERT INTO repo_stars_history (full_name, crawl_date, stars, forks) VALUES (?, ?, ?, ?)')
    .bind('owner/repo-a', '2026-03-27', 1000, 100).run();
  await db.prepare('INSERT INTO repo_stars_history (full_name, crawl_date, stars, forks) VALUES (?, ?, ?, ?)')
    .bind('owner/repo-b', '2026-03-27', 500, 50).run();
  
  const h1 = await db.prepare('SELECT stars, forks FROM repo_stars_history WHERE full_name = ? AND crawl_date = ?')
    .bind('owner/repo-a', '2026-03-27').first();
  assertEqual('history query: repo-a stars', h1.stars, 1000);
  assertEqual('history query: repo-a forks', h1.forks, 100);
  
  const h2 = await db.prepare('SELECT stars, forks FROM repo_stars_history WHERE full_name = ? AND crawl_date = ?')
    .bind('owner/repo-c', '2026-03-27').first();
  assert('history query: non-existent returns null', h2 === null);
}

{
  const db = new MockD1();
  db._history.push({ id: 1, full_name: 'owner/repo-a', crawl_date: '2026-03-27', stars: 1000, forks: 100 });
  db._history.push({ id: 2, full_name: 'owner/repo-b', crawl_date: '2026-03-27', stars: 800, forks: 80 });
  db._history.push({ id: 3, full_name: 'owner/repo-c', crawl_date: '2026-03-27', stars: 500, forks: 50 });
  
  const repos = [
    { full_name: 'owner/repo-a', stars: 1200, forks: 150, category: 'star_daily', rank: 1 },
    { full_name: 'owner/repo-b', stars: 850, forks: 90, category: 'star_daily', rank: 2 },
    { full_name: 'owner/repo-c', stars: 600, forks: 60, category: 'star_daily', rank: 3 },
    { full_name: 'owner/repo-d', stars: 300, forks: 30, category: 'star_daily', rank: 4 },
  ];
  
  const historyDate = '2026-03-27';
  const withHistory = repos.map(r => {
    const h = db._history.find(h => h.full_name === r.full_name && h.crawl_date === historyDate);
    return {
      ...r,
      stars_incr: h ? r.stars - h.stars : r.stars,
      forks_incr: h ? r.forks - h.forks : r.forks,
    };
  });
  
  withHistory.sort((a, b) => b.stars_incr - a.stars_incr);
  
  assertEqual('increment: repo-d (new, no history) = 300', withHistory[0].stars_incr, 300);
  assertEqual('increment: repo-a +200', withHistory[1].stars_incr, 200);
  assertEqual('increment: repo-c +100', withHistory[2].stars_incr, 100);
  assertEqual('increment: repo-b +50', withHistory[3].stars_incr, 50);
  assertEqual('sorted: first is repo-d (highest - new repo)', withHistory[0].full_name, 'owner/repo-d');
}

{
  const src = readFileSync(path.join(__dirname, '../src/worker.js'), 'utf8');
  assertContains('worker: repo_stars_history table', src, 'repo_stars_history');
  assertContains('worker: saveStarsHistory function', src, 'async function saveStarsHistory');
  assertContains('worker: stars_incr calculation', src, 'stars_incr');
  assertContains('worker: incr-pos CSS class', src, 'incr-pos');
  assertContains('worker: incr-neg CSS class', src, 'incr-neg');
}

{
  const sql = readFileSync(path.join(__dirname, '../migrations/0002_add_history.sql'), 'utf8');
  assertContains('migration 2: repo_stars_history table', sql, 'CREATE TABLE IF NOT EXISTS repo_stars_history');
  assertContains('migration 2: UNIQUE constraint', sql, 'UNIQUE(full_name, crawl_date)');
  assertContains('migration 2: stars column', sql, 'stars');
  assertContains('migration 2: forks column', sql, 'forks');
}

// ── Suite 5: GitHub Actions 配置校验 ───────────────────────────────
console.log(YELLOW('\nSuite 5: CI/CD Configuration'));

{
  const yml = readFileSync(path.join(__dirname, '../.github/workflows/deploy.yml'), 'utf8');
  assertContains('CI: triggers on main push',        yml, "branches: [main]");
  assertContains('CI: checkout step',                yml, 'actions/checkout');
  assertContains('CI: setup node step',              yml, 'actions/setup-node');
  assertContains('CI: validate shared deploy script', yml, 'bash deploy.sh --validate');
  assertContains('CI: run shared deploy script',     yml, 'bash deploy.sh');
  assertContains('CI: uses CF API token secret',     yml, 'CLOUDFLARE_API_TOKEN');
  assertContains('CI: uses CF account ID secret',    yml, 'CLOUDFLARE_ACCOUNT_ID');
  assertContains('CI: patches D1 database id',       yml, 'CLOUDFLARE_D1_DATABASE_ID');

  const deployScript = readFileSync(path.join(__dirname, '../deploy.sh'), 'utf8');
  assertContains('CI: deploy script sets migrations_dir', deployScript, 'migrations_dir =');
  assertContains('CI: deploy script rewrites worker entry path', deployScript, 'main = \\"" worker_main "\\"');
  assertContains('CI: deploy script validates migrations dir', deployScript, '[ -d "${SCRIPT_DIR}/migrations" ]');
  assertContains('CI: deploy script validates worker entry exists', deployScript, '[ -f "${SCRIPT_DIR}/src/worker.js" ]');
  assertContains('CI: deploy script injects migrations after database_id', deployScript, 'if ($0 ~ /database_id');
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log('\n' + BOLD('========================================'));
console.log(`  ${GREEN(`✓ ${passed} passed`)}  ${failed > 0 ? RED(`✗ ${failed} failed`) : GREEN('all passed')}`);
console.log(BOLD('========================================\n'));

if (failed > 0) process.exit(1);
