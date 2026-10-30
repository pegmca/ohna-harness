/** 「连接状态」分区：展示当前 utilityProcess runtime 的连接事实，全部只读。 */
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
      description="当前 utilityProcess runtime 的事实，由启动 ohna 的进程决定，只读。"
      id="connection"
      title="连接状态"
    >
      {state === "loading" ? <p className="muted-row">正在读取 runtime 信息…</p> : null}
      {state === "unavailable" ? (
        <p className="error-block">runtime 不可用，请确认 ohna 进程仍在运行。</p>
      ) : null}
      {state === "ready" && health ? (
        <SettingsFacts
          items={[
            {
              label: "连接状态",
              value: <SettingsBadge tone="success">已连接</SettingsBadge>
            },
            { label: "协议版本", value: <code>{health.protocolVersion}</code> },
            { label: "模型数", value: <code>{health.modelCount}</code> },
            { label: "已授权工作区", value: <code>{health.workspaceCount}</code> }
          ]}
        />
      ) : null}
    </SettingsSection>
  );
}
