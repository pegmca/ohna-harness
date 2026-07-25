CREATE TABLE documents (
  id uuid PRIMARY KEY,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('private', 'shared', 'demo')),
  source_type text NOT NULL CHECK (source_type IN ('local_file', 'remote_url', 'mock_text')),
  external_id text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CHECK ((scope = 'private') = (owner_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX documents_owner_external_uq
  ON documents (coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), external_id)
  WHERE deleted_at IS NULL;
CREATE INDEX documents_owner_scope_idx ON documents (owner_user_id, scope);

COMMENT ON COLUMN documents.id IS '文档主键，逻辑文档的稳定身份';
COMMENT ON COLUMN documents.owner_user_id IS '私有文档所属用户；shared/demo 文档为空，不伪造用户';
COMMENT ON COLUMN documents.scope IS '文档可见范围：private 仅 owner，shared 全员可见，demo 演示语料';
COMMENT ON COLUMN documents.source_type IS '来源类型：local_file 本地文件、remote_url 远程地址、mock_text 演示文本';
COMMENT ON COLUMN documents.external_id IS '来源稳定外部标识（source、fileName、fileType 的哈希），用于幂等查找';
COMMENT ON COLUMN documents.title IS '文档展示标题';
COMMENT ON COLUMN documents.created_at IS '文档创建时间';
COMMENT ON COLUMN documents.updated_at IS '文档最近一次版本变更时间';
COMMENT ON COLUMN documents.deleted_at IS '软删除时间；非空表示文档已删除，不参与查询与唯一约束';

CREATE TABLE document_versions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content_checksum text NOT NULL,
  content_type text NOT NULL,
  source_uri text NOT NULL,
  storage_kind text NOT NULL CHECK (storage_kind IN ('inline')),
  content text NOT NULL,
  parser_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'indexed', 'failed')),
  error_code text,
  error_message text,
  error_details jsonb,
  created_at timestamptz NOT NULL,
  indexed_at timestamptz,
  UNIQUE (document_id, version),
  UNIQUE (document_id, content_checksum)
);

COMMENT ON COLUMN document_versions.id IS '版本主键';
COMMENT ON COLUMN document_versions.document_id IS '所属逻辑文档，随文档删除级联';
COMMENT ON COLUMN document_versions.version IS '文档内递增版本号，内容变化时递增且不覆盖旧版本';
COMMENT ON COLUMN document_versions.content_checksum IS '正文内容 SHA-256 校验和；同文档内唯一，保证重复 ingest 幂等';
COMMENT ON COLUMN document_versions.content_type IS '原始内容 MIME 类型或 unknown';
COMMENT ON COLUMN document_versions.source_uri IS '版本来源 URI（ingest 请求的 source）';
COMMENT ON COLUMN document_versions.storage_kind IS '正文存储方式；当前仅 inline 受控原文存储';
COMMENT ON COLUMN document_versions.content IS '受控 inline 原文内容';
COMMENT ON COLUMN document_versions.parser_version IS '解析器版本标识，便于后续重放或兼容性诊断';
COMMENT ON COLUMN document_versions.status IS '版本状态：pending 处理中、indexed 已索引、failed 终态失败可重试';
COMMENT ON COLUMN document_versions.error_code IS '失败结构化错误码；成功版本为空';
COMMENT ON COLUMN document_versions.error_message IS '失败安全错误消息；成功版本为空';
COMMENT ON COLUMN document_versions.error_details IS '失败结构化诊断上下文；成功版本为空';
COMMENT ON COLUMN document_versions.created_at IS '版本创建时间';
COMMENT ON COLUMN document_versions.indexed_at IS '索引完成时间；未成功索引为空';

CREATE TABLE chunks (
  id uuid PRIMARY KEY,
  document_version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  chunk_text text NOT NULL,
  heading text,
  page_number integer,
  line_start integer,
  line_end integer,
  token_count integer,
  chunker_version text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_checksum text NOT NULL,
  UNIQUE (document_version_id, chunker_version, chunk_index)
);
CREATE INDEX chunks_document_version_idx ON chunks (document_version_id);

COMMENT ON COLUMN chunks.id IS 'chunk 主键（数据库内部身份，也作为分页 cursor）';
COMMENT ON COLUMN chunks.document_version_id IS '所属文档版本，随版本删除级联';
COMMENT ON COLUMN chunks.chunk_index IS '版本内从 0 开始的连续 chunk 序号';
COMMENT ON COLUMN chunks.chunk_text IS 'chunk 正文文本';
COMMENT ON COLUMN chunks.heading IS 'chunk 所属章节标题，可为空';
COMMENT ON COLUMN chunks.page_number IS '原文页码，可为空';
COMMENT ON COLUMN chunks.line_start IS '原文起始行号（1-based），可为空';
COMMENT ON COLUMN chunks.line_end IS '原文结束行号（1-based），可为空';
COMMENT ON COLUMN chunks.token_count IS 'chunk token 数；当前未接入 tokenizer 时为空';
COMMENT ON COLUMN chunks.chunker_version IS '切块器版本标识，与序号共同构成唯一约束';
COMMENT ON COLUMN chunks.metadata IS '扩展元数据（字符偏移、block 身份等重建 DTO 所需字段）';
COMMENT ON COLUMN chunks.content_checksum IS 'chunk 正文 SHA-256 校验和，用于变更诊断';
