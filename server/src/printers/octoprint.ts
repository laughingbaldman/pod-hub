/**
 * OctoPrint REST API (default port 80; 5000 when run by hand).
 * Docs: https://docs.octoprint.org/en/master/api/files.html and /api/job.html
 */
import fs from "node:fs";
import { AdapterError, baseUrl, fetchJson, UPLOAD_TIMEOUT_MS, type PrinterAdapter, type PrinterState, type PrinterTarget } from "./types.js";

function headers(t: PrinterTarget): Record<string, string> {
  if (!t.secret.apiKey) throw new AdapterError("OctoPrint needs an API key (Settings → API, or an Application Key).");
  return { "X-Api-Key": t.secret.apiKey };
}

interface JobResult {
  state?: string;
  job?: { file?: { name?: string | null } };
  progress?: { completion?: number | null; printTimeLeft?: number | null };
}

function mapState(text: string | undefined): PrinterState {
  const s = (text ?? "").toLowerCase();
  if (s.startsWith("operational")) return "idle";
  if (s.startsWith("printing") || s.startsWith("starting") || s.startsWith("sending")) return "printing";
  if (s.startsWith("paus")) return "paused";
  if (s.startsWith("offline") || s.startsWith("closed")) return "offline";
  if (s.includes("error")) return "error";
  if (s.startsWith("cancelling") || s.startsWith("finishing") || s.startsWith("connecting")) return "busy";
  return "unknown";
}

export const octoprint: PrinterAdapter = {
  type: "octoprint",
  label: "OctoPrint",
  defaultPort: 80,
  implemented: true,
  secretFields: [{ key: "apiKey", label: "API key", required: true }],

  async status(t) {
    const job = await fetchJson<JobResult>(`${baseUrl(t)}/api/job`, { headers: headers(t) });
    const state = mapState(job.state);
    const out = {
      state,
      file: job.job?.file?.name ?? undefined,
      progress: typeof job.progress?.completion === "number" ? job.progress.completion / 100 : undefined,
      remainingSeconds: job.progress?.printTimeLeft ?? undefined,
      message: state === "offline" ? "OctoPrint is up but not connected to the printer." : undefined,
    } as Awaited<ReturnType<PrinterAdapter["status"]>>;
    if (state !== "offline") {
      try {
        const p = await fetchJson<{ temperature?: { tool0?: { actual?: number }; bed?: { actual?: number } } }>(`${baseUrl(t)}/api/printer?exclude=sd,state`, { headers: headers(t) });
        out.nozzleTemp = p.temperature?.tool0?.actual;
        out.bedTemp = p.temperature?.bed?.actual;
      } catch {
        /* temperatures are optional */
      }
    }
    return out;
  },

  async send(t, file) {
    const form = new FormData();
    form.append("file", await fs.openAsBlob(file.path), file.name);
    form.append("select", "true");
    form.append("print", "true");
    const res = await fetchJson<{ done?: boolean; files?: { local?: { name?: string; path?: string } } }>(`${baseUrl(t)}/api/files/local`, {
      method: "POST",
      body: form,
      headers: headers(t),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    const remoteName = res.files?.local?.path ?? res.files?.local?.name ?? file.name;
    return { remoteName, started: true };
  },

  async pause(t) {
    await fetchJson(`${baseUrl(t)}/api/job`, { method: "POST", headers: { ...headers(t), "Content-Type": "application/json" }, body: JSON.stringify({ command: "pause", action: "pause" }) });
  },
  async resume(t) {
    await fetchJson(`${baseUrl(t)}/api/job`, { method: "POST", headers: { ...headers(t), "Content-Type": "application/json" }, body: JSON.stringify({ command: "pause", action: "resume" }) });
  },
  async cancel(t) {
    await fetchJson(`${baseUrl(t)}/api/job`, { method: "POST", headers: { ...headers(t), "Content-Type": "application/json" }, body: JSON.stringify({ command: "cancel" }) });
  },
};
