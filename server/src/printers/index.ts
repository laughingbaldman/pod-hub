import { flashforge } from "./flashforge.js";
import { moonraker } from "./moonraker.js";
import { octoprint } from "./octoprint.js";
import { sdcp } from "./sdcp.js";
import { bambu, manual } from "./stubs.js";
import type { PrinterAdapter } from "./types.js";

/** Register a new printer family here. Nothing else in the server needs to change. */
export const ADAPTERS: Record<string, PrinterAdapter> = Object.fromEntries(
  [moonraker, octoprint, flashforge, sdcp, bambu, manual].map((a) => [a.type, a]),
);

export function adapterFor(type: string): PrinterAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`Unknown printer type "${type}"`);
  return adapter;
}

export * from "./types.js";
