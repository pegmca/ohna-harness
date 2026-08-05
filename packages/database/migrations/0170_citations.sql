CREATE TABLE IF NOT EXISTS message_citations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chunk_id uuid REFERENCES chunks(id) ON DELETE RESTRICT,
  document_version_id uuid REFERENCES document_versions(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  claim text NOT NULL,
  quote text NOT NULL,
  score double precision,
  verifier_status text NOT NULL CHECK (verifier_status IN ('unverified', 'verified', 'rejected', 'manual_verified', 'manual_rejected')),
  created_at timestamptz NOT NULL,
  UNIQUE (message_id, ordinal)
);
CREATE INDEX IF NOT EXISTS message_citations_chunk_idx ON message_citations (chunk_id);
CREATE INDEX IF NOT EXISTS message_citations_document_version_idx ON message_citations (document_version_id);
CREATE INDEX IF NOT EXISTS message_citations_user_message_idx ON message_citations (user_id, message_id, ordinal);

COMMENT ON COLUMN message_citations.id IS '引用记录唯一标识';
COMMENT ON COLUMN message_citations.user_id IS '生成该引用的回答所属用户标识，用于授权过滤';
COMMENT ON COLUMN message_citations.message_id IS '引用所属的 assistant 消息，随消息删除级联';
COMMENT ON COLUMN message_citations.chunk_id IS '生成时引用的固定 chunk；无法解析到持久化 chunk 时为空，删除被引用 chunk 受限';
COMMENT ON COLUMN message_citations.document_version_id IS '生成时引用的固定文档版本；默认保留，仅独立保留策略可删除被引用版本';
COMMENT ON COLUMN message_citations.ordinal IS '引用在消息内从 1 开始的稳定展示序号';
COMMENT ON COLUMN message_citations.claim IS '引用支撑的回答论断摘要';
COMMENT ON COLUMN message_citations.quote IS '生成时的引用原文快照，来源归档后仍可解释，但不替代 chunk/version 外键';
COMMENT ON COLUMN message_citations.score IS '生成时检索/排序分数快照，无分数时为空';
COMMENT ON COLUMN message_citations.verifier_status IS '校验状态：unverified 待校验、verified/rejected 自动校验终态、manual_verified/manual_rejected 人工终态不可被自动覆盖';
COMMENT ON COLUMN message_citations.created_at IS '引用记录创建时间';

CREATE TABLE IF NOT EXISTS artifact_citations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  chunk_id uuid REFERENCES chunks(id) ON DELETE RESTRICT,
  document_version_id uuid REFERENCES document_versions(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  claim text NOT NULL,
  quote text NOT NULL,
  score double precision,
  verifier_status text NOT NULL CHECK (verifier_status IN ('unverified', 'verified', 'rejected', 'manual_verified', 'manual_rejected')),
  created_at timestamptz NOT NULL,
  UNIQUE (artifact_id, ordinal)
);
CREATE INDEX IF NOT EXISTS artifact_citations_chunk_idx ON artifact_citations (chunk_id);
CREATE INDEX IF NOT EXISTS artifact_citations_document_version_idx ON artifact_citations (document_version_id);
CREATE INDEX IF NOT EXISTS artifact_citations_user_artifact_idx ON artifact_citations (user_id, artifact_id, ordinal);

COMMENT ON COLUMN artifact_citations.id IS '引用记录唯一标识';
COMMENT ON COLUMN artifact_citations.user_id IS '生成该引用的报告所属用户标识，用于授权过滤';
COMMENT ON COLUMN artifact_citations.artifact_id IS '引用所属的 Artifact，随 Artifact 删除级联';
COMMENT ON COLUMN artifact_citations.chunk_id IS '生成时引用的固定 chunk；无法解析到持久化 chunk 时为空，删除被引用 chunk 受限';
COMMENT ON COLUMN artifact_citations.document_version_id IS '生成时引用的固定文档版本；默认保留，仅独立保留策略可删除被引用版本';
COMMENT ON COLUMN artifact_citations.ordinal IS '引用在 Artifact 内从 1 开始的稳定展示序号';
COMMENT ON COLUMN artifact_citations.claim IS '引用支撑的报告论断（claimId 或 supportsFinding）';
COMMENT ON COLUMN artifact_citations.quote IS '生成时的引用原文快照，来源归档后仍可解释，但不替代 chunk/version 外键';
COMMENT ON COLUMN artifact_citations.score IS '生成时检索/排序分数快照，无分数时为空';
COMMENT ON COLUMN artifact_citations.verifier_status IS '校验状态：unverified 待校验、verified/rejected 自动校验终态、manual_verified/manual_rejected 人工终态不可被自动覆盖';
COMMENT ON COLUMN artifact_citations.created_at IS '引用记录创建时间';
