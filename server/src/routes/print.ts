import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { can } from "../lib/auth.js";
import { tx } from "../lib/db.js";
import { preflight, type FileFacts, type Finding, type PrinterFacts } from "../lib/preflight.js";
import { nextBatchSku } from "../lib/sku.js";
import { adapterFor } from "../printers/index.js";
import { HttpError, parseId, requirePerm, type Hub } from "../context.js";
import { pollOne, printerView, targetFor, type PrinterRow } from "./printers.js";
import type { Db } from "../lib/db.js";

interface GcodeDbRow {
  id: number;
  part_number: number;
  version: number;
  part_file_version: string;
  original_name: string;
  storage_path: string;
  size_bytes: number;
  printer_model: string | null;
  nozzle_mm: number | null;
  bed_x: number | null;
  bed_y: number | null;
  max_z: number | null;
  material: string | null;
  slicer: string | null;
  slicer_version: string | null;
  status: string;
  meta_json: string | null;
}

function fileFacts(g: GcodeDbRow): FileFacts {
  return { printerModel: g.printer_model, nozzleMm: g.nozzle_mm, bedX: g.bed_x, bedY: g.bed_y, maxZ: g.max_z, printableHeight: null, material: g.material, status: g.status };
}

function printerFacts(db: Db, p: PrinterRow): PrinterFacts {
  const spool = p.loaded_spool ? (db.prepare("SELECT material FROM spools WHERE id = ?").get(p.loaded_spool) as { material: string } | undefined) : undefined;
  return {
    name: p.name,
    model: p.model,
    nozzleMm: p.nozzle_mm,
    bedX: p.bed_x,
    bedY: p.bed_y,
    bedZ: p.bed_z,
    materials: p.materials,
    loadedMaterial: spool?.material ?? null,
    enabled: Boolean(p.enabled),
    maintenanceReason: p.maintenance_reason,
    state: p.last_state,
  };
}

function getFile(db: Db, id: number): GcodeDbRow {
  const g = db.prepare("SELECT * FROM gcode_files WHERE id = ?").get(id) as unknown as GcodeDbRow | undefined;
  if (!g) throw new HttpError(404, "No such G-code file.");
  return g;
}

function getPrinter(db: Db, id: number): PrinterRow {
  const p = db.prepare("SELECT * FROM printers WHERE id = ?").get(id) as unknown as PrinterRow | undefined;
  if (!p) throw new HttpError(404, "No such printer.");
  return p;
}

