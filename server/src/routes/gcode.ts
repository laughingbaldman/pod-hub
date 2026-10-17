import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { tx } from "../lib/db.js";
import { parseGcodeFile } from "../lib/gcode.js";
import { HttpError, parseId, requirePerm, type Hub } from "../context.js";

const ALLOWED_EXT = new Set([".gcode", ".gco", ".g"]);

export function gcodeRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    partNumber: r.part_number,
    version: r.version,
    partFileVersion: r.part_file_version,
    originalName: r.original_name,
    sha256: r.sha256,
    sizeBytes: r.size_bytes,
    slicer: r.slicer,
    slicerVersion: r.slicer_version,
    printerModel: r.printer_model,
    nozzleMm: r.nozzle_mm,
    material: r.material,
    layerHeight: r.layer_height,
    layers: r.layers,
    estSeconds: r.est_seconds,
    filamentG: r.filament_g,
    filamentMm: r.filament_mm,
    bedX: r.bed_x,
    bedY: r.bed_y,
    maxZ: r.max_z,
    status: r.status,
    notes: r.notes,
    uploadedBy: r.uploaded_by_name ?? r.uploaded_by,
    uploadedAt: r.uploaded_at,
  };
}

export function gcodeRoutes(app: FastifyInstance, hub: Hub) {
  const { db, cfg } = hub;
  const store = path.join(cfg.dataDir, "gcode");

  app.get("/api/parts/:n/gcode", async (req) => {
    requirePerm(req, "gcode.read");
    const n = parseId((req.params as { n: string }).n);
    const rows = db.prepare("SELECT g.*, u.username AS uploaded_by_name FROM gcode_files g LEFT JOIN users u ON u.id = g.uploaded_by WHERE part_number = ? ORDER BY version DESC").all(n);
    return rows.map((r) => gcodeRow(r as Record<string, unknown>));
  });

  // multipart: field "file" (+ optional fields partFileVersion, notes, before the file)
  app.post("/api/parts/:n/gcode", async (req) => {
    const user = requirePerm(req, "gcode.upload");
    const n = parseId((req.params as { n: string }).n);
    const part = db.prepare("SELECT number, file_version FROM parts WHERE number = ?").get(n) as { number: number; file_version: string } | undefined;
    if (!part) throw new HttpError(404, "No such part.");

    const fields: Record<string, string> = {};
    let tmp: string | null = null;
    let sha = "";
    let md5 = "";
    let size = 0;
    let originalName = "";
    for await (const item of req.parts()) {
      if (item.type === "field") {
        fields[item.fieldname] = String(item.value).slice(0, 500);
        continue;
      }
      if (item.fieldname !== "file" || tmp) {
        item.file.resume();
        continue;
      }
      originalName = path.basename(item.filename || "upload.gcode");
      if (!ALLOWED_EXT.has(path.extname(originalName).toLowerCase())) {
        item.file.resume();
        throw new HttpError(400, "Only plain G-code files (.gcode, .gco, .g) can be stored. Export plain G-code from the slicer.");
      }
      tmp = path.join(store, `.upload-${crypto.randomUUID()}`);
      const h = crypto.createHash("sha256");
      const m = crypto.createHash("md5");
      let sawNul = false;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          h.update(chunk);
          m.update(chunk);
          if (size < 65536 && chunk.subarray(0, 65536).includes(0)) sawNul = true;
          size += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(item.file, meter, fs.createWriteStream(tmp));
      if (item.file.truncated) {
        fs.rmSync(tmp, { force: true });
        throw new HttpError(413, `File is larger than ${cfg.maxUploadMb} MB.`);
      }
      if (sawNul) {
        fs.rmSync(tmp, { force: true });
        throw new HttpError(400, "That looks like a binary file, not G-code text.");
      }
      sha = h.digest("hex");
      md5 = m.digest("hex");
    }
    if (!tmp || size === 0) throw new HttpError(400, "Attach a G-code file.");

    const final = path.join(store, `${sha}.gcode`);
    if (fs.existsSync(final)) fs.rmSync(tmp, { force: true });
    else fs.renameSync(tmp, final);

    const dup = db.prepare("SELECT version FROM gcode_files WHERE part_number = ? AND sha256 = ?").get(n, sha) as { version: number } | undefined;
    if (dup) throw new HttpError(409, `This exact file is already saved as version ${dup.version} of part ${n}.`);

    const meta = parseGcodeFile(final);
    const id = tx(db, () => {
      const version = (db.prepare("SELECT coalesce(max(version), 0) + 1 AS v FROM gcode_files WHERE part_number = ?").get(n) as { v: number }).v;
      const r = db
        .prepare(
          `INSERT INTO gcode_files (part_number, version, part_file_version, original_name, sha256, size_bytes, storage_path, slicer, slicer_version,
            printer_model, nozzle_mm, material, layer_height, layers, est_seconds, filament_g, filament_mm, bed_x, bed_y, max_z, meta_json, notes, uploaded_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          n, version, fields.partFileVersion || part.file_version, originalName, sha, size, `gcode/${sha}.gcode`, meta.slicer, meta.slicerVersion,
          meta.printerModel, meta.nozzleMm, meta.material, meta.layerHeight, meta.layers, meta.estSeconds, meta.filamentG, meta.filamentMm,
          meta.bedX, meta.bedY, meta.maxZ ?? null, JSON.stringify({ ...meta, md5 }), fields.notes ?? "", user.id,
        );
      return Number(r.lastInsertRowid);
    });
    audit(db, user, "gcode.uploaded", "gcode", id, { part: n, sha256: sha, size, slicer: meta.slicer, slicerVersion: meta.slicerVersion, printerModel: meta.printerModel }, req.ip);
    return gcodeRow(db.prepare("SELECT * FROM gcode_files WHERE id = ?").get(id) as Record<string, unknown>);
  });

  app.patch("/api/gcode/:id", async (req) => {
    const user = requirePerm(req, "gcode.upload");
    const id = parseId((req.params as { id: string }).id);
    const body = z.object({ status: z.enum(["active", "retired"]).optional(), notes: z.string().max(2000).optional() }).parse(req.body);
    const r = db.prepare("UPDATE gcode_files SET status = coalesce(?, status), notes = coalesce(?, notes) WHERE id = ?").run(body.status ?? null, body.notes ?? null, id);
    if (!r.changes) throw new HttpError(404, "No such file.");
    audit(db, user, "gcode.updated", "gcode", id, body, req.ip);
    return { ok: true };
  });

  app.get("/api/gcode/:id/download", async (req, reply) => {
    const user = requirePerm(req, "gcode.read");
    const id = parseId((req.params as { id: string }).id);
    const row = db.prepare("SELECT * FROM gcode_files WHERE id = ?").get(id) as { storage_path: string; original_name: string; part_number: number; version: number } | undefined;
    if (!row) throw new HttpError(404, "No such file.");
    audit(db, user, "gcode.downloaded", "gcode", id, undefined, req.ip);
    const name = `part${row.part_number}-v${row.version}-${row.original_name}`.replace(/[^\w.-]/g, "_");
    reply.header("Content-Type", "text/x-gcode").header("Content-Disposition", `attachment; filename="${name}"`);
    return reply.send(fs.createReadStream(path.join(cfg.dataDir, row.storage_path)));
  });
}
