-- D1 Migration: 0002_add_history.sql
-- 添加历史Star数据表，用于计算增量

CREATE TABLE IF NOT EXISTS repo_stars_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT NOT NULL,
  crawl_date  TEXT NOT NULL,
  stars       INTEGER DEFAULT 0,
  forks       INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(full_name, crawl_date)
);

CREATE INDEX IF NOT EXISTS idx_history_date ON repo_stars_history(crawl_date);
CREATE INDEX IF NOT EXISTS idx_history_name ON repo_stars_history(full_name);
