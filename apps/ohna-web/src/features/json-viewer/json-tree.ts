/**
 * JSON 阅读器的纯逻辑层（BUG-003）：把任意 JS 值规整成安全、可渲染的树模型。
 *
 * 为什么不直接在组件里递归 `typeof` 判断：
 * - 组件只应做渲染，安全降级（BigInt / 函数 / Symbol / 循环引用 / 超深嵌套）都是纯函数，
 *   放在这里才能脱离 DOM 单测；
 * - 防环用 WeakSet 而不是路径数组，O(1) 判定且天然支持同一对象被多处引用（DAG 不算环）；
 * - 惰性渲染要「知道哪里是结构、哪里是叶子」，所以统一成 `JsonNode` 判别联合，
 *   由 `JsonViewer` 决定展开哪些节点，纯函数不关心展开状态。
 */

/** 默认可见层数：2 = 根展开 + 第一层容器展开，第二层起折叠（见 `isExpandedByDefault`）。 */
export const DEFAULT_DEPTH = 2;

/**
 * 允许渲染的最大节点数（含嵌套）：超过只给根摘要，避免巨型记录把主线程和 DOM 拖死。
 * 该上限远高于旧实现「序列化字符串 > 1MB 就不渲染」的口径——旧的 1MB 对应约几万个节点，
 * 这里按真实节点数计费，且只有已展开的节点会进 DOM。
 */
export const MAX_RENDER_NODES = 50_000;

/**
 * 「全部展开」一次最多铺开的行数（×2 即标题行 + 子行）。节点总数上限（`MAX_RENDER_NODES`）
 * 只管「是否可渲染」，但一次性把几万节点铺进 DOM 仍会卡住主线程，所以批量展开单独设更低的预算，
 * 超出部分保持折叠、用户可继续按节点手动展开。
 */
export const MAX_BULK_EXPAND_NODES = 2_000;

/** 单个字符串在树里先展示的字符数，超过给「展开全文」。 */
export const MAX_STRING_LENGTH = 200;

/** 递归深度上限：超过的子树不做结构化展开（防栈溢出，也防病态深嵌套）。 */
export const MAX_TREE_DEPTH = 64;

/** JSON 值的语法类别，对应 `.json-viewer-*` 高亮类名。 */
export type JsonValueKind =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "unsupported"
  | "object"
  | "array";

/** 叶子值节点。 */
export interface JsonLeafNode {
  nodeType: "leaf";
  /** 值类别；对象 / 数组不会出现在叶子节点上。 */
  kind: Exclude<JsonValueKind, "object" | "array">;
  /** 已安全文本化的值（长字符串在渲染层再截断，这里保留全文）。 */
  text: string;
}

/** 对象 / 数组节点。 */
export interface JsonContainerNode {
  nodeType: "container";
  kind: "object" | "array";
  /** 子节点；对象保持插入顺序，数组按索引。 */
  entries: JsonEntry[];
  /** 是否为超出深度上限后的「懒展开」节点（折叠态展示 JSON 原文摘要）。 */
  deep?: boolean;
  /** 深度超限时的原文摘要。 */
  deepText?: string;
}

/** 树节点。 */
export type JsonNode = JsonLeafNode | JsonContainerNode;

/** 对象条目 / 数组元素。 */
export interface JsonEntry {
  /** 对象键名；数组元素为 `undefined`（渲染层显示索引）。 */
  key?: string;
  value: JsonNode;
}

/** 遍历过程中共享的可变状态。 */
interface WalkContext {
  /** 祖先链上的容器，用于识别循环引用（WeakSet 只标记「当前路径」）。 */
  ancestors: WeakSet<object>;
  /** 已统计的节点数，用于 `MAX_RENDER_NODES` 截断。 */
  count: number;
}

