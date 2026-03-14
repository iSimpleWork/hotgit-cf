-- D1 Migration: 0001_init.sql
-- 初始化 HotGit 数据库表结构

CREATE TABLE IF NOT EXISTS repos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_date  TEXT NOT NULL,
  category    TEXT NOT NULL,
  rank        INTEGER NOT NULL,
  full_name   TEXT NOT NULL,
  html_url    TEXT NOT NULL,
  description TEXT DEFAULT '',
  language    TEXT DEFAULT 'Unknown',
  stars       INTEGER DEFAULT 0,
  forks       INTEGER DEFAULT 0,
  open_issues INTEGER DEFAULT 0,
  pushed_at   TEXT DEFAULT '',
  topics      TEXT DEFAULT '',
  homepage    TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repos_date_cat   ON repos(crawl_date, category);
CREATE INDEX IF NOT EXISTS idx_repos_full_name  ON repos(full_name);
CREATE INDEX IF NOT EXISTS idx_repos_stars      ON repos(stars DESC);
CREATE INDEX IF NOT EXISTS idx_repos_forks      ON repos(forks DESC);

-- 爬取任务日志
CREATE TABLE IF NOT EXISTS crawl_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_date TEXT NOT NULL,
  category   TEXT NOT NULL,
  count      INTEGER DEFAULT 0,
  status     TEXT DEFAULT 'ok',  -- ok | error
  message    TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
