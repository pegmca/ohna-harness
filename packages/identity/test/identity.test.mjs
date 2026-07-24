import assert from "node:assert/strict";
import test from "node:test";
import {
  createIdentityService,
  createInMemoryIdentityRepository
} from "../dist/index.js";

function createService() {
  return createIdentityService(createInMemoryIdentityRepository(), {
    fingerprintPepper: "identity-test-pepper"
  });
}

test("same browser fingerprint resolves to the same userId", async () => {
  const service = createService();
  const first = await service.bootstrap("visitor-stable-123", "fingerprintjs-v5");
  const second = await service.bootstrap("visitor-stable-123", "fingerprintjs-v5");
  const other = await service.bootstrap("visitor-other-456", "fingerprintjs-v5");

  assert.equal(first.snapshot.userId, second.snapshot.userId);
  assert.notEqual(first.snapshot.userId, other.snapshot.userId);
  assert.equal((await service.authenticate(first.token))?.userId, first.snapshot.userId);
});

test("QQ binding code is single-user and rejects rebinding an external identity", async () => {
  const service = createService();
  const first = await service.bootstrap("visitor-one-123", "fingerprintjs-v5");
  const second = await service.bootstrap("visitor-two-456", "fingerprintjs-v5");
  const firstCode = await service.createQqBindingChallenge(first.snapshot.userId);
  const bound = await service.consumeQqBinding(firstCode.code, "bot-one", "qq-open-id");
  assert.equal(bound.status, "bound");

  const secondCode = await service.createQqBindingChallenge(second.snapshot.userId);
  const conflict = await service.consumeQqBinding(secondCode.code, "bot-one", "qq-open-id");
  assert.equal(conflict.status, "conflict");
});