export function printRoutes(app: FastifyInstance, hub: Hub) {
  const { db, cfg } = hub;

  // Step 3 of the send flow: which printers can take this file right now?
  app.get("/api/gcode/:id/printers", async (req) => {
    requirePerm(req, "print.send");
    const g = getFile(db, parseId((req.params as { id: string }).id));
    const printers = (db.prepare("SELECT * FROM printers WHERE kind = 'printer' ORDER BY name").all() as unknown as PrinterRow[]).map((p) => {
      const findings = preflight(fileFacts(g), printerFacts(db, p));
      const adapter = adapterFor(p.adapter);
      if (!adapter.implemented) findings.push({ level: "block", code: "no_network_send", message: `${adapter.label} cannot receive files from the Hub yet.` });
      return { printer: printerView(p), findings, compatible: !findings.some((f) => f.level === "block"), clean: findings.length === 0 };
    });
    printers.sort((a, b) => Number(b.clean) - Number(a.clean) || Number(b.compatible) - Number(a.compatible));
    return printers;
  });

  app.post("/api/print/check", async (req) => {
    requirePerm(req, "print.send");
    const body = z.object({ gcodeId: z.number().int(), printerId: z.number().int(), refresh: z.boolean().default(true) }).parse(req.body);
    const g = getFile(db, body.gcodeId);
    let p = getPrinter(db, body.printerId);
    if (body.refresh) {
      await pollOne(db, p);
      p = getPrinter(db, body.printerId);
    }
    return { findings: preflight(fileFacts(g), printerFacts(db, p)), printer: printerView(p) };
  });

  // Step 4: confirm and send. Re-checks on the server; the client's view is never trusted.
  app.post("/api/print/send", async (req) => {
    const user = requirePerm(req, "print.send");
    const body = z
      .object({
        gcodeId: z.number().int(),
        printerId: z.number().int(),
        batchSku: z.string().max(40).optional(), // add to an existing batch; omitted = new batch this month
        spoolId: z.string().max(60).optional(),
        overrideReason: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const g = getFile(db, body.gcodeId);
    await pollOne(db, getPrinter(db, body.printerId));
    const p = getPrinter(db, body.printerId);
    const adapter = adapterFor(p.adapter);
    const findings: Finding[] = preflight(fileFacts(g), printerFacts(db, p));
    if (!adapter.implemented) findings.push({ level: "block", code: "no_network_send", message: `${adapter.label} cannot receive files from the Hub yet.` });
    const blocks = findings.filter((f) => f.level === "block");
    const warns = findings.filter((f) => f.level === "warn");
    if (blocks.length) {
      audit(db, user, "print.blocked", "gcode", g.id, { printer: p.name, findings: blocks.map((f) => f.code) }, req.ip);
      throw new HttpError(409, blocks.map((f) => f.message).join(" "), { findings });
    }
    if (warns.length) {
      if (!body.overrideReason) throw new HttpError(409, "This send needs an Admin override with a reason.", { findings, needsOverride: true });
      if (!can(user.role, "print.override")) throw new HttpError(403, "Only an Admin can override these warnings.", { findings });
    }

    const now = new Date();
    const spoolId = body.spoolId ?? p.loaded_spool ?? null;
    const { jobId, sku } = tx(db, () => {
      let sku = body.batchSku;
      if (sku) {
        const b = db.prepare("SELECT part_number FROM batches WHERE sku = ?").get(sku) as { part_number: number } | undefined;
        if (!b || b.part_number !== g.part_number) throw new HttpError(400, "That batch belongs to another part.");
      } else {
        const month = now.getMonth() + 1;
        const year = now.getFullYear();
        const existing = (db.prepare("SELECT sku FROM batches WHERE part_number = ? AND month = ? AND year = ?").all(g.part_number, month, year) as { sku: string }[]).map((r) => r.sku);
        sku = nextBatchSku(g.part_number, month, year, existing);
        db.prepare("INSERT INTO batches (sku, part_number, month, year, printer, material, operator, file_version, profile, spool) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
          sku, g.part_number, month, year, p.name, g.material ?? "", user.displayName, g.part_file_version,
          `${g.slicer ?? "?"} ${g.slicer_version ?? ""} · gcode v${g.version}`.trim(), spoolId ?? "",
        );
      }
      const r = db
        .prepare("INSERT INTO print_jobs (gcode_id, printer_id, batch_sku, spool_id, user_id, state, override_reason) VALUES (?,?,?,?,?, 'uploading', ?)")
        .run(g.id, p.id, sku, spoolId, user.id, warns.length ? body.overrideReason! : null);
      return { jobId: Number(r.lastInsertRowid), sku };
    });

    const remoteBase = `p${g.part_number}-v${g.version}-${sku}.gcode`.replace(/[^\w.-]/g, "_");
    const filePath = path.join(cfg.dataDir, g.storage_path);
    if (!fs.existsSync(filePath)) throw new HttpError(500, "The stored file is missing. Restore it from backup.");
    try {
      const md5 = g.meta_json ? (JSON.parse(g.meta_json) as { md5?: string }).md5 : undefined;
      const result = await adapter.send(targetFor(db, p), { path: filePath, name: remoteBase, size: g.size_bytes, md5 });
      db.prepare("UPDATE print_jobs SET state = 'printing', remote_name = ?, started_at = ? WHERE id = ?").run(result.remoteName, new Date().toISOString(), jobId);
      db.prepare("UPDATE printers SET last_state = 'printing' WHERE id = ?").run(p.id);
      audit(db, user, "print.sent", "print_job", jobId, { printer: p.name, gcode: g.id, part: g.part_number, version: g.version, batch: sku, spool: spoolId, override: warns.length ? body.overrideReason : undefined }, req.ip);
      return { jobId, batchSku: sku, remoteName: result.remoteName, warnings: warns };
    } catch (error) {
      const message = (error as Error).message;
      db.prepare("UPDATE print_jobs SET state = 'failed', message = ?, ended_at = ? WHERE id = ?").run(message, new Date().toISOString(), jobId);
      audit(db, user, "print.send_failed", "print_job", jobId, { printer: p.name, message }, req.ip);
      throw new HttpError(502, `The printer did not take the file: ${message}`, { jobId });
    }
  });

  app.get("/api/print/jobs", async (req) => {
    requirePerm(req, "printers.read");
    return db
      .prepare(
        `SELECT j.*, p.name AS printer_name, g.part_number, g.version AS gcode_version, u.username
         FROM print_jobs j JOIN printers p ON p.id = j.printer_id JOIN gcode_files g ON g.id = j.gcode_id JOIN users u ON u.id = j.user_id
         ORDER BY j.id DESC LIMIT 200`,
      )
      .all();
  });
}

/** Background poller: refresh printer state and close out jobs that finished. */
export function startPoller(hub: Hub, log: (msg: string) => void): () => void {
  const { db, cfg } = hub;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows = db.prepare("SELECT * FROM printers WHERE enabled = 1 AND host <> '' AND kind = 'printer'").all() as unknown as PrinterRow[];
      await Promise.all(
        rows.map(async (p) => {
          const status = await pollOne(db, p);
          const job = db.prepare("SELECT id FROM print_jobs WHERE printer_id = ? AND state IN ('printing','paused') ORDER BY id DESC LIMIT 1").get(p.id) as { id: number } | undefined;
          if (!job) return;
          const now = new Date().toISOString();
          if (status.state === "paused") db.prepare("UPDATE print_jobs SET state = 'paused' WHERE id = ?").run(job.id);
          else if (status.state === "printing") db.prepare("UPDATE print_jobs SET state = 'printing' WHERE id = ?").run(job.id);
          else if (status.state === "idle") db.prepare("UPDATE print_jobs SET state = 'complete', ended_at = ? WHERE id = ?").run(now, job.id);
          else if (status.state === "error") db.prepare("UPDATE print_jobs SET state = 'failed', message = ?, ended_at = ? WHERE id = ?").run(status.message ?? "printer error", now, job.id);
        }),
      );
      hub.lastPollAt = new Date().toISOString();
    } catch (error) {
      log(`poller: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, cfg.pollSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
