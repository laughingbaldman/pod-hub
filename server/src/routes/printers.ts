import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { adapterFor, ADAPTERS, type PrinterStatus, type PrinterTarget } from "../printers/index.js";
import { HttpError, parseId, requirePerm, type Hub } from "../context.js";
import type { Db } from "../lib/db.js";

export interface PrinterRow {
  id: number;
  name: string;
  kind: string;
  adapter: string;
  host: string;
  port: number;
  model: string;
  nozzle_mm: number;
  bed_x: number;
  bed_y: number;
  bed_z: number;
  materials: string;
  loaded_spool: string | null;
  map_x: number;
  map_y: number;
  zone: string;
  confidential: number;
  enabled: number;
  maintenance_reason: string | null;
  last_state: string;
  last_status: string | null;
  last_seen_at: string | null;
}

export function printerView(r: PrinterRow) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    adapter: r.adapter,
    host: r.host,
    port: r.port,
    model: r.model,
    nozzleMm: r.nozzle_mm,
    bedX: r.bed_x,
    bedY: r.bed_y,
    bedZ: r.bed_z,
    materials: r.materials,
    loadedSpool: r.loaded_spool,
    mapX: r.map_x,
    mapY: r.map_y,
    zone: r.zone,
    confidential: Boolean(r.confidential),
    enabled: Boolean(r.enabled),
    maintenanceReason: r.maintenance_reason,
    state: r.last_state,
    status: r.last_status ? (JSON.parse(r.last_status) as PrinterStatus) : null,
    lastSeenAt: r.last_seen_at,
  };
}

export function targetFor(db: Db, row: PrinterRow): PrinterTarget {
  const s = db.prepare("SELECT secret FROM printer_secrets WHERE printer_id = ?").get(row.id) as { secret: string } | undefined;
  return { host: row.host, port: row.port, model: row.model, secret: s ? (JSON.parse(s.secret) as Record<string, string>) : {} };
}

/** Accept IPv4, IPv6 or a LAN hostname. No URLs, no paths. */
const HOST = z
  .string()
  .trim()
  .max(253)
  .refine((h) => /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || /^[0-9a-f:]+$/i.test(h) || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h), "Enter an IP address like 192.168.1.50 or a hostname.");

const BASE = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["printer", "scanner"]).default("printer"),
  adapter: z.string().refine((a) => a in ADAPTERS, "Unknown printer type."),
  host: HOST,
  port: z.number().int().min(1).max(65535).optional(),
  model: z.string().max(120).default(""),
  nozzleMm: z.number().min(0.1).max(2).default(0.4),
  bedX: z.number().min(10).max(2000).default(256),
  bedY: z.number().min(10).max(2000).default(256),
  bedZ: z.number().min(10).max(2000).default(256),
  materials: z.string().max(300).default(""),
  loadedSpool: z.string().max(60).nullable().default(null),
  mapX: z.number().default(0),
  mapY: z.number().default(0),
  zone: z.string().max(60).default(""),
  confidential: z.boolean().default(false),
  enabled: z.boolean().default(true),
  maintenanceReason: z.string().max(200).nullable().default(null),
  secret: z.record(z.string(), z.string().max(500)).optional(),
});

export async function pollOne(db: Db, row: PrinterRow): Promise<PrinterStatus> {
  const adapter = adapterFor(row.adapter);
  let status: PrinterStatus;
  if (!row.host || !adapter.implemented) status = await adapter.status(targetFor(db, row)).catch(() => ({ state: "unknown" as const }));
  else {
    try {
      status = await adapter.status(targetFor(db, row));
    } catch (error) {
      status = { state: "offline", message: (error as Error).message };
    }
  }
  db.prepare("UPDATE printers SET last_state = ?, last_status = ?, last_seen_at = CASE WHEN ? <> 'offline' THEN ? ELSE last_seen_at END WHERE id = ?").run(
    status.state,
    JSON.stringify(status),
    status.state,
    new Date().toISOString(),
    row.id,
  );
  return status;
}

