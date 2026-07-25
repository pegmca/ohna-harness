CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_message_at timestamptz NOT NULL,
  archived_at timestamptz
);

CREATE INDEX conversations_user_status_last_message_idx
  ON conversations(user_id, status, last_message_at DESC, id DESC);

COMMENT ON COLUMN conversations.id IS '会话唯一标识';
COMMENT ON COLUMN conversations.user_id IS '会话所属用户标识';
COMMENT ON COLUMN conversations.title IS '用户可见的会话标题';
COMMENT ON COLUMN conversations.status IS '会话状态：活跃或已归档';
COMMENT ON COLUMN conversations.created_at IS '会话创建时间';
COMMENT ON COLUMN conversations.updated_at IS '会话最近更新时间';
COMMENT ON COLUMN conversations.last_message_at IS '会话最后一条消息时间，用于稳定排序';
COMMENT ON COLUMN conversations.archived_at IS '会话归档时间，未归档时为空';

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id uuid,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled')),
  client_message_id text,
  sequence bigint NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT messages_conversation_sequence_uq UNIQUE (conversation_id, sequence)
);

CREATE UNIQUE INDEX messages_conversation_client_message_uq
  ON messages(conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

COMMENT ON COLUMN messages.id IS '消息唯一标识';
COMMENT ON COLUMN messages.conversation_id IS '消息所属会话标识';
COMMENT ON COLUMN messages.user_id IS '消息所属用户标识，用于授权过滤与审计';
COMMENT ON COLUMN messages.run_id IS '产生消息的运行标识，PR-03 增加外键';
COMMENT ON COLUMN messages.role IS '消息角色：用户、助手、系统或工具';
COMMENT ON COLUMN messages.content IS '消息可见文本内容';
COMMENT ON COLUMN messages.status IS '消息生命周期状态';
COMMENT ON COLUMN messages.client_message_id IS '客户端提交的消息幂等键';
COMMENT ON COLUMN messages.sequence IS '消息在会话内单调递增的序号';
COMMENT ON COLUMN messages.created_at IS '消息创建时间';
COMMENT ON COLUMN messages.completed_at IS '消息进入终态的时间';
