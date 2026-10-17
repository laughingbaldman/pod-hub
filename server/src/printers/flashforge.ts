/**
 * FlashForge Adventurer 5M / 5M Pro / AD5X LAN HTTP API on port 8898 (best effort, untested on hardware).
 * Auth is the printer's serial number + check code from its settings screen.
 * Source: community docs https://github.com/Parallel-7/flashforge-api-docs (HTTP-REST-API wiki).
 * The printer always answers HTTP 200; success is { code: 0 } in the body.
 */
import fs from "node:fs";
import { AdapterError, baseUrl, fetchJson, UPLOAD_TIMEOUT_MS, type PrinterAdapter, type PrinterState, type PrinterTarget } from "./types.js";

function creds(t: PrinterTarget) {
  const { serialNumber, checkCode } = t.secret;
  if (!serialNumber || !checkCode) throw new AdapterError("FlashForge needs the serial number and check code from the printer's network settings.");
  return { serialNumber, checkCode };
}

function ok(res: { code?: number; message?: string }, what: string) {
  if (res.code !== 0) throw new AdapterError(`FlashForge ${what} failed: ${res.message ?? `code ${res.code}`}`);
}

const MAP: Record<string, PrinterState> = {
  ready: "idle",
  completed: "idle",
  cancel: "idle",
  printing: "printing",
  heating: "printing",
  pause: "paused",
  pausing: "paused",
  error: "error",
};

interface Detail {
  code?: number;
  message?: string;
  detail?: {
    status?: string;
    printProgress?: number;
    printFileName?: string;
    rightTemp?: number;
    platTemp?: number;
    printLayer?: number;
    targetPrintLayer?: number;
    estimatedTime?: number;
    errorCode?: string;
  };
}

async function post<T>(t: PrinterTarget, path: string, body: Record<string, unknown>): Promise<T> {
  return fetchJson<T>(`${baseUrl(t)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...creds(t), ...body }) });
}

async function jobControl(t: PrinterTarget, action: "pause" | "continue" | "cancel") {
  ok(await post<{ code?: number; message?: string }>(t, "/control", { payload: { cmd: "jobCtl_cmd", args: { jobID: "", action } } }), action);
}

export const flashforge: PrinterAdapter = {
  type: "flashforge",
  label: "FlashForge (5M / AD5X HTTP)",
  defaultPort: 8898,
  implemented: true,
  secretFields: [
    { key: "serialNumber", label: "Serial number", required: true },
    { key: "checkCode", label: "Check code", required: true },
  ],

  async status(t) {
    const res = await post<Detail>(t, "/detail", {});
    ok(res, "status");
    const d = res.detail ?? {};
    return {
      state: MAP[d.status ?? ""] ?? "busy", // unknown values: treat as busy, keep polling
      progress: d.printProgress,
      file: d.printFileName || undefined,
      nozzleTemp: d.rightTemp,
      bedTemp: d.platTemp,
      layer: d.printLayer,
      totalLayers: d.targetPrintLayer,
      remainingSeconds: d.estimatedTime || undefined,
      message: d.errorCode || (d.status === "completed" ? "Print complete. Clear the plate on the printer." : undefined),
    };
  },

  async send(t, file) {
    const { serialNumber, checkCode } = creds(t);
    const form = new FormData();
    form.append("gcodeFile", await fs.openAsBlob(file.path), file.name);
    const res = await fetchJson<{ code?: number; message?: string }>(`${baseUrl(t)}/uploadGcode`, {
      method: "POST",
      body: form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      headers: {
        serialNumber,
        checkCode,
        fileSize: String(file.size),
        printNow: "true",
        levelingBeforePrint: "true",
      },
    });
    ok(res, "upload");
    return { remoteName: file.name, started: true };
  },

  pause: (t) => jobControl(t, "pause"),
  resume: (t) => jobControl(t, "continue"),
  cancel: (t) => jobControl(t, "cancel"),
};
