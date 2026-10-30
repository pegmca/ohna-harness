/**
 * UI 几何验收共享断言：供 Playwright 视觉脚本统一判断浮层越界、页面溢出与滚动归属。
 *
 * 只做纯计算，不依赖具体页面；视觉用例负责抓取真实 DOM 数据并调用这些断言。
 */

/**
 * 判断矩形是否完整落在视口内。
 *
 * @param {{top:number,right:number,bottom:number,left:number}} rect 元素矩形。
 * @param {{width:number,height:number}} viewport 视口尺寸。
 * @param {number} tolerancePx 亚像素容差。
 * @returns {boolean} 四边均在视口内返回 true。
 */
export function isRectWithinViewport(rect, viewport, tolerancePx = 1) {
  return rect.top >= -tolerancePx
    && rect.left >= -tolerancePx
    && rect.right <= viewport.width + tolerancePx
    && rect.bottom <= viewport.height + tolerancePx;
}

/**
 * 判断页面是否发生意外横向溢出。
 *
 * @param {number} scrollWidth 根节点 scrollWidth。
 * @param {number} viewportWidth 视口宽度。
 * @param {number} tolerancePx 亚像素容差。
 * @returns {boolean} 未溢出返回 true。
 */
export function hasNoHorizontalOverflow(scrollWidth, viewportWidth, tolerancePx = 1) {
  return scrollWidth <= viewportWidth + tolerancePx;
}

/**
 * 判断目标容器是否是纵向滚动归属（overflowY 可滚动且内容高度超出容器）。
 *
 * @param {{overflowY:string,scrollHeight:number,clientHeight:number}|null} element 目标元素几何。
 * @returns {boolean} 是纵向滚动容器返回 true。
 */
export function isVerticalScrollOwner(element) {
  if (!element) return false;
  if (element.overflowY !== "auto" && element.overflowY !== "scroll") return false;
  return element.scrollHeight > element.clientHeight;
}

/**
 * 生成可读的失败原因；通过时返回 undefined。
 *
 * @param {string} label 检查项名称。
 * @param {object} data 原始几何数据。
 * @returns {string|undefined} 失败原因。
 */
export function explainGeometryFailure(label, data) {
  const { rect, viewport, scrollWidth, scrollContainer } = data;
  if (!rect) return `${label}: missing target rect`;
  if (!isRectWithinViewport(rect, viewport)) {
    return `${label}: target outside viewport ${JSON.stringify({ rect, viewport })}`;
  }
  if (scrollWidth !== undefined && !hasNoHorizontalOverflow(scrollWidth, viewport.width)) {
    return `${label}: horizontal overflow ${scrollWidth} > ${viewport.width}`;
  }
  if (scrollContainer !== undefined && !isVerticalScrollOwner(scrollContainer)) {
    return `${label}: expected vertical scroll owner, got ${JSON.stringify(scrollContainer)}`;
  }
  return undefined;
}
