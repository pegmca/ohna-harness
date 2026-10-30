import { type RefObject, useEffect } from "react";

/**
 * 管理设置弹窗的焦点生命周期：打开时移入面板，ESC 关闭，关闭后归还触发元素。
 *
 * @param panelRef 弹窗面板引用。
 * @param onClose ESC 触发的关闭回调。
 * @returns void。
 */
export function useDialogFocus(
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    panelRef.current?.focus();

    /**
     * 让焦点留在弹窗内，避免键盘用户误入遮罩后的工作台。
     *
     * @param event 键盘事件。
     * @returns void。
     */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose, panelRef]);
}
