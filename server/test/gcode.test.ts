import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDuration, parseGcodeFile, parseArea } from "../src/lib/gcode.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("parses an OrcaSlicer file", () => {
  const m = parseGcodeFile(path.join(here, "fixtures", "orca-sample.gcode"));
  assert.equal(m.slicer, "OrcaSlicer");
  assert.equal(m.slicerVersion, "2.3.1");
  assert.equal(m.printerModel, "Flashforge Adventurer 5M");
  assert.equal(m.nozzleMm, 0.4);
  assert.equal(m.material, "PETG");
  assert.equal(m.layers, 120);
  assert.equal(m.estSeconds, 3600 + 12 * 60 + 5);
  assert.equal(m.filamentG, 15.4);
  assert.equal(m.filamentMm, 5123.45);
  assert.equal(m.bedX, 220);
  assert.equal(m.bedY, 220);
  assert.equal(m.maxZ, 24);
  assert.equal(m.layerHeight, 0.2);
  assert.equal(m.filamentSettingsId, "Generic PETG @FF AD5M");
});

test("parses a Bambu-style header", () => {
  const m = parseGcodeFile(path.join(here, "fixtures", "bambu-header.gcode"));
  assert.equal(m.slicer, "BambuStudio");
  assert.equal(m.estSeconds, 48 * 60 + 41);
  assert.equal(m.layers, 40);
  assert.equal(m.filamentG, 11.46);
  assert.equal(m.filamentMm, 3811.55);
  assert.equal(m.bedX, 256);
  assert.equal(m.material, "PLA");
  assert.equal(m.printerModel, "Bambu Lab X1 Carbon");
});

test("durations and areas", () => {
  assert.equal(parseDuration("1d 2h 3m 4s"), 93784);
  assert.equal(parseDuration("23m 46s"), 1426);
  assert.equal(parseDuration("3600"), 3600);
  assert.equal(parseDuration("soon"), null);
  assert.deepEqual(parseArea("0x0,300x0,300x300,0x300"), { x: 300, y: 300 });
  assert.equal(parseArea("garbage"), null);
});