/**
 * 把任意值转换为可渲染的树。
 *
 * 安全降级规则：undefined → `undefined`、BigInt → `123n`、函数 → `[Function name]`、
 * Symbol → `Symbol(desc)`、Date/RegExp/Map/Set 等非纯数据对象 → 其 `String()` 结果（text 类别），
 * 循环引用 → `[Circular]`。对象 / 数组超过节点上限时不再展开，只保留已统计到的部分，
 * 由 `isOverBudget` 判断是否要在渲染层整体降级。
 *
 * @param value 任意 JS 值（通常来自 JSON 反序列化的 payload）。
 * @returns 树模型；节点数超过上限时 `truncated` 为 true。
 */
export function buildJsonTree(value: unknown): { root: JsonNode; nodeCount: number; truncated: boolean } {
  const context: WalkContext = { ancestors: new WeakSet(), count: 0 };
  const root = buildNode(value, 0, context);
  return { root, nodeCount: context.count, truncated: context.count > MAX_RENDER_NODES };
}

/** 根节点的展开键。 */
export const ROOT_KEY = "$";

/** 键路径分隔符：用 NUL 而不是 `/`，避免键名本身含 `/` 时路径冲突（见 `childKey`）。 */
const KEY_SEPARATOR = "\u0000";

/**
 * 计算子节点的展开键。
 *
 * **为什么不直接拼 `${parent}/${key}`**：对象键名可以包含任意字符，`{"a/b": 1}` 与
 * `{a: {"b": 1}}` 会得到同一个路径字符串，导致一键展开 / 折叠时父子状态互相覆盖。
 * 这里用不会出现在常规文本里的 NUL 作分隔符，并转义键内可能出现的 NUL，
 * 使「路径 ↔ 字符串」是单射（编码可逆）。trace payload 里的 HTTP 路径、URL 字段
 * 恰好高频包含 `/`，所以在纯函数层就解决，而不是依赖调用方自己小心。
 *
 * @param parentKey 父节点键。
 * @param segment 子段（对象键名或数组下标）。
 * @returns 唯一的子节点键。
 */
export function childKey(parentKey: string, segment: string | number): string {
  const raw = String(segment);
  // 键内自带的 NUL 转义成 `\0` 字面两字符，保证解码无歧义。
  const safe = raw.includes(KEY_SEPARATOR) ? raw.split(KEY_SEPARATOR).join("\\0") : raw;
  return `${parentKey}${KEY_SEPARATOR}${safe}`;
}

/**
 * 把展开键解码回路径段（测试与「全部展开」诊断用；根返回空数组）。
 *
 * @param key 展开键。
 * @returns 路径段数组。
 */
export function decodeKeyPath(key: string): string[] {
  if (key === ROOT_KEY) return [];
  const body = key.startsWith(`${ROOT_KEY}${KEY_SEPARATOR}`)
    ? key.slice(ROOT_KEY.length + KEY_SEPARATOR.length)
    : key;
  return body.split(KEY_SEPARATOR).map((segment) => segment.split("\\0").join(KEY_SEPARATOR));
}

/**
 * 节点数是否超出安全上限。渲染层用它在超限时只展示摘要。
 *
 * @param tree `buildJsonTree` 的返回值。
 * @returns 超限为 true。
 */
export function isOverBudget(tree: { truncated: boolean }): boolean {
  return tree.truncated;
}

/**
 * 递归构造节点。
 *
 * @param value 当前值。
 * @param depth 当前深度（根为 0）。
 * @param context 共享遍历状态。
 * @returns 节点。
 */
