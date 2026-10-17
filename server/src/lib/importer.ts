/**
 * One-way importer for The Floor's browser book (localStorage key "pod-book-v1",
 * exported from Health → Export as JSON). Existing rows win; nothing is overwritten.
 */
import type { Db } from "./db.js";
import { tx } from "./db.js";

type Obj = Record<string, unknown>;
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

const PART_STATUS = new Set(["Draft", "Quoting", "Printing", "QC", "Stock", "Low", "Shipped", "Hold"]);
const FLAGS = new Set(["Public", "Internal", "NDA", "Patent pending"]);
const QC = new Set(["Pass", "Hold", "Fail", "Pending"]);
const LINK_TO_ADAPTER: Record<string, string> = { moonraker: "moonraker", octoprint: "octoprint", bambu: "bambu", http: "manual" };

export interface ImportReport {
  kind: string;
  parts: number;
  batches: number;
  spools: number;
  printers: number;
  queue: number;
  deadlines: number;
  log: number;
  skipped: string[];
}

export function importPodBook(db: Db, input: unknown, opts: { allowDemo?: boolean } = {}): ImportReport {
  if (!input || typeof input !== "object") throw new Error("Not a JSON object.");
  const book = input as Obj;
  if (book.v !== 1) throw new Error("This is not a pod-book-v1 export (v must be 1).");
  const kind = book.kind === "work" ? "work" : "demo";
  if (kind === "demo" && !opts.allowDemo) throw new Error("This export is the sample floor. Import it only with the demo option.");
  const arr = (k: string) => (Array.isArray(book[k]) ? (book[k] as Obj[]) : []);
  const gtins = (book.gtins && typeof book.gtins === "object" ? book.gtins : {}) as Record<string, unknown>;
  const report: ImportReport = { kind, parts: 0, batches: 0, spools: 0, printers: 0, queue: 0, deadlines: 0, log: 0, skipped: [] };

  tx(db, () => {
    const insPart = db.prepare(
      `INSERT OR IGNORE INTO parts (number, internal_name, public_name, public_description, category, material, status, confidentiality,
        listing_ready, grams, stock_units, reserved, bin, lead, notes, file_version, gtin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const p of arr("parts")) {
      const n = num(p.number);
      if (!Number.isInteger(n) || n < 1) {
        report.skipped.push(`part with bad number ${String(p.number)}`);
        continue;
      }
      const flag = FLAGS.has(str(p.confidentiality)) ? str(p.confidentiality) : "Internal";
      const r = insPart.run(
        n, str(p.internalName, 200) || `Part ${n}`, str(p.publicName, 200), str(p.publicDescription), str(p.category, 80),
        str(p.material, 40) || "Unknown", PART_STATUS.has(str(p.status)) ? str(p.status) : "Draft", flag,
        flag === "Public" && p.listingReady ? 1 : 0, Math.max(0, num(p.grams)), Math.max(0, Math.round(num(p.stockUnits))),
        Math.max(0, Math.round(num(p.reserved))), str(p.bin, 40), str(p.lead, 120), str(p.notes), str(p.fileVersion, 120),
        typeof gtins[String(n)] === "string" ? str(gtins[String(n)], 14) : null,
      );
      if (r.changes) report.parts++;
      else report.skipped.push(`part ${n} already exists`);
    }

    const insSpool = db.prepare("INSERT OR IGNORE INTO spools (id, brand, material, grams, nozzle_temp, bed_temp, flow, max_volumetric) VALUES (?,?,?,?,?,?,?,?)");
    for (const s of arr("spools")) {
      if (!str(s.id)) continue;
      const r = insSpool.run(str(s.id, 60), str(s.brand, 80), str(s.material, 40) || "Unknown", Math.max(0, num(s.grams)), num(s.nozzleTemp) || null, num(s.bedTemp) || null, num(s.flow) || null, num(s.maxVolumetric) || null);
      if (r.changes) report.spools++;
    }

    const insBatch = db.prepare(
      `INSERT OR IGNORE INTO batches (sku, part_number, month, year, printer, material, operator, qc, file_version, profile, spool, notes)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM parts WHERE number = ?)`,
    );
    for (const b of arr("batches")) {
      const sku = str(b.sku, 40);
      if (!/^\d+-\d{1,2}-\d{4}(-\d+)?$/.test(sku)) {
        report.skipped.push(`batch with bad SKU "${sku}"`);
        continue;
      }
      const r = insBatch.run(sku, num(b.partNumber), num(b.month), num(b.year), str(b.printer, 80), str(b.material, 40), str(b.operator, 80),
        QC.has(str(b.qc)) ? str(b.qc) : "Pending", str(b.fileVersion, 120), str(b.profile, 120), str(b.spool, 60), str(b.notes), num(b.partNumber));
      if (r.changes) report.batches++;
      else report.skipped.push(`batch ${sku} exists or its part is missing`);
    }

    const insPrinter = db.prepare(
      `INSERT OR IGNORE INTO printers (name, kind, adapter, host, port, nozzle_mm, bed_x, bed_y, bed_z, map_x, map_y, maintenance_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const bay of arr("bays")) {
      const name = str(bay.name, 80) || str(bay.id, 80);
      if (!name) continue;
      const scanner = bay.kind === "scanner";
      const r = insPrinter.run(name, scanner ? "scanner" : "printer", scanner ? "manual" : (LINK_TO_ADAPTER[str(bay.link)] ?? "manual"), str(bay.ip, 80),
        Math.round(num(bay.port, 7125)), num(bay.nozzle, 0.4), num(bay.buildX, 256), num(bay.buildY, 256), num(bay.buildZ, 256), num(bay.x), num(bay.z),
        typeof bay.downReason === "string" && bay.downReason ? str(bay.downReason, 200) : null);
      if (r.changes) report.printers++;
    }

    const insQueue = db.prepare("INSERT OR IGNORE INTO queue_items (id, kind, title, owner, due, part_number, account, done) SELECT ?,?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM parts WHERE number = ?)");
    for (const j of arr("jobs")) {
      const pn = typeof j.partNumber === "number" ? j.partNumber : null;
      const r = insQueue.run(str(j.id, 60) || crypto.randomUUID(), str(j.kind, 20), str(j.title, 200), str(j.owner, 80), str(j.due, 40) || null, pn, str(j.account, 120), j.done ? 1 : 0, pn, pn);
      if (r.changes) report.queue++;
    }
    const insDeadline = db.prepare("INSERT OR IGNORE INTO deadlines (id, title, owner, due, filed) VALUES (?,?,?,?,?)");
    for (const d of arr("deadlines")) {
      const r = insDeadline.run(str(d.id, 60) || crypto.randomUUID(), str(d.title, 200), str(d.owner, 80), str(d.due, 40) || null, d.filed ? 1 : 0);
      if (r.changes) report.deadlines++;
    }
    const insLog = db.prepare("INSERT INTO shift_log (at, text) VALUES (?, ?)");
    for (const l of arr("log")) {
      if (!str(l.at) || !str(l.text)) continue;
      insLog.run(str(l.at, 40), str(l.text));
      report.log++;
    }
  });
  return report;
}
