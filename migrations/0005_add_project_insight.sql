-- D1 Migration: 0005_add_project_insight.sql
-- 为详情页保存爬取阶段生成的项目观察总结

ALTER TABLE repos ADD COLUMN project_insight TEXT DEFAULT '';
