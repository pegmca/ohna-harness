/**
 * 弹窗的焦点生命周期（FR-001）：把「开入关出 + Tab 焦点环 + ESC 关闭」收在一处，
 * 让 `SettingsDialog` 壳组件只保留排版，避免在组件里堆叠多个 effect。
 *
 * 语义：
 * - 挂载时把焦点移入面板（`role="dialog"` 自带 `tabIndex={-1}`），屏幕阅读器先朗读标题；
 * - 卸载（= 关闭）时把焦点归还给打开前聚焦的元素（左侧角落的设置按钮），键盘用户不丢位置；
 * - ESC 关闭；Tab / Shift+Tab 在面板内的可聚焦元素之间循环，不逃逸到遮罩后的页面。
 */
import { useEffect, type RefObject } from "react";

/** 面板内可参与 Tab 序列的元素选择器。 */
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(", ");

/**
 * 给已挂载的对话框绑定焦点与键盘行为。
 *
 * `onClose` 进入依赖数组：调用方需传稳定引用（`useCallback`），否则每次渲染都会重绑监听
 * 并重跑「焦点归还」清理——那会在弹窗仍打开时把焦点丢回触发按钮。
 *
 * @param panelRef 对话框面板（`role="dialog"`）的 ref。
 * @param onClose 请求关闭回调（ESC 触发），须为稳定引用。
 * @returns 无返回值。
 */
export function useDialogFocus(panelRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    /**
     * 全局按键：ESC 关闭；Tab 在面板内循环。
     *
     * @param event 键盘事件。
     * @returns void。
     */
    function handleKeyDown(event: KeyboardEvent): void {
      const panel = panelRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [panelRef, onClose]);
}
