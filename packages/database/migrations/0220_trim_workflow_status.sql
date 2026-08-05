-- 阶段 6 后续：approval 体系删除后，workflow 状态机不再包含 paused/approved/rejected。
-- 在 0070_report.sql 保持原文件不变的前提下，用新 migration 收紧 CHECK 约束。

alter table if exists workflow_runs drop constraint if exists workflow_runs_status_check;
alter table if exists workflow_runs add constraint workflow_runs_status_check
  check (status in ('pending','running','succeeded','failed'));

alter table if exists workflow_node_runs drop constraint if exists workflow_node_runs_status_check;
alter table if exists workflow_node_runs add constraint workflow_node_runs_status_check
  check (status in ('pending','running','succeeded','failed','skipped'));
