/**
 * Vertical slice, end to end on a real socket:
 * setup → login → part → G-code upload with Orca parsing → add printer by IP → pre-send check → send.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import { createUser } from "../src/lib/auth.ts";
import { fakeMoonraker, fakeOctoPrint, type Fake } from "./fakes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let app: FastifyInstance;
let base = "";
let dataDir = "";
let backupDir = "";
let moon: Fake;
let octo: Fake;
let admin = "";
let staff = "";
let viewer = "";

async function api(method: string, url: string, token: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-data-"));
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-backup-"));
  const built = await buildApp(loadConfig({ dataDir, backupDir, port: 0, host: "127.0.0.1", appDistDir: "/nonexistent" }), { logger: false, poll: false });
  app = built.app;
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  moon = await fakeMoonraker();
  octo = await fakeOctoPrint("test-octo-key");
  createUser(built.hub.db, { username: "sam", displayName: "Sam", role: "staff", password: "staff-password-1" });
  createUser(built.hub.db, { username: "cust", displayName: "Customer", role: "customer", password: "customer-pass-1" });
});

after(async () => {
  await app.close();
  await moon.close();
  await octo.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(backupDir, { recursive: true, force: true });
});

test("first-run setup creates the superadmin once", async () => {
  // users already exist from before(), so setup must refuse
  const r = await api("POST", "/api/setup", "", { username: "boss", password: "boss-password-1" });
  assert.equal(r.status, 409);
});

test("login per tier", async () => {
  const bad = await api("POST", "/api/auth/login", "", { username: "sam", password: "wrong-password" });
  assert.equal(bad.status, 401);
  staff = (await api("POST", "/api/auth/login", "", { username: "sam", password: "staff-password-1" })).body.token;
  viewer = (await api("POST", "/api/auth/login", "", { username: "cust", password: "customer-pass-1" })).body.token;
  assert.ok(staff && viewer);
  assert.equal((await api("GET", "/api/auth/me", staff)).body.user.role, "staff");
  assert.equal((await api("GET", "/api/parts", "")).status, 401);
});

test("staff cannot create users", async () => {
  const r = await api("POST", "/api/users", staff, { username: "x", role: "staff", password: "abcdefghijk" });
  assert.equal(r.status, 403, "staff cannot create users");
});

test("parts from the database, filtered by tier", async () => {
  const created = await api("POST", "/api/parts", staff, { internalName: "Test bracket", material: "PETG", category: "Test" });
  assert.equal(created.body.number, 1);
  const secret = await api("POST", "/api/parts", staff, { internalName: "Secret thing", material: "PETG", confidentiality: "NDA" });
  assert.equal(secret.body.number, 2);
  await api("PATCH", "/api/parts/1", staff, { confidentiality: "Public", publicName: "Bracket", publicDescription: "A test bracket.", listingReady: true, notes: "private note" });
  const staffList = (await api("GET", "/api/parts", staff)).body;
  assert.equal(staffList.length, 2);
  assert.equal(staffList[0].notes, "private note");
  const custList = (await api("GET", "/api/parts", viewer)).body;
  assert.equal(custList.length, 1);
  assert.equal(custList[0].notes, undefined);
  assert.equal(custList[0].internalName, undefined);
  assert.equal((await api("GET", "/api/parts/2", viewer)).status, 404);
});

let gcodeId = 0;
test("upload G-code to a part and read the Orca header", async () => {
  const form = new FormData();
  form.append("partFileVersion", "bracket-r3");
  form.append("file", new Blob([fs.readFileSync(path.join(here, "fixtures", "orca-sample.gcode"))]), "bracket.gcode");
  const res = await fetch(`${base}/api/parts/1/gcode`, { method: "POST", headers: { Authorization: `Bearer ${staff}` }, body: form });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.version, 1);
  assert.equal(body.slicer, "OrcaSlicer");
  assert.equal(body.slicerVersion, "2.3.1");
  assert.equal(body.printerModel, "Flashforge Adventurer 5M");
  assert.equal(body.estSeconds, 4325);
  assert.equal(body.filamentG, 15.4);
  assert.equal(body.partFileVersion, "bracket-r3");
  gcodeId = body.id;
  // same bytes again -> refused as a duplicate
  const form2 = new FormData();
  form2.append("file", new Blob([fs.readFileSync(path.join(here, "fixtures", "orca-sample.gcode"))]), "again.gcode");
  const dup = await fetch(`${base}/api/parts/1/gcode`, { method: "POST", headers: { Authorization: `Bearer ${staff}` }, body: form2 });
  assert.equal(dup.status, 409);
  // binary / wrong type refused
  const form3 = new FormData();
  form3.append("file", new Blob([Buffer.from([0, 1, 2, 3])]), "model.stl");
  assert.equal((await fetch(`${base}/api/parts/1/gcode`, { method: "POST", headers: { Authorization: `Bearer ${staff}` }, body: form3 })).status, 400);
});

let moonId = 0;
let octoId = 0;
let wrongId = 0;
test("admin adds printers by IP; staff cannot", async () => {
  // a superadmin straight in the DB, the same row the create-admin CLI writes
  const { hashPassword } = await import("../src/lib/auth.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path.join(dataDir, "hub.db"));
  raw.prepare("INSERT INTO users (username, display_name, role, password_hash) VALUES ('boss','Boss','superadmin',?)").run(hashPassword("boss-password-1"));
  raw.close();
  admin = (await api("POST", "/api/auth/login", "", { username: "boss", password: "boss-password-1" })).body.token;

  const denied = await api("POST", "/api/printers", staff, { name: "X", adapter: "moonraker", host: "127.0.0.1" });
  assert.equal(denied.status, 403);
  const badIp = await api("POST", "/api/printers", admin, { name: "Bad", adapter: "moonraker", host: "http://evil/path" });
  assert.equal(badIp.status, 400);

  const m = await api("POST", "/api/printers", admin, { name: "Bay 1", adapter: "moonraker", host: "127.0.0.1", port: moon.port, model: "Flashforge Adventurer 5M", nozzleMm: 0.4, bedX: 220, bedY: 220, bedZ: 220 });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  moonId = m.body.id;
  const o = await api("POST", "/api/printers", admin, { name: "Bay 2", adapter: "octoprint", host: "127.0.0.1", port: octo.port, model: "Flashforge Adventurer 5M", secret: { apiKey: "test-octo-key" } });
  octoId = o.body.id;
  assert.equal(o.body.secret, undefined, "secrets never come back");
  const w = await api("POST", "/api/printers", admin, { name: "Bay 3", adapter: "moonraker", host: "127.0.0.1", port: moon.port, model: "Elegoo Neptune 4 Pro", nozzleMm: 0.4, bedX: 235, bedY: 235, bedZ: 265 });
  wrongId = w.body.id;

  const t = await api("POST", `/api/printers/${moonId}/test`, staff);
  assert.equal(t.body.state, "idle");
  const t2 = await api("POST", `/api/printers/${octoId}/test`, staff);
  assert.equal(t2.body.state, "idle");
});

test("send flow: compatible printers, block on wrong model, send to Moonraker and OctoPrint", async () => {
  await api("POST", `/api/printers/${wrongId}/test`, staff);
  const list = (await api("GET", `/api/gcode/${gcodeId}/printers`, staff)).body as { printer: { id: number }; compatible: boolean }[];
  assert.equal(list.find((x) => x.printer.id === wrongId)?.compatible, false);
  assert.equal(list.find((x) => x.printer.id === moonId)?.compatible, true);

  const blocked = await api("POST", "/api/print/send", staff, { gcodeId, printerId: wrongId });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Sliced for/);

  const sent = await api("POST", "/api/print/send", staff, { gcodeId, printerId: moonId });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.match(sent.body.batchSku, /^1-\d{1,2}-\d{4}$/);
  assert.equal(moon.uploads.length, 1);
  assert.equal(moon.uploads[0].fields.print, "true");
  assert.ok(moon.uploads[0].bytes > 500);

  // printer is now busy -> second send is blocked
  const busy = await api("POST", "/api/print/send", staff, { gcodeId, printerId: moonId });
  assert.equal(busy.status, 409);

  const sent2 = await api("POST", "/api/print/send", staff, { gcodeId, printerId: octoId });
  assert.equal(sent2.status, 200, JSON.stringify(sent2.body));
  assert.match(sent2.body.batchSku, /^1-\d{1,2}-\d{4}-2$/, "repeat run same month gets -2");
  assert.equal(octo.uploads[0].fields.print, "true");

  const jobs = (await api("GET", "/api/print/jobs", staff)).body;
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].username, "sam");
});

test("audit trail, backup and pod-book import", async () => {
  const log = (await api("GET", "/api/audit", admin)).body as { action: string }[];
  const actions = new Set(log.map((l) => l.action));
  for (const a of ["auth.login", "part.created", "gcode.uploaded", "printer.created", "print.sent", "print.blocked"]) assert.ok(actions.has(a), a);
  assert.equal((await api("GET", "/api/audit", staff)).status, 403);

  const b = await api("POST", "/api/admin/backup", admin);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.ok(fs.existsSync(b.body.file));
  assert.equal(b.body.gcodeCopied, 1);

  const book = {
    v: 1, kind: "work", operator: "Day shift",
    parts: [{ number: 7, internalName: "Imported part", publicName: "", publicDescription: "", category: "Test", material: "PETG", status: "Stock", confidentiality: "Internal", listingReady: false, grams: 50, stockUnits: 3, reserved: 0, bin: "Z-1", lead: "", notes: "", fileVersion: "r1" }],
    batches: [{ sku: "7-9-2026", partNumber: 7, month: 9, year: 2026, printer: "Bay 9", material: "PETG", operator: "Day shift", qc: "Pass", fileVersion: "r1", profile: "", spool: "", notes: "" }],
    gtins: {}, bays: [{ id: "b9", name: "Bay 9", kind: "printer", ip: "192.168.1.90", port: 7125, link: "moonraker", buildX: 220, buildY: 220, buildZ: 250, nozzle: 0.4, x: 1, z: 2 }],
    jobs: [], deadlines: [], spools: [{ id: "S1", brand: "Generic", material: "PETG", grams: 900 }], log: [{ at: "2026-09-01T10:00:00Z", text: "Opened" }], columns: 3,
  };
  assert.equal((await api("POST", "/api/admin/import-book", staff, book)).status, 403);
  const imp = await api("POST", "/api/admin/import-book", admin, book);
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.parts, 1);
  assert.equal(imp.body.batches, 1);
  assert.equal(imp.body.printers, 1);
  assert.equal((await api("POST", "/api/admin/import-book", admin, { ...book, kind: "demo" })).status, 400);
});

test("health is public and minimal", async () => {
  const h = await api("GET", "/api/health", "");
  assert.equal(h.body.ok, true);
  assert.equal(h.body.db, "ok");
});
