/**
 * 「连接状态」分区（03 L3-1）：展示当前 ohna 进程的连接事实——全部只读。
 *
 * 数据来自 `GET /api/health`（不含任何写端点）。
 */
import { SettingsBadge, SettingsFacts, SettingsSection } from "./settings-primitives";
import type { SettingsHealthState } from "./settings-health";

/**
 * 渲染连接状态分区。
 *
 * @param props.health 健康信息探针状态。
 * @returns 连接状态分区。
 */
export function ConnectionSection(props: { health: SettingsHealthState }) {
  const { state, health } = props.health;
  return (
    <SettingsSection
      description="本地服务与工作区事实，由启动 ohna 的进程决定，只读。"
      id="connection"
      title="连接状态"
    >
      {state === "loading" ? <p className="muted-row">正在读取本地服务信息…</p> : null}
      {state === "unavailable" ? (
        <p className="error-block">未检测到本地 ohna 服务，请确认 ohna 进程仍在运行。</p>
      ) : null}
      {state === "ready" && health ? (
        <SettingsFacts
          items={[
            {
              label: "连接状态",
              value: <SettingsBadge tone="success">已连接</SettingsBadge>
            },
            { label: "服务地址", value: <code>{health.url}</code> },
            { label: "端口", value: <code>{health.port}</code> },
            { label: "workspaceRoot", value: <code>{health.workspaceRoot}</code> },
            {
              label: "dataDir",
              value: health.dataDir
                ? <code>{health.dataDir}</code>
                : <span className="settings-helper">未上报（使用进程默认目录）</span>
            },
            {
              label: "进程 PID",
              value: health.pid === undefined ? <span className="settings-helper">—</span> : <code>{health.pid}</code>
            }
          ]}
        />
      ) : null}
    </SettingsSection>
  );
}
