/**
 * 「关于」分区（03 L3-5）：版本与仓库信息。
 *
 * 版本取构建期注入的 `__OHNA_WEB_VERSION__`（apps/ohna-desktop/package.json），
 * 不新增运行时端点；同时展示 runtime 协议版本便于排障。
 */
import { SettingsFacts, SettingsSection } from "./settings-primitives";
import type { SettingsHealthState } from "./settings-health";

/**
 * 渲染关于分区。
 *
 * @param props.health runtime 健康信息。
 * @returns 关于分区。
 */
export function AboutSection(props: { health: SettingsHealthState }) {
  const protocolVersion = props.health.state === "ready"
    ? props.health.health?.protocolVersion
    : undefined;
  return (
    <SettingsSection description="版本与运行环境信息。" id="about" title="关于">
      <SettingsFacts
        items={[
          { label: "应用版本", value: <code>{__OHNA_WEB_VERSION__}</code> },
          { label: "本地运行", value: <span className="settings-helper">本地单用户模式：无登录、无租户隔离。</span> },
          {
            label: "runtime 协议",
            value: protocolVersion === undefined
              ? <span className="settings-helper">—</span>
              : <code>{protocolVersion}</code>
          }
        ]}
      />
    </SettingsSection>
  );
}
