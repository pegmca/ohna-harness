import { JSDOM } from "../apps/ohna-web/node_modules/jsdom/lib/api.js";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window; globalThis.document = dom.window.document;
const context = new Proxy({}, { get: () => () => ({}), set: () => true });
dom.window.HTMLCanvasElement.prototype.getContext = () => context;
const lottie = require("../apps/ohna-web/node_modules/lottie-web/build/player/lottie_light");
const data = JSON.parse(readFileSync(process.argv[2], "utf8"));
const c = document.createElement("div"); document.body.appendChild(c);
const a = lottie.loadAnimation({ container: c, renderer: "svg", loop: false, autoplay: false, animationData: data });
for (const f of [10, 60, 120, 200]) { a.goToAndStop(f, true); }
console.log("stripped origami rendered frames 10/60/120/200 OK, layers=", data.layers.length);
process.exit(0);
