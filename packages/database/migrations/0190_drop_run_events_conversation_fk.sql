-- 阶段 6 后续：解除 run_events -> conversations 的外键，避免并发 appendEvent 与消息落库死锁。
--
-- 死锁场景（report 多次运行后偶发）：
--   T1(persistMessage): 先锁 conversations FOR UPDATE，再插 messages(run_id FK) 需 runs KEY SHARE。
--   T2(appendEvent):   先锁 runs FOR UPDATE，再插 run_events(conversation_id FK) 需 conversations KEY SHARE。
-- 两者形成循环等待。runs 已靠 runs.conversation_id 保证会话归属级联，run_events.conversation_id
-- 仅作审计/调试冗余，无独立查询索引；删除该 FK 后保留列，不影响查询与级联删除
-- （runs -> run_events on delete cascade 仍在）。
alter table if exists run_events
  drop constraint if exists run_events_conversation_id_fkey;
alter table if exists run_events
  drop constraint if exists run_events_v2_conversation_id_fkey;
