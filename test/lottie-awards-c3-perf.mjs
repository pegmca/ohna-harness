// 逐帧渲染耗时 + 末帧像素校验（jsdom + lottie_light，SVG 渲染）
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
const source = new URL(`../apps/ohna-web/src/assets/lottie/awards/magnetic-c3.json`, import.meta.url);
const data = JSON.parse(readFileSync(source, "utf8"));
const container = document.createElement("div");
document.body.appendChild(container);
const anim = lottie.loadAnimation({ container, renderer: "svg", loop: false, autoplay: false, animationData: data });

const FR = data.fr, OP = data.op;
let times = [];
let maxT = 0, maxF = -1;
for (let f = 0; f <= OP; f++) {
  const t0 = performance.now();
  anim.goToAndStop(f, true);
  const dt = performance.now() - t0;
  times.push(dt);
  if (dt > maxT) { maxT = dt; maxF = f; }
}
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const sorted = [...times].sort((a, b) => a - b);
const p95 = sorted[Math.floor(sorted.length * 0.95)];
const p99 = sorted[Math.floor(sorted.length * 0.99)];
console.log(`frames=${times.length} avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${maxT.toFixed(2)}ms@${maxF}`);

// 末帧像素校验：识别橙色 vs 青绿
anim.goToAndStop(OP, true);
const svg = container.querySelector("svg");
const svgText = svg.outerHTML;
// 统计 fill 颜色出现次数，确认无橙色、仅 ACCENT
const ACCENT = "rgb(137,215,183)";   // 0.537*255≈137, 0.843*255≈215, 0.718*255≈183
const orangeCount = (svgText.match(/rgb\(255,125|rgb\(255, 125|255,125,56|255, 125, 56/ig) || []).length;
const accentCount = (svgText.match(/137,215,183|137, 215, 183/ig) || []).length;
console.log(`last-frame ACCENT hits=${accentCount} orangeHits=${orangeCount}`);
console.log(`last-frame color-presence ACCENT=${accentCount > 0} orange=${orangeCount > 0}`);

anim.destroy();
process.exit(0);
