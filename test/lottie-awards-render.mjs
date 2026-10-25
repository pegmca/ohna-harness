import { JSDOM } from "../apps/ohna-web/node_modules/jsdom/lib/api.js";
import { readFileSync, writeFileSync } from "node:fs";
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
function render(data, frame) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const anim = lottie.loadAnimation({ container, renderer: "svg", loop: false, autoplay: false, animationData: JSON.parse(JSON.stringify(data)) });
  anim.goToAndStop(frame, true);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("missing svg");
  svg.setAttribute("width", "480"); svg.setAttribute("height", "480");
  const html = svg.outerHTML.replaceAll('stroke-miterlimit="undefined"', 'stroke-miterlimit="4"');
  anim.destroy(); container.remove();
  return html;
}
for (const id of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(new URL(`../apps/ohna-web/src/assets/lottie/awards/${id}.json`, import.meta.url), "utf8"));
  for (const frame of [60, 120, data.op - 1]) {
    writeFileSync(`/tmp/lottie-awards/final-${id}-${frame}.svg`, render(data, frame));
    console.log(`${id}: rendered ${frame}`);
  }
}
process.exit(0);
