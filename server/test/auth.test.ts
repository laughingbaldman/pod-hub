import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.ts";
import { can, canManageRole, createUser, hashPassword, login, sessionUser, verifyPassword } from "../src/lib/auth.ts";
import { nextBatchSku } from "../src/lib/sku.ts";

test("password hashing", () => {
  const h = hashPassword("correct horse battery");
  assert.ok(verifyPassword("correct horse battery", h));
  assert.ok(!verifyPassword("wrong", h));
});

test("tiers", () => {
  assert.ok(can("staff", "print.send"));
  assert.ok(!can("user", "print.send"));
  assert.ok(!can("staff", "print.override"));
  assert.ok(can("admin", "print.override"));
  assert.ok(!can("customer", "parts.internal"));
  assert.ok(canManageRole("admin", "staff"));
  assert.ok(!canManageRole("admin", "admin"));
  assert.ok(canManageRole("superadmin", "admin"));
});

test("login, lockout and sessions", () => {
  const db = openDb(":memory:");
  createUser(db, { username: "pat", displayName: "Pat", role: "staff", password: "a-long-password" });
  const ok = login(db, "pat", "a-long-password", 1, "127.0.0.1", "test");
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(sessionUser(db, ok.token)?.role, "staff");
  for (let i = 0; i < 5; i++) login(db, "pat", "nope-nope-nope", 1, "127.0.0.1", "test");
  const locked = login(db, "pat", "a-long-password", 1, "127.0.0.1", "test");
  assert.deepEqual(locked, { ok: false, reason: "locked" });
});

test("audit log is append-only", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO audit_log (action) VALUES ('x')").run();
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'y'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM audit_log").run(), /append-only/);
});

test("batch SKU rule", () => {
  assert.equal(nextBatchSku(1, 10, 2026, []), "1-10-2026");
  assert.equal(nextBatchSku(1, 10, 2026, ["1-10-2026"]), "1-10-2026-2");
  assert.equal(nextBatchSku(1, 10, 2026, ["1-10-2026", "1-10-2026-2"]), "1-10-2026-3");
});
