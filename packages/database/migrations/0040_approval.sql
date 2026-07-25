CREATE TABLE tool_approvals (
  id text PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  trace_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name text,
  permission_level text CHECK (permission_level IN ('safe', 'needs_approval', 'blocked')),
  reason text,
  reason_code text,
  input_digest text NOT NULL,
  input_preview jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decision text CHECK (decision IN ('approved', 'rejected')),
  requested_at timestamptz NOT NULL,
  decided_at timestamptz,
  expires_at timestamptz,
  reviewer_user_id uuid,
  reviewer_note text
);

CREATE INDEX tool_approvals_user_status_requested_idx ON tool_approvals(user_id, status, requested_at);
CREATE INDEX tool_approvals_run_idx ON tool_approvals(run_id);

COMMENT ON COLUMN tool_approvals.id IS 'Approval 唯一标识，由 trace、工具名和输入摘要确定性生成';
COMMENT ON COLUMN tool_approvals.run_id IS 'Approval 所属 Agent Run 标识，随 Run 删除级联清理';
COMMENT ON COLUMN tool_approvals.request_id IS 'Approval 绑定的原始请求标识，用于防止审批挪用';
COMMENT ON COLUMN tool_approvals.trace_id IS 'Approval 关联的 trace 标识';
COMMENT ON COLUMN tool_approvals.user_id IS 'Approval 所属用户标识，数据库层授权与决定校验的归属边界';
COMMENT ON COLUMN tool_approvals.tool_name IS '触发审批的工具名称';
COMMENT ON COLUMN tool_approvals.permission_level IS '工具权限等级：safe、needs_approval 或 blocked';
COMMENT ON COLUMN tool_approvals.reason IS '面向 reviewer 的审批原因说明';
COMMENT ON COLUMN tool_approvals.reason_code IS '稳定的安全原因码，供审计与回放';
COMMENT ON COLUMN tool_approvals.input_digest IS '规范化工具输入的绑定摘要，决定操作必须逐字匹配；空串表示原请求未绑定摘要';
COMMENT ON COLUMN tool_approvals.input_preview IS '已截断脱敏的工具输入预览，不保存完整敏感 payload';
COMMENT ON COLUMN tool_approvals.status IS '审批生命周期状态：pending、approved、rejected、expired，终态不可回退';
COMMENT ON COLUMN tool_approvals.decision IS '人工决定结果：approved 或 rejected，仅在 pending 态可写入';
COMMENT ON COLUMN tool_approvals.requested_at IS '审批请求创建时间';
COMMENT ON COLUMN tool_approvals.decided_at IS '审批决定写入时间';
COMMENT ON COLUMN tool_approvals.expires_at IS '审批过期时间，过期 pending 原子转为 expired 且工具绝不执行';
COMMENT ON COLUMN tool_approvals.reviewer_user_id IS '服务端确认的执行决定的用户标识，绝不接受客户端传入';
COMMENT ON COLUMN tool_approvals.reviewer_note IS 'reviewer 可选说明，最长 240 字符';
