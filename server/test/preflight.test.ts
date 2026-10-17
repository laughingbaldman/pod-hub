import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, modelsMatch, type FileFacts, type PrinterFacts } from "../src/lib/preflight.ts";

const file: FileFacts = { printerModel: "Flashforge Adventurer 5M", nozzleMm: 0.4, bedX: 220, bedY: 220, maxZ: 24, printableHeight: 220, material: "PETG", status: "active" };
const printer: PrinterFacts = { name: "Bay 1", model: "Flashforge Adventurer 5M", nozzleMm: 0.4, bedX: 220, bedY: 220, bedZ: 220, materials: "", loadedMaterial: "PETG", enabled: true, maintenanceReason: null, state: "idle" };
const codes = (f: ReturnType<typeof preflight>) => f.map((x) => `${x.level}:${x.code}`);

test("clean match has no findings", () => assert.deepEqual(preflight(file, printer), []));
test("blocks other model", () => assert.ok(codes(preflight(file, { ...printer, model: "Centauri Carbon" })).includes("block:model_mismatch")));
test("blocks other nozzle", () => assert.ok(codes(preflight(file, { ...printer, nozzleMm: 0.6 })).includes("block:nozzle_mismatch")));
test("blocks smaller bed", () => assert.ok(codes(preflight({ ...file, bedX: 256, bedY: 256 }, printer)).includes("block:bed_mismatch")));
test("blocks too tall", () => assert.ok(codes(preflight({ ...file, maxZ: 300 }, printer)).includes("block:too_tall")));
test("blocks busy printer", () => assert.ok(codes(preflight(file, { ...printer, state: "printing" })).includes("block:printer_not_idle")));
test("warns on spool mismatch", () => assert.deepEqual(codes(preflight(file, { ...printer, loadedMaterial: "PLA" })), ["warn:spool_mismatch"]));
test("warns when model unknown", () => assert.ok(codes(preflight({ ...file, printerModel: null }, printer)).includes("warn:model_unknown")));
test("model names tolerate punctuation and suffixes", () => {
  assert.ok(modelsMatch("Elegoo Neptune 4 Pro", "elegoo neptune-4 pro"));
  assert.ok(modelsMatch("Flashforge Adventurer 5M Pro", "Flashforge Adventurer 5M Pro"));
  assert.ok(!modelsMatch("Elegoo Centauri Carbon", "Flashforge AD5X"));
});
