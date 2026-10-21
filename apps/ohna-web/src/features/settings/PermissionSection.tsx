/**
 * 「权限模式」分区（03 L3-4）：只读解释当前进程的两种权限开关。
 *
 * 观测台语义（`observeOnly`）与自动批准（`autoApprove`）都由 CLI 启动参数与宿主决定，
 * Web 侧无法也不应修改；这里只做「当前是什么、意味着什么」的说明，避免用户误以为
 * 可以在 Web 中提权。
 */
import { SettingsBadge, SettingsFacts, SettingsSection } from "./settings-primitives";
import type { SettingsHealthState } from "./settings-health";

/**
 * 渲染权限模式分区。
 *
 * @param props.health 健康信息（端口的 observeOnly / autoApprove 由宿主决定，health 只暴露 model）.
 * @returns 权限模式分区。
 */
export function PermissionSection(props: { health: SettingsHealthState }) {
  const ready = props.health.state === "ready" && props.health.health !== undefined;
  return (
    <SettingsSection
      description="权限模式由启动 ohna 时的参数与宿主决定，Web 只读展示。"
      id="permission"
      title="权限模式"
    >
      {ready ? (
        <SettingsFacts
          items={[
            {
              label: "观测台（observeOnly）",
              value: (
                <span className="settings-inline">
                  <SettingsBadge tone="info">由宿主决定</SettingsBadge>
                  <span className="settings-helper">
                    只承接 CLI 镜像事件时，服务端不注册 run 创建/取消与确认写路由——浏览器不能发起或取消 run。
                  </span>
                </span>
              )
            },
            {
              label: "自动批准（autoApprove）",
              value: (
                <span className="settings-inline">
                  <SettingsBadge tone="neutral">由启动参数决定</SettingsBadge>
                  <span className="settings-helper">
                    开启时写文件、执行命令等变更类工具调用不再逐条确认；关闭时每次变更都会在对话中出现确认卡片。
                  </span>
                </span>
              )
            },
            {
              label: "当前模型",
              value: props.health.health?.modelId
                ? <code>{props.health.health.modelId}</code>
                : <span className="settings-helper">—</span>
            }
          ]}
        />
      ) : (
        <p className="muted-row">本地服务不可用，无法读取当前权限模式。</p>
      )}
    </SettingsSection>
  );
}
