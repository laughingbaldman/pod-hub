/**
 * Pre-send check: is this G-code file safe to send to this printer?
 *  - "block" findings can never be overridden (wrong model, nozzle, bed or height).
 *  - "warn" findings need an Admin override with a written reason, which is audited.
 */
export interface PrinterFacts {
  name: string;
  model: string;
  nozzleMm: number;
  bedX: number;
  bedY: number;
  bedZ: number;
  materials: string; // comma list, empty = any
  loadedMaterial: string | null;
  enabled: boolean;
  maintenanceReason: string | null;
  state: string; // adapter state: idle | printing | paused | error | offline | unknown
}

export interface FileFacts {
  printerModel: string | null;
  nozzleMm: number | null;
  bedX: number | null;
  bedY: number | null;
  maxZ: number | null;
  printableHeight: number | null;
  material: string | null;
  status: string;
}

export interface Finding {
  level: "block" | "warn";
  code: string;
  message: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const EPS = 0.5; // mm tolerance for bed size

export function modelsMatch(fileModel: string, printerModel: string): boolean {
  const a = norm(fileModel);
  const b = norm(printerModel);
  if (!a || !b) return true;
  return a === b || a.includes(b) || b.includes(a);
}

export function preflight(file: FileFacts, printer: PrinterFacts): Finding[] {
  const out: Finding[] = [];
  if (file.status !== "active") out.push({ level: "block", code: "file_retired", message: "This G-code version is retired." });
  if (!printer.enabled) out.push({ level: "block", code: "printer_disabled", message: `${printer.name} is disabled.` });
  if (printer.maintenanceReason) out.push({ level: "block", code: "printer_down", message: `${printer.name} is down: ${printer.maintenanceReason}` });

  if (file.printerModel && printer.model) {
    if (!modelsMatch(file.printerModel, printer.model)) {
      out.push({ level: "block", code: "model_mismatch", message: `Sliced for "${file.printerModel}", but ${printer.name} is a "${printer.model}".` });
    }
  } else {
    out.push({ level: "warn", code: "model_unknown", message: "Could not confirm the printer model from the file or the printer record." });
  }

  if (file.nozzleMm !== null) {
    if (Math.abs(file.nozzleMm - printer.nozzleMm) > 0.01) {
      out.push({ level: "block", code: "nozzle_mismatch", message: `Sliced for a ${file.nozzleMm} mm nozzle; ${printer.name} has ${printer.nozzleMm} mm.` });
    }
  } else {
    out.push({ level: "warn", code: "nozzle_unknown", message: "The file does not state a nozzle size." });
  }

  if (file.bedX !== null && file.bedY !== null) {
    if (file.bedX > printer.bedX + EPS || file.bedY > printer.bedY + EPS) {
      out.push({ level: "block", code: "bed_mismatch", message: `Sliced for a ${file.bedX}×${file.bedY} mm bed; ${printer.name} is ${printer.bedX}×${printer.bedY} mm.` });
    }
  }
  const height = file.maxZ ?? null;
  if (height !== null && height > printer.bedZ + EPS) {
    out.push({ level: "block", code: "too_tall", message: `The print is ${height} mm tall; ${printer.name} reaches ${printer.bedZ} mm.` });
  }

  if (file.material) {
    const allowed = printer.materials.split(",").map((m) => norm(m)).filter(Boolean);
    if (allowed.length && !allowed.includes(norm(file.material))) {
      out.push({ level: "warn", code: "material_not_allowed", message: `${printer.name} is not set up for ${file.material}.` });
    }
    if (printer.loadedMaterial && norm(printer.loadedMaterial) !== norm(file.material)) {
      out.push({ level: "warn", code: "spool_mismatch", message: `File wants ${file.material}; the loaded spool is ${printer.loadedMaterial}.` });
    }
  }

  if (printer.state !== "idle") {
    out.push({ level: "block", code: "printer_not_idle", message: `${printer.name} reports "${printer.state}", not idle.` });
  }
  return out;
}
