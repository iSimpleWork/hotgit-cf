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

// ════════════════════════════════════════════════════════════════════
// Mock D1 Database（内存实现，满足 Worker 中的 D1 接口）
// ════════════════════════════════════════════════════════════════════

class MockD1 {
  constructor() {
    this._repos    = [];
    this._logs     = [];
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

// ── Suite 5: GitHub Actions 配置校验 ───────────────────────────────
console.log(YELLOW('\nSuite 5: CI/CD Configuration'));

{
  const yml = readFileSync(path.join(__dirname, '../.github/workflows/deploy.yml'), 'utf8');
  assertContains('CI: triggers on main push',        yml, "branches: [main]");
  assertContains('CI: checkout step',                yml, 'actions/checkout');
  assertContains('CI: deploy step (wrangler-action)', yml, 'wrangler-action');
  assertContains('CI: uses CF API token secret',     yml, 'CLOUDFLARE_API_TOKEN');
  assertContains('CI: uses CF account ID secret',    yml, 'CLOUDFLARE_ACCOUNT_ID');
  assertContains('CI: patches D1 database id',       yml, 'CLOUDFLARE_D1_DATABASE_ID');
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log('\n' + BOLD('========================================'));
console.log(`  ${GREEN(`✓ ${passed} passed`)}  ${failed > 0 ? RED(`✗ ${failed} failed`) : GREEN('all passed')}`);
console.log(BOLD('========================================\n'));

if (failed > 0) process.exit(1);