function buildNode(value: unknown, depth: number, context: WalkContext): JsonNode {
  context.count += 1;
  if (context.count > MAX_RENDER_NODES) {
    // 已超预算：后续不再展开，返回空摘要占位（外层会整体降级，不会渲染这些节点）。
    return { nodeType: "container", kind: "object", entries: [], deep: true, deepText: "…" };
  }
  if (value === null) return { nodeType: "leaf", kind: "null", text: "null" };
  switch (typeof value) {
    case "string":
      return { nodeType: "leaf", kind: "string", text: value };
    case "number":
      // NaN / Infinity 不是 JSON 值，但 trace payload 里真实存在，直接文本化而不是丢弃。
      return { nodeType: "leaf", kind: "number", text: String(value) };
    case "boolean":
      return { nodeType: "leaf", kind: "boolean", text: value ? "true" : "false" };
    case "bigint":
      return { nodeType: "leaf", kind: "unsupported", text: `${value.toString()}n` };
    case "undefined":
      return { nodeType: "leaf", kind: "unsupported", text: "undefined" };
    case "symbol":
      return { nodeType: "leaf", kind: "unsupported", text: safeString(value) };
    case "function":
      return { nodeType: "leaf", kind: "unsupported", text: `[Function${value.name ? ` ${value.name}` : ""}]` };
    default:
      return buildObjectNode(value as object, depth, context);
  }
}

/**
 * 构造对象 / 数组节点，并处理循环引用、深度上限与非纯数据对象降级。
 *
 * @param value 非 null 的对象值。
 * @param depth 当前深度。
 * @param context 共享遍历状态。
 * @returns 容器节点或降级后的叶子节点。
 */
function buildObjectNode(value: object, depth: number, context: WalkContext): JsonNode {
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainDataObject(value)) {
    // Date / Map / Set / RegExp / 类实例：没有可折叠的 JSON 结构，降级为文本，避免渲染出一堆内部字段。
    return { nodeType: "leaf", kind: "unsupported", text: safeString(value) };
  }
  if (context.ancestors.has(value)) {
    return { nodeType: "leaf", kind: "unsupported", text: "[Circular]" };
  }
  if (depth >= MAX_TREE_DEPTH) {
    return {
      nodeType: "container",
      kind: isArray ? "array" : "object",
      entries: [],
      deep: true,
      deepText: safeShortJson(value)
    };
  }
  context.ancestors.add(value);
  const entries: JsonEntry[] = [];
  if (isArray) {
    const list = value as unknown[];
    for (let index = 0; index < list.length; index += 1) {
      entries.push({ value: buildNode(list[index], depth + 1, context) });
    }
  } else {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      entries.push({ key, value: buildNode(record[key], depth + 1, context) });
    }
  }
  context.ancestors.delete(value);
  return { nodeType: "container", kind: isArray ? "array" : "object", entries };
}

/**
 * 判断是否是可以按 JSON 语义展开的纯数据对象（排除 Date / Map / Set / RegExp 等）。
 * 不依赖原型链身份（跨 iframe / 跨 realm 也成立），只看 `Symbol.toStringTag` 与自有可枚举键。
 *
 * @param value 任意对象。
 * @returns 纯数据对象为 true。
 */
function isPlainDataObject(value: object): boolean {
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Object]") return true;
  // 无原型字面量（Object.create(null)）的 tag 也是 [object Object]，已被上一行覆盖；
  // 其余 tag（Date/Map/Set/RegExp/Error…）一律降级。
  return false;
}

/**
 * `String(value)` 的安全封装（`Symbol` 的 String() 是合法用法，但自定义 toString 可能抛错）。
 *
 * @param value 任意值。
 * @returns 文本。
 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[Unserializable]";
  }
}

/**
 * 深度超限节点的短原文摘要（只序列化一层，避免再次深递归）。
 *
 * @param value 容器值。
 * @returns 截断后的 JSON 文本。
 */
