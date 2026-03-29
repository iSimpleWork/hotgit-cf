-- D1 Migration: 0004_add_translations_cache.sql
-- 翻译缓存表

CREATE TABLE IF NOT EXISTS translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_hash TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(text_hash, target_lang)
);
CREATE INDEX IF NOT EXISTS idx_translations_hash_lang ON translations(text_hash, target_lang);
