-- 阶段 6 补充：删除 runs.conversation_id 外键，避免 appendEvent 与 persistMessage 并发死锁。
--
-- 死锁场景：
-- - persistMessage 事务先锁 conversations for update，再插入 messages；messages.run_id 外键到 runs，
--   因此需要 runs 的 KEY SHARE 锁。
-- - appendEvent 事务先锁 runs for update，再更新 runs 推进 last_event_sequence；runs.conversation_id
--   外键到 conversations，因此需要 conversations 的 KEY SHARE 锁。
-- 两者并发时形成循环等待。
--
-- 删除 runs.conversation_id_fkey 后，appendEvent 更新 runs 不再请求 conversations 锁，循环打破。
-- conversation_id 仍保留用于查询；级联删除语义由 run_events.run_id -> runs.id 的 cascade 保证，
-- 会话删除时由应用层先删 runs（或依赖 PostgreSQL 在删除 conversations 时检查无 FK 引用）。
alter table if exists runs drop constraint if exists runs_conversation_id_fkey;
alter table if exists runs drop constraint if exists runs_v2_conversation_id_fkey;

comment on column runs.conversation_id is 'Run 所属会话标识（查询冗余，不建 FK 以避免与消息持久化事务死锁）';