function safeShortJson(value: object): string {
  try {
    const text = JSON.stringify(value) ?? "";
    return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…` : text;
  } catch {
    return Array.isArray(value) ? "[…]" : "{…}";
  }
}

/**
 * 折叠态摘要：`{3 项}` / `[5 项]`，空容器给 `{}` / `[]`。
 *
 * @param node 容器节点。
 * @returns 摘要文本。
 */
export function summarizeNode(node: JsonContainerNode): string {
  const size = node.entries.length;
  if (node.deep) return node.kind === "array" ? "[…]" : "{…}";
  if (node.kind === "array") return size === 0 ? "[]" : `[${size} 项]`;
  return size === 0 ? "{}" : `{${size} 项}`;
}

/**
 * 是否应该默认展开：容器自身深度（根为 0）小于「可见层数」即展开。
 *
 * 以「可见层数」表达而不是「最大深度」，是为了对齐需求里的自然语言：
 * `defaultDepth = 1` → 只看到第一层（根展开，第一层的容器折叠成摘要）；
 * 默认 2 → 根 + 第一层容器展开、第二层起折叠；以此类推。
 *
 * @param depth 容器自身深度（根为 0）。
 * @param defaultDepth 可见层数。
 * @returns 展开为 true。
 */
export function isExpandedByDefault(depth: number, defaultDepth: number = DEFAULT_DEPTH): boolean {
  return depth < defaultDepth;
}

/**
 * 收集全部可展开节点的键（与组件内部键格式一致），用于「全部展开 / 全部折叠」。
 *
 * @param node 起始节点。
 * @param limit 最多返回的键数（超过即停止，防止「全部展开」把巨型树一次性铺满 DOM）。
 * @returns 展开键列表。
 */
export function collectExpandableKeys(node: JsonNode, limit = MAX_RENDER_NODES): string[] {
  const keys: string[] = [ROOT_KEY];
  /**
   * 递归收集可展开容器。
   *
   * @param current 当前节点。
   * @param key 当前节点键。
   * @returns 无。
   */
  const walk = (current: JsonNode, key: string): void => {
    if (current.nodeType !== "container" || current.deep) return;
    current.entries.forEach((entry, index) => {
      const nextKey = childKey(key, entry.key ?? index);
      if (keys.length >= limit) return;
      if (entry.value.nodeType === "container" && !entry.value.deep) {
        keys.push(nextKey);
        walk(entry.value, nextKey);
      }
    });
  };
  if (node.nodeType === "container" && !node.deep) walk(node, ROOT_KEY);
  return keys;
}

/**
 * 把控制字符转成可读的转义序列（换行 `\n`、制表符 `\t`、其余 `\u00XX`），
 * 让多行字符串在树上保持单行可读，也不撑破布局。
 *
 * @param text 原始字符串。
 * @returns 单行可读文本（换行显示为 `\n`，制表符 `\t`，其余控制字符 `\u00XX`）。
 */
export function escapeControlChars(text: string): string {
  let output = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n") output += "\\n";
    else if (char === "\r") output += "\\r";
    else if (char === "\t") output += "\\t";
    else if (char === "\b") output += "\\b";
    else if (char === "\f") output += "\\f";
    else if (code < 0x20) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += char;
  }
  return output;
}

/**
 * 长字符串截断：超过 `MAX_STRING_LENGTH` 时只给前缀 + 是否被截断。
 *
 * @param text 原始字符串。
 * @param limit 保留的字符数。
 * @returns 展示文本与截断标记。
 */
export function truncateString(
  text: string,
  limit: number = MAX_STRING_LENGTH
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  // 不切断代理对：若切点落在高代理项上，回退一位，避免渲染出 �。
  const code = text.charCodeAt(limit - 1);
  const safeLimit = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return { text: text.slice(0, safeLimit), truncated: true };
}

/**
 * 字符串叶子在树中的展示文本：控制字符转义，截断时补省略号。
 *
 * @param text 叶子原文。
 * @param isTruncated 是否截断。
 * @returns 展示文本（不含引号，引号由渲染层加，便于高亮类包裹内容）。
 */
export function formatStringPreview(text: string, isTruncated: boolean): string {
  return `${escapeControlChars(text)}${isTruncated ? "…" : ""}`;
}
