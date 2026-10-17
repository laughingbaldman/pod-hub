import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { can, type Role } from "../lib/auth.js";
import { gtinError } from "../lib/sku.js";
import { HttpError, parseId, requirePerm, type Hub } from "../context.js";

interface PartRow {
  number: number;
  internal_name: string;
  public_name: string;
  public_description: string;
  category: string;
  material: string;
  status: string;
  confidentiality: string;
  listing_ready: number;
  grams: number;
  stock_units: number;
  reserved: number;
  bin: string;
  lead: string;
  notes: string;
  file_version: string;
  gtin: string | null;
  updated_at: string;
}

/** Allowlist per tier — never "everything except the secret fields". */
export function viewPart(row: PartRow, role: Role) {
  const publicView = { number: row.number, name: row.public_name, description: row.public_description, category: row.category, material: row.material, lead: row.lead };
  if (!can(role, "parts.internal")) return publicView;
  const internal = {
    ...publicView,
    internalName: row.internal_name,
    status: row.status,
    confidentiality: row.confidentiality,
    listingReady: Boolean(row.listing_ready),
    grams: row.grams,
    stockUnits: row.stock_units,
    reserved: row.reserved,
    bin: row.bin,
    fileVersion: row.file_version,
    gtin: row.gtin,
    updatedAt: row.updated_at,
  };
  if (!can(role, "parts.private")) return internal;
  return { ...internal, notes: row.notes };
}

function visibleWhere(role: Role): string {
  if (can(role, "parts.private")) return "1=1";
  if (can(role, "parts.internal")) return "confidentiality IN ('Public','Internal')";
  return "confidentiality = 'Public' AND listing_ready = 1 AND status <> 'Hold'";
}

const PATCH = z
  .object({
    internalName: z.string().min(1).max(200),
    publicName: z.string().max(200),
    publicDescription: z.string().max(2000),
    category: z.string().max(80),
    material: z.string().min(1).max(40),
    status: z.enum(["Draft", "Quoting", "Printing", "QC", "Stock", "Low", "Shipped", "Hold"]),
    confidentiality: z.enum(["Public", "Internal", "NDA", "Patent pending"]),
    listingReady: z.boolean(),
    grams: z.number().min(0).max(100000),
    stockUnits: z.number().int().min(0),
    reserved: z.number().int().min(0),
    bin: z.string().max(40),
    lead: z.string().max(120),
    notes: z.string().max(5000),
    fileVersion: z.string().max(120),
    gtin: z.string().max(14),
  })
  .partial();

const COLUMN: Record<string, string> = {
  internalName: "internal_name",
  publicName: "public_name",
  publicDescription: "public_description",
  category: "category",
  material: "material",
  status: "status",
  confidentiality: "confidentiality",
  listingReady: "listing_ready",
  grams: "grams",
  stockUnits: "stock_units",
  reserved: "reserved",
  bin: "bin",
  lead: "lead",
  notes: "notes",
  fileVersion: "file_version",
  gtin: "gtin",
};

export function partRoutes(app: FastifyInstance, hub: Hub) {
  const { db } = hub;

  app.get("/api/parts", async (req) => {
    const user = requirePerm(req, "parts.read");
    const q = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    let rows = db.prepare(`SELECT * FROM parts WHERE ${visibleWhere(user.role)} ORDER BY number`).all() as unknown as PartRow[];
    if (q.q) {
      const needle = q.q.toLowerCase();
      rows = rows.filter((r) => {
        const fields = can(user.role, "parts.internal") ? [r.internal_name, r.public_name, r.category, r.material, r.bin, String(r.number)] : [r.public_name, r.category, r.material, String(r.number)];
        return fields.some((f) => f.toLowerCase().includes(needle));
      });
    }
    return rows.map((r) => viewPart(r, user.role));
  });

  app.get("/api/parts/:n", async (req) => {
    const user = requirePerm(req, "parts.read");
    const n = parseId((req.params as { n: string }).n);
    const row = db.prepare(`SELECT * FROM parts WHERE number = ? AND ${visibleWhere(user.role)}`).get(n) as unknown as PartRow | undefined;
    if (!row) throw new HttpError(404, "No such part.");
    const part = viewPart(row, user.role);
    const batches = can(user.role, "parts.internal") ? db.prepare("SELECT * FROM batches WHERE part_number = ? ORDER BY created_at DESC").all(n) : [];
    return { part, batches };
  });

  app.post("/api/parts", async (req) => {
    const user = requirePerm(req, "parts.write");
    const body = z.object({ internalName: z.string().min(1).max(200), material: z.string().min(1).max(40), category: z.string().max(80).default(""), confidentiality: z.enum(["Public", "Internal", "NDA", "Patent pending"]).default("Internal") }).parse(req.body);
    // The part number is the next integer and never changes.
    const next = (db.prepare("SELECT coalesce(max(number), 0) + 1 AS n FROM parts").get() as { n: number }).n;
    db.prepare("INSERT INTO parts (number, internal_name, material, category, confidentiality) VALUES (?, ?, ?, ?, ?)").run(next, body.internalName, body.material, body.category, body.confidentiality);
    audit(db, user, "part.created", "part", next, body, req.ip);
    return { number: next };
  });

  app.patch("/api/parts/:n", async (req) => {
    const user = requirePerm(req, "parts.write");
    const n = parseId((req.params as { n: string }).n);
    const body = PATCH.parse(req.body);
    const row = db.prepare("SELECT * FROM parts WHERE number = ?").get(n) as unknown as PartRow | undefined;
    if (!row) throw new HttpError(404, "No such part.");
    if (body.gtin !== undefined && body.gtin !== "") {
      const err = gtinError(body.gtin);
      if (err) throw new HttpError(400, err);
    }
    const merged = { ...row, ...Object.fromEntries(Object.entries(body).map(([k, v]) => [COLUMN[k], typeof v === "boolean" ? (v ? 1 : 0) : v])) } as PartRow;
    if (merged.reserved > merged.stock_units) throw new HttpError(400, "Stock cannot drop below what is reserved.");
    if (merged.confidentiality !== "Public") merged.listing_ready = 0;
    if (merged.listing_ready && (!merged.public_name.trim() || !merged.public_description.trim())) throw new HttpError(400, "Listing-ready needs a public name and description.");
    if (merged.status === "Hold" && row.status === "Printing") throw new HttpError(400, "Finish or abort the plate before putting this part on Hold.");
    const sets = Object.values(COLUMN).map((c) => `${c} = ?`).join(", ");
    db.prepare(`UPDATE parts SET ${sets}, updated_at = ? WHERE number = ?`).run(...Object.values(COLUMN).map((c) => (merged as unknown as Record<string, string | number | null>)[c] ?? null), new Date().toISOString(), n);
    audit(db, user, "part.updated", "part", n, Object.keys(body), req.ip);
    return { ok: true };
  });

  app.get("/api/spools", async (req) => {
    requirePerm(req, "printers.read");
    return db.prepare("SELECT * FROM spools WHERE active = 1 ORDER BY id").all();
  });

  app.get("/api/batches", async (req) => {
    requirePerm(req, "parts.internal");
    return db.prepare("SELECT * FROM batches ORDER BY created_at DESC LIMIT 500").all();
  });
}
