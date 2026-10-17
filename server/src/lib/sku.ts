// Ported unchanged from The Floor (src/lib/sku.ts).
/**
 * Batch identity for the floor.
 * The part number is permanent. The batch SKU is part-month-year,
 * dashed, with no zero-padding. A repeat run in the same month gets -2, -3…
 * Example: part 1 made in October 2026 is `1-10-2026`.
 * Pricing never lives here.
 */

export function batchSkuBase(partNumber: number, month: number, year: number): string {
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    throw new Error("Part number must be a positive integer.");
  }
  if (month < 1 || month > 12) throw new Error("Month is out of range.");
  return `${partNumber}-${month}-${year}`;
}

export function nextBatchSku(
  partNumber: number,
  month: number,
  year: number,
  existing: readonly string[],
): string {
  const base = batchSkuBase(partNumber, month, year);
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** GS1 mod-10 check digit for GTIN-8/12/13/14. Empty is allowed (UPC is optional). */
export function gtinError(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(s)) {
    return "UPC/GTIN must be 8, 12, 13, or 14 digits.";
  }
  const digits = s.split("").map(Number);
  const check = digits.pop() ?? 0;
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    sum += digits[i] * weight;
    weight = weight === 3 ? 1 : 3;
  }
  const calc = (10 - (sum % 10)) % 10;
  return calc === check ? null : "Check digit does not match.";
}
