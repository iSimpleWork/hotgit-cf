-- D1 Migration: 0007_extend_translations_for_repo_fields.sql
-- 扩展翻译缓存表：支持按项目、字段、语言保存页面内容翻译。
-- 保留 0004 的 text_hash/target_lang/translated_text 结构，避免影响现有爬取阶段翻译缓存逻辑。

ALTER TABLE translations ADD COLUMN repo_id INTEGER;
ALTER TABLE translations ADD COLUMN full_name TEXT DEFAULT '';
ALTER TABLE translations ADD COLUMN field_name TEXT DEFAULT '';
ALTER TABLE translations ADD COLUMN source_lang TEXT DEFAULT '';
ALTER TABLE translations ADD COLUMN source_text TEXT DEFAULT '';
ALTER TABLE translations ADD COLUMN updated_at TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_translations_repo_field_lang
  ON translations(repo_id, field_name, target_lang);

CREATE INDEX IF NOT EXISTS idx_translations_full_name_field_lang
  ON translations(full_name, field_name, target_lang);
