/** 对话时间线距底部多少像素以内仍视为“钉住”。 */
export const PINNED_BOTTOM_THRESHOLD_PX = 80;

/**
 * 判断滚动容器是否贴近底部。
 *
 * @param element 滚动容器的三个布局值。
 * @returns 距底小于阈值时返回 true。
 */
export function isPinnedToBottom(element: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_BOTTOM_THRESHOLD_PX;
}

/**
 * 判断末条消息变化后是否应跟随滚动。
 *
 * @param pinned 当前是否贴近底部。
 * @param previousTailSig 上一次末条消息签名。
 * @param nextTailSig 最新末条消息签名。
 * @returns 末条增长且仍贴近底部时返回 true。
 */
export function shouldFollowTail(
  pinned: boolean,
  previousTailSig: string,
  nextTailSig: string
): boolean {
  return pinned && previousTailSig !== nextTailSig;
}
