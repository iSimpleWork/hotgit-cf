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
    project_insight: repo.project_insight || '',
    project_insight_updated_at: repo.project_insight_updated_at || '',
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

function trimInsight(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
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

function nowCSTDateTime() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
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
        stars:p[7], forks:p[8], open_issues:p[9], pushed_at:p[10], topics:p[11], homepage:p[12],
        translated_name:p[13] || '', translated_desc:p[14] || '', project_insight:p[15] || '',
        project_insight_updated_at:p[16] || '' });
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
      if (/JOIN \(/i.test(sql)) {
        const latestByCategory = {};
        for (const r of db._repos) {
          if (!latestByCategory[r.category] || r.crawl_date > latestByCategory[r.category]) {
            latestByCategory[r.category] = r.crawl_date;
          }
        }
        const bycat = {};
        db._repos.forEach(r => {
          if (r.crawl_date === latestByCategory[r.category]) bycat[r.category] = (bycat[r.category] || 0) + 1;
        });
        return { results:Object.entries(bycat).map(([category,cnt])=>({category,cnt})), success:true };
      }
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
    if (/LEFT JOIN repo_stars_history/i.test(sql)) {
      const historyDate = p[0];
      const filtered = this._filter(p.slice(1)).sort((a, b) => a.rank - b.rank);
      const results = filtered.map(r => {
        const h = db._history.find(h => h.full_name === r.full_name && h.crawl_date === historyDate);
        return {
          ...r,
          history_stars: h ? h.stars : null,
          history_forks: h ? h.forks : null,
        };
      });
      return { results, success: true };
    }
    if (/^UPDATE repos\s+SET project_insight/i.test(sql)) {
      db._repos = db._repos.map(r => r.full_name === p[2]
        ? { ...r, project_insight: p[0] || '', project_insight_updated_at: p[1] || '' }
        : r);
      return { results:[], success:true };
    }
    if (/SELECT \*,\s+CASE/i.test(sql)) {
      const latestByName = new Map();
      for (const r of db._repos) {
        const existing = latestByName.get(r.full_name);
        if (!existing || r.id > existing.id) latestByName.set(r.full_name, r);
      }
      const results = [...latestByName.values()]
        .filter(r => !r.project_insight || !r.project_insight_updated_at || (r.pushed_at && r.pushed_at > r.project_insight_updated_at))
        .sort((a, b) => {
          const missingA = !a.project_insight ? 0 : 1;
          const missingB = !b.project_insight ? 0 : 1;
          if (missingA !== missingB) return missingA - missingB;
          return String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')) || b.stars - a.stars;
        })
        .slice(0, p[0])
        .map(r => ({
          ...r,
          __insightReason: !r.project_insight
            ? '缺少项目观察'
            : !r.project_insight_updated_at
              ? '缺少生成时间'
              : '仓库更新后重新生成'
        }));
      return { results, success:true };
    }
    if (/SELECT \* FROM repos/i.test(sql)) {
      const filtered = this._filter(p).sort((a,b)=>a.rank-b.rank);
      return { results: filtered, success:true };
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
    db.prepare(`INSERT INTO repos (crawl_date,category,rank,full_name,html_url,description,language,stars,forks,open_issues,pushed_at,topics,homepage,translated_name,translated_desc,project_insight,project_insight_updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(crawlDate, r.category, r.rank, r.full_name, r.html_url, r.description, r.language, r.stars, r.forks, r.open_issues, r.pushed_at, r.topics, r.homepage, r.translated_name || '', r.translated_desc || '', r.project_insight || '', r.project_insight_updated_at || '')
  );
  await db.batch(stmts);
}

async function saveStarsHistory(db, repos, crawlDate) {
  if (!repos.length) return;
  const stmts = repos.map(r =>
    db.prepare(`
      INSERT INTO repo_stars_history (full_name, crawl_date, stars, forks)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(full_name, crawl_date) DO UPDATE SET stars = excluded.stars, forks = excluded.forks
    `).bind(r.full_name, crawlDate, r.stars, r.forks ?? 0)
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
  const isDaily = category === 'star_daily';
  const isWeekly = category === 'star_weekly';
  const isMonthly = category === 'star_monthly';
  const isIncrement = isDaily || isWeekly || isMonthly;
  let historyDate = null;
  if (isDaily) historyDate = getHistoryDate(crawlDate, 1);
  else if (isWeekly) historyDate = getHistoryDate(crawlDate, 7);
  else if (isMonthly) historyDate = getHistoryDate(crawlDate, 30);

  const conditions = ['repos.crawl_date = ?', 'repos.category = ?'];
  const params = [crawlDate, category];
  if (lang)   { conditions.push('repos.language = ?'); params.push(lang); }
  if (search) { conditions.push('(repos.full_name LIKE ? OR repos.description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
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
    rows = await db.prepare(`SELECT * FROM repos WHERE ${where}`).bind(...params).all();
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
        data.sort((a, b) => (b.stars_incr ?? -Infinity) - (a.stars_incr ?? -Infinity));
      } else {
        data.sort((a, b) => b.stars - a.stars);
      }
      data = data.map((r, i) => ({ ...r, rank: i + 1 }));
    }
  } else {
    data.sort((a, b) => a.rank - b.rank);
  }

  const total = data.length;
  const offset = (page - 1) * perPage;
  return { total, page, per_page: perPage, data: data.slice(offset, offset + perPage) };
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
      hasDailyHistory: true,
      trendingRank: null,
    },
    {
      repo: { full_name: 'a/trending-lower', stargazers_count: 5000 },
      sources: new Set(['trending']),
      dailyGain: 200,
      weeklyGain: 300,
      score: 1200,
      hasDailyHistory: true,
      trendingRank: 2,
    },
    {
      repo: { full_name: 'c/trending-higher-stars', stargazers_count: 6000 },
      sources: new Set(['trending']),
      dailyGain: 200,
      weeklyGain: 250,
      score: 1100,
      hasDailyHistory: true,
      trendingRank: 1,
    },
  ];
  items.sort(comparePotentialDailyRepo);
  assertEqual('comparePotentialDailyRepo: trending group comes first', items[0].repo.full_name, 'c/trending-higher-stars');
  assertEqual('comparePotentialDailyRepo: trending tie breaks by stars', items[1].repo.full_name, 'a/trending-lower');
  assertEqual('comparePotentialDailyRepo: non-trending comes after trending', items[2].repo.full_name, 'b/non-trending-high');
}

{
  const items = [
    {
      repo: { full_name: 'b/trending-second', stargazers_count: 99999 },
      sources: new Set(['trending']),
      dailyGain: 0,
      weeklyGain: 0,
      score: 500,
      hasDailyHistory: false,
      trendingRank: 2,
    },
    {
      repo: { full_name: 'a/trending-first', stargazers_count: 1000 },
      sources: new Set(['trending']),
      dailyGain: 0,
      weeklyGain: 0,
      score: 300,
      hasDailyHistory: false,
      trendingRank: 1,
    },
  ];
  items.sort(comparePotentialDailyRepo);
  assertEqual('comparePotentialDailyRepo: trending fallback keeps original order when daily history is missing', items[0].repo.full_name, 'a/trending-first');
}

assertEqual('escHtml: & → &amp;',      escHtml('a & b'),   'a &amp; b');
assertEqual('escHtml: < → &lt;',       escHtml('<script>'), '&lt;script&gt;');
assertEqual('escHtml: " → &quot;',     escHtml('"x"'),      '&quot;x&quot;');
assertEqual('escHtml: null → ""',      escHtml(null),       '');
assertEqual('escHtml: empty → ""',     escHtml(''),         '');

assertEqual('fmtNum: 1000 → 1,000',    fmtNum(1000),   '1,000');
assertEqual('fmtNum: 0 → 0',           fmtNum(0),      '0');
assertEqual('fmtNum: 1500000',         fmtNum(1500000), '1,500,000');

{
  const insight = buildProjectInsight(
    {
      full_name: 'openai/example-agent',
      description: 'AI agent framework for building LLM apps',
      language: 'TypeScript',
      stars: 12345,
      forks: 678,
      pushed_at: '2026-05-21 10:00:00',
      topics: 'ai,llm,agent,developer-tools',
    },
    [
      { crawl_date: '2026-05-20', stars: 12000 },
      { crawl_date: '2026-05-21', stars: 12345 },
    ],
    'README shows agent orchestration, LLM workflows and developer automation.',
    'Build production AI agents faster.'
  );
  assert('project insight: long complete content', insight.length >= 300, `length=${insight.length}`);
  assertContains('project insight: mentions audience', insight, '适合');
  assertContains('project insight: mentions recent heat', insight, '最近热度');
  assertContains('project insight: uses daily gain', insight, '345');
  assertContains('project insight: mentions README', insight, 'README');
  assertContains('project insight: mentions adoption checks', insight, '许可证');
  assertContains('project insight: keeps complete ending', insight, '对比同类方案');
}

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

{
  const db = new MockD1();
  const baseRepo = {
    rank: 1,
    full_name: 'openclaw/openclaw',
    html_url: 'https://github.com/openclaw/openclaw',
    description: 'Your own personal AI assistant',
    language: 'TypeScript',
    stars: 1000,
    forks: 100,
    open_issues: 1,
    pushed_at: '2026-04-12 10:00:00',
    topics: 'ai,assistant',
    homepage: 'https://openclaw.ai',
  };

  await saveRepos(db, [{ ...baseRepo, category: 'star_weekly' }], '2026-04-12');
  await saveRepos(db, [{ ...baseRepo, category: 'star_monthly' }], '2026-04-12');

  const weeklySearch = await queryRepos(db, { category:'star_weekly', crawlDate:'2026-04-12', page:1, perPage:10, lang:'', search:'openclaw' });
  assertEqual('weekly search: finds openclaw', weeklySearch.total, 1);

  const monthlySearch = await queryRepos(db, { category:'star_monthly', crawlDate:'2026-04-12', page:1, perPage:10, lang:'', search:'openclaw' });
  assertEqual('monthly search: finds openclaw', monthlySearch.total, 1);

  const weeklyLang = await queryRepos(db, { category:'star_weekly', crawlDate:'2026-04-12', page:1, perPage:10, lang:'TypeScript', search:'' });
  assertEqual('weekly language filter: finds TypeScript repo', weeklyLang.total, 1);
}

{
  const db = new MockD1();
  await saveRepos(db, [
    {
      category: 'star_daily',
      rank: 1,
      full_name: 'trend/first',
      html_url: 'https://github.com/trend/first',
      description: 'first trending repo',
      language: 'TypeScript',
      stars: 200,
      forks: 20,
      open_issues: 1,
      pushed_at: '2026-04-13 10:00:00',
      topics: '',
      homepage: '',
    },
    {
      category: 'star_daily',
      rank: 2,
      full_name: 'trend/second',
      html_url: 'https://github.com/trend/second',
      description: 'second trending repo',
      language: 'Python',
      stars: 500,
      forks: 50,
      open_issues: 1,
      pushed_at: '2026-04-13 10:00:00',
      topics: '',
      homepage: '',
    },
  ], '2026-04-13');
  await saveStarsHistory(db, [
    { full_name: 'trend/first', stars: 100, forks: 10 },
    { full_name: 'trend/second', stars: 100, forks: 10 },
  ], '2026-04-12');

  const dailyResult = await queryRepos(db, { category:'star_daily', crawlDate:'2026-04-13', page:1, perPage:10, lang:'', search:'' });
  assertEqual('daily ranking: preserves stored rank order', dailyResult.data[0].full_name, 'trend/first');
  assertEqual('daily ranking: still computes stars increment', dailyResult.data[0].stars_incr, 100);
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
  const promoAsset = readFileSync(path.join(__dirname, '../src/wechat-promo.js'), 'utf8');
  assertContains('worker: export default',           src, 'export default');
  assertContains('worker: scheduled handler',        src, 'async scheduled');
  assertContains('worker: fetch handler',            src, 'async fetch');
  assertContains('worker: runCrawl function',        src, 'async function runCrawl');
  assertContains('worker: fetchAll function',        src, 'async function fetchAll');
  assertContains('worker: saveRepos function',       src, 'async function saveRepos');
  assertContains('worker: /api/repos route',         src, "'/api/repos'");
  assertContains('worker: /api/stats route',         src, "'/api/stats'");
  assertContains('worker: /api/crawl route',         src, "'/api/crawl'");
  assertContains('worker: about route',              src, "'/about'");
  assertContains('worker: backfill route',           src, "'/backfillinsights'");
  assertContains('worker: D1 batch insert',          src, 'db.batch');
  assertContains('worker: cron comment 20:00 UTC',   src, '20:00 UTC');
  assertContains('worker: todayCST function',        src, 'function todayCST');
  assertContains('worker: CST offset +8h',           src, '8 * 3600_000');
  assertContains('worker: category latest date support', src, 'SELECT MAX(crawl_date) AS d FROM repos WHERE category = ?');
  assertContains('worker: stats use per-category latest', src, 'SELECT category, MAX(crawl_date) AS crawl_date');
  assertContains('worker: api repos uses category date', src, "const crawlDate = q.get('date')   || await getLatestDate(env.DB, category)");
  assertContains('worker: repos page uses category date', src, "await getLatestDate(env.DB, category)");
  assertContains('worker: category dates support', src, 'SELECT DISTINCT crawl_date FROM repos WHERE category = ?');
  assertContains('worker: tabs do not pin unavailable date', src, 'routePath(`/repos?category=${cat}`, langPrefix)');
  assertContains('worker: locale config',             src, "const LOCALES");
  assertContains('worker: zh locale prefix',          src, "prefix: '/zh-CN'");
  assertContains('worker: en locale prefix',          src, "prefix: '/en'");
  assertContains('worker: locale cookie',             src, 'hotgit_locale');
  assertContains('worker: locale path parser',        src, 'function parseLocalizedPath');
  assertContains('worker: preferred locale redirect', src, 'redirectToLocale');
  assertContains('worker: language switcher',         src, 'class="lang-switch"');
  assertContains('worker: hreflang alternates',       src, 'rel="alternate" hreflang=');
  assertContains('worker: analytics snippet const',  src, 'const ANALYTICS_HEAD_SNIPPET');
  assertContains('worker: Adsense account meta',     src, 'ca-pub-0790471852661955');
  assertContains('worker: gtag id',                  src, 'G-RJDEV8XM5Y');
  assertContains('worker: html helper supports status', src, 'function html(content, status = 200)');
  assertContains('worker: base layout meta description', src, '<meta name="description"');
  assertContains('worker: canonical links',          src, 'rel="canonical"');
  assertContains('worker: json ld helper',           src, 'function jsonLdScript');
  assertContains('worker: wechat promo static route', src, "'/static/img/wechat-promo.png'");
  assertContains('worker: wechat promo asset module import', src, "from './wechat-promo.js'");
  assertContains('worker: wechat promo asset export', promoAsset, 'export const WECHAT_PROMO_PNG_BASE64');
  assertContains('worker: wechat promo copy',        src, '第一时间发现热门开源项目');
  assertContains('worker: wechat promo table layout', src, 'class="wechat-promo-table"');
  assertContains('worker: wechat promo media cell',   src, 'class="wechat-promo-media"');
  assertContains('worker: wechat promo fixed image height', src, 'width:auto;height:132px;max-width:none');
  assertContains('worker: github readme fetcher',    src, 'async function githubReadmeText');
  assertContains('worker: homepage meta fetcher',    src, 'async function fetchHomepageMeta');
  assertContains('worker: project insight enrichment', src, 'async function enrichProjectInsights');
  assertContains('worker: project insight saved field', src, 'project_insight');
  assertContains('worker: project insight updated field', src, 'project_insight_updated_at');
  assertContains('worker: project insight no truncation', src, "return String(text || '').replace(/\\s+/g, ' ').trim()");
  assertContains('worker: stale insight pending query', src, "pushed_at > COALESCE(project_insight_updated_at, '')");
  assertContains('worker: backfill missing query',   src, 'async function getReposMissingProjectInsights');
  assertContains('worker: backfill pending query',   src, 'async function getReposPendingProjectInsights');
  assertContains('worker: backfill update query',    src, 'async function updateRepoProjectInsight');
  assertContains('worker: backfill page',            src, 'async function pageBackfillInsights');
  assertContains('worker: detail uses saved insight', src, "repo.project_insight || buildProjectInsight(repo, history, '', '')");
  assertContains('worker: detail meta uses insight', src, 'metaDescriptionFromInsight');
  assertContains('worker: detail jsonld abstract',   src, 'abstract: projectInsight');
  assertContains('worker: repo field translation reader', src, 'async function getRepoFieldTranslation');
  assertContains('worker: repo field translation writer', src, 'async function saveRepoFieldTranslation');
  assertContains('worker: localized repo content',   src, 'async function getLocalizedRepoContent');
  assertContains('worker: repo translation keyed by field', src, 'repo_id = ? AND field_name = ? AND target_lang = ?');
  assertContains('worker: list uses localized repo content', src, "getLocalizedRepoContent(env.DB, repo, locale, ['name', 'description'])");
  assertContains('worker: about page',               src, 'async function pageAbout');
  assertContains('worker: about jsonld',             src, "'@type': 'AboutPage'");
  assertContains('worker: about faq jsonld',         src, "'@type': 'FAQPage'");
  assertContains('worker: about llms link',          src, "routePath('/llms.txt', langPrefix)");
  assertContains('worker: llms route',               src, "'/llms.txt'");
  assertContains('worker: llms page',                src, 'function pageLlmsTxt');
  assertContains('worker: project insight builder',  src, 'function buildProjectInsight');
  assertContains('worker: project insight section',  src, 'class="project-insight"');
  assertContains('worker: project insight heading',  src, '为什么值得关注');
  assertContains('worker: sitemap repo metadata query', src, 'async function getSitemapRepos');
  assertContains('worker: sitemap repo-level lastmod', src, 'sitemapRepo.lastmod || latestDate');
  assertContains('worker: topic related query',      src, 'async function getTopicRelatedRepos');
  assertContains('worker: topic related section',    src, '同主题相关项目');
  assertContains('worker: related reader intro',     src, '实现思路、社区热度和近期增长表现');
  assertContains('worker: r id canonical redirect',  src, 'Response.redirect');
  assertContains('worker: robots disallows api',     src, 'Disallow: /api/');
  assertContains('worker: robots disallows backfill', src, 'Disallow: /backfillinsights');
  assertContains('worker: sitemap includes about',   src, '`${host}/about`');
  assertContains('worker: sitemap includes zh about', src, '`${host}${prefix}/about`');
  assertContains('worker: robots includes zh sitemap', src, 'Sitemap: https://${domain}/zh-CN/sitemap.xml');
  assertContains('worker: robots includes en sitemap', src, 'Sitemap: https://${domain}/en/sitemap.xml');
  assertContains('worker: sitemap lastmod',          src, '<lastmod>');
  assertContains('worker: trending parser',          src, 'function parseTrendingRepoNames');
  assertContains('worker: daily fetch uses potential pool', src, "fn: () => fetchPotentialDailyRepos");
  assertContains('worker: forceupdate prioritizes daily', src, "name: 'star_daily',   label: CATEGORY_LABELS.star_daily");
  assertContains('worker: forceupdate avoids insight batch', src, '手动更新优先保证增量榜可用');
  assertContains('worker: scheduled crawl prioritizes daily', src, "name: 'star_daily',   fn: () => dailyHistoryPool.slice(0, 100)");
  assertContains('worker: scheduled crawl avoids insight batch', src, '定时任务优先保证榜单数据落库');
  assertContains('worker: potential daily scorer',   src, 'function scorePotentialDailyRepo');
  assertContains('worker: potential daily comparator', src, 'function comparePotentialDailyRepo');
  assertContains('worker: increment uses history table', src, 'LEFT JOIN repo_stars_history h');
  assertContains('worker: daily pool supports custom limit', src, 'fetchPotentialDailyRepos(db, githubToken, limit = 100)');
  assertContains('worker: runCrawl expands daily history pool to 300', src, 'fetchPotentialDailyRepos(env.DB, githubToken, 300)');
  assertContains('worker: trending rank metadata', src, '__trendingRank');
  assertContains('worker: search qualifies joined full_name', src, 'repos.full_name LIKE ?');
  assertContains('worker: search qualifies joined description', src, 'repos.description LIKE ?');
  assertContains('worker: language filter qualifies repos table', src, 'repos.language = ?');
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

{
  const sql = readFileSync(path.join(__dirname, '../migrations/0005_add_project_insight.sql'), 'utf8');
  assertContains('migration 5: project_insight column', sql, 'project_insight');
  assertContains('migration 5: alter repos table', sql, 'ALTER TABLE repos');
}

{
  const sql = readFileSync(path.join(__dirname, '../migrations/0006_add_project_insight_updated_at.sql'), 'utf8');
  assertContains('migration 6: project_insight_updated_at column', sql, 'project_insight_updated_at');
  assertContains('migration 6: alter repos table', sql, 'ALTER TABLE repos');
}

{
  const sql = readFileSync(path.join(__dirname, '../migrations/0007_extend_translations_for_repo_fields.sql'), 'utf8');
  assertContains('migration 7: repo_id column', sql, 'repo_id INTEGER');
  assertContains('migration 7: field_name column', sql, 'field_name TEXT');
  assertContains('migration 7: source_lang column', sql, 'source_lang TEXT');
  assertContains('migration 7: source_text column', sql, 'source_text TEXT');
  assertContains('migration 7: repo field language index', sql, 'idx_translations_repo_field_lang');
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
  assertContains('CI: passes GitHub PAT secret to deploy script', yml, 'HOTGIT_GH_PAT');

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
