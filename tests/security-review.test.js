const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const express = require("express");
const request = require("supertest");
process.env.JWT_SECRET = "isolated-media-review-signing-key-not-for-deployment-123456789";
const { privateMediaGate, signMedia } = require("../middleware/privateMedia");
const { normalizeRecord } = require("../services/attendanceService");
const { resolveStoredUploadPath, UPLOAD_ROOT } = require("../utils/upload");
let root;
let app;
const tempRoot = path.resolve(__dirname, "../.test-tmp");
test.before(async () => {
  await fs.mkdir(tempRoot, { recursive: true });
  root = await fs.mkdtemp(path.join(tempRoot, "media-review-"));
  await fs.mkdir(path.join(root, "documents"));
  await fs.mkdir(path.join(root, "profiles"));
  await fs.writeFile(path.join(root, "documents", "private.pdf"), "PRIVATE TEST FILE");
  await fs.writeFile(path.join(root, "documents", "other.pdf"), "OTHER PRIVATE FILE");
  await fs.writeFile(path.join(root, "profiles", "public.webp"), "PUBLIC TEST IMAGE");
  app = express();
  app.use("/uploads", privateMediaGate, express.static(root));
});
test.after(async () => { if (root && path.resolve(root).startsWith(tempRoot + path.sep)) await fs.rm(root, { recursive: true, force: true }); });

test("private static files fail closed for encoded, mixed-case, Windows and noncanonical paths", async () => {
  for (const url of ["/uploads/documents/private.pdf", "/uploads/%64ocuments/private.pdf", "/uploads/Documents/private.pdf", "/uploads//documents/private.pdf", "/uploads/documents%5cprivate.pdf", "/uploads/documents./private.pdf", "/uploads/DOCUME~1/private.pdf", "/uploads/documents/nested/private.pdf"]) {
    const result = await request(app).get(url);
    assert.ok([400, 401, 403].includes(result.status), `${url} returned ${result.status}`);
    assert.doesNotMatch(result.text, /PRIVATE TEST FILE/);
  }
  assert.equal((await request(app).get("/uploads/profiles/public.webp")).status, 200);
});

test("signed media grants are bound to one file and send no-store attachment headers", async () => {
  const url = signMedia("uploads/documents/private.pdf");
  const allowed = await request(app).get(url);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers["cache-control"], "private, no-store");
  assert.equal(allowed.headers["content-disposition"], "attachment");
  assert.equal((await request(app).get(url.replace("private.pdf", "other.pdf"))).status, 401);
});

test("staff note-only edits preserve parent absence origin without changing status", () => {
  const previous = { status: "ABSENT", markedByParent: true, reason: "Parent reported sick", attendanceType: "REGULAR" };
  const result = normalizeRecord({ note: "Private staff observation" }, previous);
  assert.equal(result.status, "ABSENT");
  assert.equal(result.markedByParent, true);
  assert.equal(result.parentAbsenceReason, "Parent reported sick");
  assert.equal(result.note, "Private staff observation");
  assert.equal(normalizeRecord({ status: "PRESENT" }, result).markedByParent, false);
});

test("upload cleanup resolves configured durable root and rejects traversal or external paths", () => {
  assert.equal(resolveStoredUploadPath("uploads/profiles/avatar.webp"), path.join(UPLOAD_ROOT, "profiles", "avatar.webp"));
  for (const invalid of ["../config/.env", "uploads/profiles/../../.env", "C:/secrets.txt", "https://example.invalid/avatar.webp", "uploads/unknown/file.webp"]) assert.equal(resolveStoredUploadPath(invalid), null);
});
