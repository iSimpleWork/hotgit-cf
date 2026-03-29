-- D1 Migration: 0003_add_translation_fields.sql
-- 在 repos 表增加翻译字段

ALTER TABLE repos ADD COLUMN translated_name TEXT DEFAULT '';
ALTER TABLE repos ADD COLUMN translated_desc TEXT DEFAULT '';
