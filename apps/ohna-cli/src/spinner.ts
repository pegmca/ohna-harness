/**
 * TTY-only spinner：单 `✻` + 动词文案 + 已耗时秒数（对齐 Claude Code 真实形态）。
 *
 * 单写者协议（v2）：spinner 帧与 `renderEvent` 的正文写入互斥——任何正文写入前
 * 先 stop&clear（`\r\x1b[K`），写完在空闲窗重启帧。为规避「`\r\x1b[K` 清掉无换行
 * 结尾的 delta 尾部」，本模块采用两层保护：
 * 1. 撕裂防护：帧绘制前检查距最近一次正文写入的空闲窗（`FIRST_FRAME_DELAY_MS`），
 *    流式 delta 持续写入时帧始终被抑制；
 * 2. confirm 联动：`askConfirmation` 挂起前 `suspendSpinner`，resolve 后 `resumeSpinner`。
 *
 * 挂接点收敛在事件流（render.ts）：agent_start 启动、tool_execution_start 换动词、
 * message_start 抑制、agent_end 停帧——repl.ts / web-entry.ts 共用同一份，不做两处各自挂。
 * 非 TTY 下所有函数都是无副作用空操作（`supportsAnsi` 门控），保证管道输出不含 `\x1b`。
 */
import { paint, SPIN, supportsAnsi } from "./theme.js";

/** 帧刷新间隔（毫秒）。 */
const FRAME_INTERVAL_MS = 200;

/** 首帧延迟：正文写入后至少等待该时长才绘制下一帧（撕裂防护）。 */
const FIRST_FRAME_DELAY_MS = 300;

/** 当前动词文案（如「思考中」「执行 bash」）。 */
let verb = "思考中";

/** 本轮帧开始时刻（用于计算已耗时秒数）。 */
let startedAt = 0;

/** 是否已有可见帧（clear / stop 时据此决定是否写 `\r\x1b[K`）。 */
let visible = false;

/** 最近一次正文写入时刻；帧绘制前据此判断空闲窗。 */
let lastWriteAt = 0;

/** 定时器句柄；非 TTY 恒为 null。 */
let timer: NodeJS.Timeout | null = null;

/** 是否被 confirm 挂起打断（记录以便 resume 恢复原动词）。 */
let suspended = false;

/** 是否启用 spinner：TTY 整屏模式由 repl 关闭，避免 `\r\x1b[K` 污染对话模型。 */
let enabled = true;

/**
 * 启用 / 禁用 spinner。
 *
 * TTY 整屏模式下必须禁用：spinner 直接写 `\r\x1b[K` 到真实终端，会污染 TuiApp 的
 * 对话内容模型并破坏整屏重绘；禁用后所有 spinner 函数为空操作，事件渲染改为
 * 追加式进入对话区（Phase B2 再做流式原地刷新）。非 TTY / 旧 readline 路径默认启用。
 *
 * @param value true 启用、false 禁用（禁用时立即清掉可见帧）。
 */
export function setSpinnerEnabled(value: boolean): void {
  if (value) {
    enabled = true;
    return;
  }
  stopSpinner();
  enabled = false;
}

/**
 * 绘制一帧：`✻ 动词… (Ns)`，覆盖上一次帧。
 *
 * 空闲窗未到时直接返回（撕裂防护）；帧内容用 dim 色呈现为系统行。
 */
function draw(): void {
  if (!enabled) return;
  if (Date.now() - lastWriteAt < FIRST_FRAME_DELAY_MS) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  process.stdout.write(`\r\x1b[K${paint(`${SPIN} ${verb}… (${elapsed}s)`, "dim")}`);
  visible = true;
}

/**
 * 启动 spinner（agent_start 挂接点）。
 *
 * @param initialVerb 初始动词文案（缺省「思考中」）。
 */
export function startSpinner(initialVerb = "思考中"): void {
  if (!supportsAnsi()) return;
  if (!enabled) return;
  stopSpinner();
  verb = initialVerb;
  startedAt = Date.now();
  lastWriteAt = Date.now();
  timer = setInterval(() => {
    if (supportsAnsi()) draw();
  }, FRAME_INTERVAL_MS);
}

/**
 * 切换动词文案（tool_execution_start 挂接点，如「执行 bash」）。
 *
 * @param nextVerb 新的动词文案。
 */
export function setVerb(nextVerb: string): void {
  if (!enabled) return;
  verb = nextVerb;
  startedAt = Date.now();
  lastWriteAt = Date.now();
}

/**
 * 清除可见帧并标记最近一次正文写入。
 *
 * 任何正文写入前都应调用，保证正文行不与 spinner 帧拼在同一行。
 */
export function clearSpinner(): void {
  if (!enabled) return;
  if (visible) {
    process.stdout.write("\r\x1b[K");
    visible = false;
  }
  lastWriteAt = Date.now();
}

/**
 * 停止 spinner（agent_end / abort / error 路径的 finally 挂接点）。
 */
export function stopSpinner(): void {
  if (!enabled) return;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (visible) {
    process.stdout.write("\r\x1b[K");
    visible = false;
  }
}

/**
 * 挂起 spinner：confirm `question` 询问前调用，避免帧覆盖提示。
 */
export function suspendSpinner(): void {
  if (!enabled) return;
  suspended = timer !== null;
  stopSpinner();
}

/**
 * 恢复 spinner：confirm resolve 后调用，按原动词重启（仅当此前确实在跑）。
 */
export function resumeSpinner(): void {
  if (!enabled) return;
  if (!suspended) return;
  suspended = false;
  startSpinner(verb);
}
