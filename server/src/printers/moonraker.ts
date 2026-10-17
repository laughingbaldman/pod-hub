/**
 * Klipper via Moonraker. Default port 7125; Elegoo Neptune 4 series exposes Moonraker on
 * port 80 through nginx. Docs: https://moonraker.readthedocs.io/en/latest/web_api/
 */
import fs from "node:fs";
import { AdapterError, baseUrl, fetchJson, UPLOAD_TIMEOUT_MS, type PrinterAdapter, type PrinterState, type PrinterTarget } from "./types.js";

function headers(t: PrinterTarget): Record<string, string> {
  return t.secret.apiKey ? { "X-Api-Key": t.secret.apiKey } : {};
}

interface QueryResult {
  result: {
    status: {
      print_stats?: { state?: string; filename?: string; info?: { current_layer?: number | null; total_layer?: number | null } };
      virtual_sdcard?: { progress?: number };
      extruder?: { temperature?: number };
      heater_bed?: { temperature?: number };
      webhooks?: { state?: string; state_message?: string };
    };
  };
}

const MAP: Record<string, PrinterState> = { standby: "idle", complete: "idle", cancelled: "idle", printing: "printing", paused: "paused", error: "error" };

export const moonraker: PrinterAdapter = {
  type: "moonraker",
  label: "Klipper / Moonraker",
  defaultPort: 7125,
  implemented: true,
  secretFields: [{ key: "apiKey", label: "API key (only if Moonraker requires one)", required: false }],

  async status(t) {
    const q = "print_stats&virtual_sdcard&extruder&heater_bed&webhooks";
    const data = await fetchJson<QueryResult>(`${baseUrl(t)}/printer/objects/query?${q}`, { headers: headers(t) });
    const s = data.result.status;
    if (s.webhooks?.state && s.webhooks.state !== "ready") {
      return { state: s.webhooks.state === "shutdown" || s.webhooks.state === "error" ? "error" : "busy", message: s.webhooks.state_message };
    }
    const raw = s.print_stats?.state ?? "standby";
    return {
      state: MAP[raw] ?? "unknown",
      progress: s.virtual_sdcard?.progress,
      file: s.print_stats?.filename || undefined,
      nozzleTemp: s.extruder?.temperature,
      bedTemp: s.heater_bed?.temperature,
      layer: s.print_stats?.info?.current_layer ?? undefined,
      totalLayers: s.print_stats?.info?.total_layer ?? undefined,
      message: raw === "complete" ? "Last print complete. Clear the plate." : undefined,
    };
  },

  async send(t, file) {
    const form = new FormData();
    form.append("root", "gcodes");
    form.append("print", "true");
    form.append("file", await fs.openAsBlob(file.path), file.name);
    const res = await fetchJson<{ result?: { item?: { path?: string }; print_started?: boolean }; item?: { path?: string }; print_started?: boolean }>(
      `${baseUrl(t)}/server/files/upload`,
      { method: "POST", body: form, headers: headers(t), timeoutMs: UPLOAD_TIMEOUT_MS },
    );
    const body = res.result ?? res;
    const remoteName = body.item?.path ?? file.name;
    if (body.print_started === false) {
      // Upload landed but Klipper did not start (busy?). Try an explicit start once.
      await fetchJson(`${baseUrl(t)}/printer/print/start?filename=${encodeURIComponent(remoteName)}`, { method: "POST", headers: headers(t) });
    }
    if (!remoteName) throw new AdapterError("Moonraker did not confirm the upload.");
    return { remoteName, started: true };
  },

  async pause(t) {
    await fetchJson(`${baseUrl(t)}/printer/print/pause`, { method: "POST", headers: headers(t) });
  },
  async resume(t) {
    await fetchJson(`${baseUrl(t)}/printer/print/resume`, { method: "POST", headers: headers(t) });
  },
  async cancel(t) {
    await fetchJson(`${baseUrl(t)}/printer/print/cancel`, { method: "POST", headers: headers(t) });
  },
};
