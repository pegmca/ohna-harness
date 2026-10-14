-- 阶段 P1：聊天附件改为"会话级临时"数据，原文与索引都放 Redis（带 TTL），不落主库。
-- 关键前提：document_versions.content 是 text NOT NULL，写 documents 行等于把附件正文存进
-- Postgres，与"附件不落主库"冲突。故附件不再建 documents/document_versions/chunks 行；
-- chat_attachment_uploads.document_id 解除对 documents 的外键，改存 Redis 附件文档的逻辑 uuid，
-- 并新增 conversation_id 记录归属会话（用于按会话检索与回收 Redis 临时索引）。
-- findByDocumentId / bindMessageByDocumentId / run 归属校验语义不变：仍按该 id 查本表。

ALTER TABLE IF EXISTS chat_attachment_uploads
  DROP CONSTRAINT IF EXISTS chat_attachment_uploads_document_id_fkey;

ALTER TABLE IF EXISTS chat_attachment_uploads
  ADD COLUMN IF NOT EXISTS conversation_id uuid;

COMMENT ON COLUMN chat_attachment_uploads.document_id IS
  'Redis 会话级临时附件文档的逻辑 uuid；不再外键引用 documents，正文与索引都在 Redis，主库只保留最小上传元数据（幂等/审计/绑定）';

COMMENT ON COLUMN chat_attachment_uploads.conversation_id IS
  '附件归属的会话标识，用于按会话检索附件与回收 Redis 临时索引';

CREATE INDEX IF NOT EXISTS chat_attachment_uploads_conversation_idx
  ON chat_attachment_uploads(conversation_id, uploaded_at, id);