export function printerRoutes(app: FastifyInstance, hub: Hub) {
  const { db } = hub;

  app.get("/api/printer-types", async (req) => {
    requirePerm(req, "printers.read");
    return Object.values(ADAPTERS).map((a) => ({ type: a.type, label: a.label, defaultPort: a.defaultPort, implemented: a.implemented, secretFields: a.secretFields }));
  });

  app.get("/api/printers", async (req) => {
    requirePerm(req, "printers.read");
    return (db.prepare("SELECT * FROM printers ORDER BY name").all() as unknown as PrinterRow[]).map(printerView);
  });

  app.post("/api/printers", async (req) => {
    const user = requirePerm(req, "printers.manage");
    const b = BASE.parse(req.body);
    const port = b.port ?? adapterFor(b.adapter).defaultPort;
    let id: number;
    try {
      id = Number(
        db
          .prepare(
            `INSERT INTO printers (name, kind, adapter, host, port, model, nozzle_mm, bed_x, bed_y, bed_z, materials, loaded_spool, map_x, map_y, zone, confidential, enabled, maintenance_reason)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(b.name, b.kind, b.adapter, b.host, port, b.model, b.nozzleMm, b.bedX, b.bedY, b.bedZ, b.materials, b.loadedSpool, b.mapX, b.mapY, b.zone, b.confidential ? 1 : 0, b.enabled ? 1 : 0, b.maintenanceReason).lastInsertRowid,
      );
    } catch (error) {
      throw new HttpError(400, String(error).includes("UNIQUE") ? "A printer with that name exists." : String(error));
    }
    if (b.secret && Object.keys(b.secret).length) db.prepare("INSERT INTO printer_secrets (printer_id, secret) VALUES (?, ?)").run(id, JSON.stringify(b.secret));
    audit(db, user, "printer.created", "printer", id, { name: b.name, adapter: b.adapter, host: b.host, port }, req.ip);
    return printerView(db.prepare("SELECT * FROM printers WHERE id = ?").get(id) as unknown as PrinterRow);
  });

  app.patch("/api/printers/:id", async (req) => {
    const user = requirePerm(req, "printers.manage");
    const id = parseId((req.params as { id: string }).id);
    const row = db.prepare("SELECT * FROM printers WHERE id = ?").get(id) as unknown as PrinterRow | undefined;
    if (!row) throw new HttpError(404, "No such printer.");
    const b = BASE.partial().parse(req.body);
    const merged = { ...printerView(row), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } as ReturnType<typeof printerView>;
    db.prepare(
      `UPDATE printers SET name=?, kind=?, adapter=?, host=?, port=?, model=?, nozzle_mm=?, bed_x=?, bed_y=?, bed_z=?, materials=?, loaded_spool=?, map_x=?, map_y=?, zone=?, confidential=?, enabled=?, maintenance_reason=? WHERE id=?`,
    ).run(merged.name, merged.kind, merged.adapter, merged.host, merged.port, merged.model, merged.nozzleMm, merged.bedX, merged.bedY, merged.bedZ, merged.materials, merged.loadedSpool, merged.mapX, merged.mapY, merged.zone, merged.confidential ? 1 : 0, merged.enabled ? 1 : 0, merged.maintenanceReason, id);
    if (b.secret) db.prepare("INSERT INTO printer_secrets (printer_id, secret) VALUES (?, ?) ON CONFLICT(printer_id) DO UPDATE SET secret = excluded.secret").run(id, JSON.stringify(b.secret));
    audit(db, user, "printer.updated", "printer", id, { fields: Object.keys(b).filter((k) => k !== "secret"), secretChanged: Boolean(b.secret) }, req.ip);
    return printerView(db.prepare("SELECT * FROM printers WHERE id = ?").get(id) as unknown as PrinterRow);
  });

  // "Check connection" — asks from the Hub server, which sits on the shop LAN.
  app.post("/api/printers/:id/test", async (req) => {
    requirePerm(req, "printers.read");
    const id = parseId((req.params as { id: string }).id);
    const row = db.prepare("SELECT * FROM printers WHERE id = ?").get(id) as unknown as PrinterRow | undefined;
    if (!row) throw new HttpError(404, "No such printer.");
    return pollOne(db, row);
  });

  app.post("/api/printers/:id/:action", async (req) => {
    const user = requirePerm(req, "print.send");
    const { id: rawId, action } = req.params as { id: string; action: string };
    if (!["pause", "resume", "cancel"].includes(action)) throw new HttpError(404, "Unknown action.");
    const id = parseId(rawId);
    const row = db.prepare("SELECT * FROM printers WHERE id = ?").get(id) as unknown as PrinterRow | undefined;
    if (!row) throw new HttpError(404, "No such printer.");
    const adapter = adapterFor(row.adapter);
    const fn = adapter[action as "pause" | "resume" | "cancel"];
    if (!fn) throw new HttpError(400, `${adapter.label} cannot ${action} from the Hub.`);
    await fn(targetFor(db, row));
    audit(db, user, `printer.${action}`, "printer", id, undefined, req.ip);
    if (action === "cancel") db.prepare("UPDATE print_jobs SET state = 'cancelled', ended_at = ? WHERE printer_id = ? AND state IN ('uploading','printing','paused')").run(new Date().toISOString(), id);
    return { ok: true };
  });
}
