-- 阶段 6 后续修正：确保 run_events / runs 指向 conversations 的外键已被删除。
-- 0190/0200 的约束名与重命名后的实际约束名（仍带 _v2 后缀）不一致，导致部分环境 FK 残留。
-- 本 migration 同时 drop 两种可能的名字，幂等安全。
alter table if exists run_events drop constraint if exists run_events_conversation_id_fkey;
alter table if exists run_events drop constraint if exists run_events_v2_conversation_id_fkey;

alter table if exists runs drop constraint if exists runs_conversation_id_fkey;
alter table if exists runs drop constraint if exists runs_v2_conversation_id_fkey;
