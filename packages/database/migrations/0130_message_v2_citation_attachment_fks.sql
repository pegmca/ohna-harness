-- 阶段 5 RAG 回迁：citation 与附件绑定都关联到新 messages_v2 表，
-- 旧 messages 表仅保留历史兼容，不再由新 agent loop 写入。
--
-- 安全说明：先清理/解除指向旧 messages 的孤儿行，避免 ADD CONSTRAINT 在已有 dev 数据上失败。
-- 这些孤儿行来自旧 run-service 路径，已无法通过新 loop 读取，清理属于一次性 schema 收敛。

-- 1. 解除 chat_attachment_uploads 中指向不存在 messages_v2 的绑定（保留附件本身）。
UPDATE chat_attachment_uploads
   SET bound_message_id = null, updated_at = now()
 WHERE bound_message_id IS NOT NULL
   AND NOT EXISTS (select 1 from messages_v2 where id = chat_attachment_uploads.bound_message_id);

-- 2. 删除 message_citations 中指向不存在 messages_v2 的引用（citation 失去回链目标后不可解释）。
DELETE FROM message_citations
 WHERE NOT EXISTS (select 1 from messages_v2 where id = message_citations.message_id);

-- 3. 删除 message_attachments 中指向不存在 messages_v2 的记录。
DELETE FROM message_attachments
 WHERE NOT EXISTS (select 1 from messages_v2 where id = message_attachments.message_id);

ALTER TABLE chat_attachment_uploads
  DROP CONSTRAINT IF EXISTS chat_attachment_uploads_bound_message_id_fkey;

ALTER TABLE chat_attachment_uploads
  ADD CONSTRAINT chat_attachment_uploads_bound_message_id_fkey
  FOREIGN KEY (bound_message_id) REFERENCES messages_v2(id) ON DELETE RESTRICT;

ALTER TABLE message_citations
  DROP CONSTRAINT IF EXISTS message_citations_message_id_fkey;

ALTER TABLE message_citations
  ADD CONSTRAINT message_citations_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages_v2(id) ON DELETE CASCADE;

ALTER TABLE message_attachments
  DROP CONSTRAINT IF EXISTS message_attachments_message_id_fkey;

ALTER TABLE message_attachments
  ADD CONSTRAINT message_attachments_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages_v2(id) ON DELETE CASCADE;
