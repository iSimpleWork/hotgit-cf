-- D1 Migration: 0006_add_project_insight_updated_at.sql
-- 记录项目观察总结的生成时间，用于在仓库代码更新后重新补全。

ALTER TABLE repos ADD COLUMN project_insight_updated_at TEXT DEFAULT '';
