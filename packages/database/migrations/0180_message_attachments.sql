ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_type_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_source_type_check' AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_source_type_check
      CHECK (source_type IN ('local_file', 'remote_url', 'mock_text', 'chat_attachment'));
  END IF;
END
$$;
COMMENT ON COLUMN documents.source_type IS
  '来源类型：local_file 本地文件、remote_url 远程地址、mock_text 演示文本、chat_attachment 聊天附件';

CREATE TABLE IF NOT EXISTS chat_attachment_uploads (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_attachment_id text NOT NULL,
  content_checksum text NOT NULL,
  claim_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  document_id uuid REFERENCES documents(id) ON DELETE RESTRICT,
  bound_message_id uuid REFERENCES messages(id) ON DELETE RESTRICT,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  status text NOT NULL CHECK (status IN ('uploading', 'indexed', 'failed')),
  uploaded_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, client_attachment_id),
  UNIQUE (document_id),
  UNIQUE (bound_message_id, document_id)
);

CREATE INDEX IF NOT EXISTS chat_attachment_uploads_orphan_idx
  ON chat_attachment_uploads(uploaded_at, id)
  WHERE status = 'indexed' AND bound_message_id IS NULL;

CREATE INDEX IF NOT EXISTS chat_attachment_uploads_lease_idx
  ON chat_attachment_uploads(lease_expires_at, id)
  WHERE status = 'uploading';

COMMENT ON COLUMN chat_attachment_uploads.id IS '聊天附件上传记录唯一标识';
COMMENT ON COLUMN chat_attachment_uploads.user_id IS '上传附件所属用户标识';
COMMENT ON COLUMN chat_attachment_uploads.client_attachment_id IS '浏览器生成且在用户范围内幂等的附件标识';
COMMENT ON COLUMN chat_attachment_uploads.content_checksum IS '上传正文的 SHA-256 校验和，用于识别幂等冲突';
COMMENT ON COLUMN chat_attachment_uploads.claim_token IS '当前上传租约令牌，防止过期执行者提交状态';
COMMENT ON COLUMN chat_attachment_uploads.lease_expires_at IS '上传租约到期时间；索引期间定期续租，到期后相同正文可接管';
COMMENT ON COLUMN chat_attachment_uploads.document_id IS '索引成功后关联的私有 RAG 文档标识';
COMMENT ON COLUMN chat_attachment_uploads.bound_message_id IS '首次成功绑定的用户消息标识，空值表示孤儿候选';
COMMENT ON COLUMN chat_attachment_uploads.file_name IS '上传时经清理的展示文件名';
COMMENT ON COLUMN chat_attachment_uploads.content_type IS '上传附件的受支持 MIME 类型';
COMMENT ON COLUMN chat_attachment_uploads.size_bytes IS '经服务端校验的附件字节数';
COMMENT ON COLUMN chat_attachment_uploads.status IS '上传生命周期状态：上传中、已索引或失败';
COMMENT ON COLUMN chat_attachment_uploads.uploaded_at IS '首次创建上传记录的时间';
COMMENT ON COLUMN chat_attachment_uploads.updated_at IS '上传状态最近更新时间';

CREATE TABLE IF NOT EXISTS message_attachments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL,
  UNIQUE (message_id, document_id),
  UNIQUE (message_id, ordinal)
);

CREATE INDEX IF NOT EXISTS message_attachments_user_message_idx
  ON message_attachments(user_id, message_id, ordinal);

COMMENT ON COLUMN message_attachments.id IS '消息附件绑定唯一标识';
COMMENT ON COLUMN message_attachments.user_id IS '附件所属用户标识，用于数据库层授权过滤';
COMMENT ON COLUMN message_attachments.message_id IS '附件绑定的用户消息标识';
COMMENT ON COLUMN message_attachments.document_id IS '附件已索引的 RAG 逻辑文档标识';
COMMENT ON COLUMN message_attachments.ordinal IS '附件在单条消息内从零开始的稳定展示顺序';
COMMENT ON COLUMN message_attachments.file_name IS '上传时的展示文件名，不包含本地路径';
COMMENT ON COLUMN message_attachments.content_type IS '上传文件的受支持 MIME 类型';
COMMENT ON COLUMN message_attachments.size_bytes IS '浏览器报告并经服务端校验的文件字节数';
COMMENT ON COLUMN message_attachments.created_at IS '附件与消息完成绑定的时间';
