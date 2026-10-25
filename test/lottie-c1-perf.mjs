// 逐帧性能探针：用 jsdom + lottie_light 渲染 magnetic-c1 的 0..239 帧，
// 记录每帧 goToAndStop 的渲染耗时，统计平均/峰值/异常峰值，确认丝滑且无卡死。
import { JSDOM } from "../apps/ohna-web/node_modules/jsdom/lib/api.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
const context = new Proxy({}, { get: () => () => ({}), set: () => true });
dom.window.HTMLCanvasElement.prototype.getContext = () => context;
try { Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true }); } catch {}
const lottie = require("../apps/ohna-web/node_modules/lottie-web/build/player/lottie_light");

const id = process.argv[2] || "magnetic-c1";
const source = new URL(`../apps/ohna-web/src/assets/lottie/awards/${id}.json`, import.meta.url);
const data = JSON.parse(readFileSync(source, "utf8"));
const container = document.createElement("div");
document.body.appendChild(container);
const anim = lottie.loadAnimation({ container, renderer: "svg", loop: false, autoplay: false, animationData: data });

const times = [];
let firstErr = null;
for (let f = 0; f <= data.op - 1; f++) {
  const t0 = performance.now();
  try {
    anim.goToAndStop(f, true);
    const svg = container.querySelector("svg");
    if (!svg) throw new Error(`frame ${f}: no svg`);
  } catch (e) {
    firstErr = firstErr || `frame ${f}: ${e.message}`;
  }
  times.push(performance.now() - t0);
}
anim.destroy();

const avg = times.reduce((a, b) => a + b, 0) / times.length;
const max = Math.max(...times);
const maxIdx = times.indexOf(max);
const sorted = [...times].sort((a, b) => a - b);
const p95 = sorted[Math.floor(sorted.length * 0.95)];
const ok = avg < 30 && max < 200 && !firstErr;

console.log(`id=${id} frames=${times.length}`);
console.log(`avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms@${maxIdx} firstErr=${firstErr}`);
console.log(ok ? "PASS: 单帧平均<30ms 且无异常峰值/错误" : "FAIL");
process.exit(ok ? 0 : 1);
