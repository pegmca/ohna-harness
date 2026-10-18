import assert from "node:assert/strict";
import { test } from "node:test";
import { RepositoryError } from "@aiagent/database";
import { createApiServer } from "../dist/index.js";
import { createInMemoryApiTestRuntime } from "../dist/adapters/in-memory-test-runtime.js";

test("attachment upload is idempotent by user/client id and rejects checksum conflicts", async () => {
  const uploads = new Map();
  const attachmentRepository = {
    async claim(input, now) {
      const key = `${input.userId}:${input.clientAttachmentId}`;
      const existing = uploads.get(key);
      if (existing) {
        if (existing.checksum !== input.checksum) throw new RepositoryError("conflict", "checksum conflict");
        return { created: false, upload: existing };
      }
      const upload = {
        ...input,
        status: "uploading",
        uploadedAt: now,
        claimToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString()
      };
      uploads.set(key, upload);
      return { created: true, upload };
    },
    async complete(userId, clientAttachmentId, claimToken, documentId) {
      const key = `${userId}:${clientAttachmentId}`;
      const existing = uploads.get(key);
      if (existing.claimToken === claimToken) uploads.set(key, { ...existing, status: "indexed", documentId });
    },
    async renew() { return true; },
    async fail() {},
    async cleanupOrphans() { return 0; }
  };
  const app = createApiServer({ ...createInMemoryApiTestRuntime(), attachmentRepository });
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/identity/bootstrap",
    payload: { visitorId: "attachment-owner-0001", fingerprintVersion: "test-v1" }
  });
  const cookie = bootstrap.headers["set-cookie"].split(";")[0];
  const payload = {
    clientAttachmentId: "00000000-0000-4000-8000-000000000001",
    conversationId: "00000000-0000-4000-8000-0000000000a1",
    fileName: "research.md",
    contentType: "text/markdown",
    sizeBytes: 7,
    content: "# hello"
  };

  const first = await app.inject({ method: "POST", url: "/api/attachments", headers: { cookie }, payload });
  const repeated = await app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: { cookie },
    payload: { ...payload, fileName: "renamed.md" }
  });
  const conflict = await app.inject({
    method: "POST",
    url: "/api/attachments",
    headers: { cookie },
    payload: { ...payload, content: "# changed", sizeBytes: 9 }
  });

  assert.equal(first.statusCode, 200);
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().data.documentId, first.json().data.documentId);
  assert.equal(conflict.statusCode, 409);
  await app.close();
});

test("expired uploading claim resumes existing RAG lineage after complete failure", async () => {
  let upload;
  let completeAttempts = 0;
  const attachmentRepository = {
    async claim(input, now) {
      if (upload?.status === "indexed") return { created: false, upload };
      upload = {
        ...input,
        status: "uploading",
        uploadedAt: upload?.uploadedAt ?? now,
        claimToken: crypto.randomUUID(),
        leaseExpiresAt: now
      };
      return { created: true, upload };
    },
    async complete(_userId, _clientAttachmentId, claimToken, documentId) {
      completeAttempts += 1;
      if (completeAttempts === 1) throw new Error("simulated database interruption");
      if (upload.claimToken === claimToken) upload = { ...upload, status: "indexed", documentId };
    },
    async renew() { return true; },
    async fail() {},
    async cleanupOrphans() { return 0; }
  };
  const app = createApiServer({ ...createInMemoryApiTestRuntime(), attachmentRepository });
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/identity/bootstrap",
    payload: { visitorId: "attachment-owner-recovery", fingerprintVersion: "test-v1" }
  });
  const cookie = bootstrap.headers["set-cookie"].split(";")[0];
  const payload = {
    clientAttachmentId: "00000000-0000-4000-8000-000000000002",
    conversationId: "00000000-0000-4000-8000-0000000000a2",
    fileName: "recovery.txt",
    contentType: "text/plain",
    sizeBytes: 7,
    content: "content"
  };

  const interrupted = await app.inject({ method: "POST", url: "/api/attachments", headers: { cookie }, payload });
  const recovered = await app.inject({ method: "POST", url: "/api/attachments", headers: { cookie }, payload });

  assert.equal(interrupted.statusCode, 500);
  assert.equal(recovered.statusCode, 200);
  assert.equal(completeAttempts, 2);
  assert.equal(recovered.json().data.documentId, upload.documentId);
  await app.close();
});
