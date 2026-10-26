import assert from "node:assert/strict";
import test from "node:test";

import { ping } from "../dist/utility/worker.js";

test("worker ping returns pong", async () => {
  assert.equal(await ping(), "pong");
});
