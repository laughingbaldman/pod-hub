/**
 * Elegoo Centauri Carbon (SDCP v3 over WebSocket, port 3030). Best effort, untested on hardware.
 * Control: ws://host:3030/websocket, JSON frames, no auth. Upload: HTTP multipart
 * POST /uploadFile/upload in 1 MiB chunks, each carrying the whole-file MD5.
 * Sources: https://docs.opencentauri.cc/software/api/ , https://github.com/bjan/pycentauri (docs/PROTOCOL.md)
 * Note: the newer Centauri Carbon 2 uses a different upload (PUT /upload + token); not covered here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { AdapterError, baseUrl, TIMEOUT_MS, type PrinterAdapter, type PrinterState, type PrinterTarget } from "./types.js";

const CHUNK = 1024 * 1024;

type Frame = Record<string, any>;

/** Open the socket, run fn, close. Each call is short-lived so a stuck socket never pins a print. */
async function withSocket<T>(t: PrinterTarget, fn: (send: (cmd: number, data?: object) => string, next: (match: (f: Frame) => boolean) => Promise<Frame>, mainboard: () => string) => Promise<T>): Promise<T> {
  const host = t.host.includes(":") && !t.host.startsWith("[") ? `[${t.host}]` : t.host;
  const ws = new WebSocket(`ws://${host}:${t.port}/websocket`);
  const frames: Frame[] = [];
  const waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  let mainboardId = t.secret.mainboardId ?? "";
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string" || ev.data === "pong") return;
    let frame: Frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    mainboardId ||= frame.MainboardID ?? frame.Data?.MainboardID ?? frame.Attributes?.MainboardID ?? "";
    const i = waiters.findIndex((w) => w.match(frame));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(frame);
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AdapterError(`No SDCP answer from ${t.host}:${t.port}`)), TIMEOUT_MS);
    ws.addEventListener("open", () => (clearTimeout(timer), resolve()));
    ws.addEventListener("error", () => (clearTimeout(timer), reject(new AdapterError(`Could not open SDCP socket on ${t.host}:${t.port}`))));
  });
  const send = (cmd: number, data: object = {}) => {
    const requestId = crypto.randomUUID().replace(/-/g, "");
    ws.send(
      JSON.stringify({
        Id: crypto.randomUUID().replace(/-/g, ""),
        Data: { Cmd: cmd, Data: data, RequestID: requestId, MainboardID: mainboardId, TimeStamp: Math.floor(Date.now() / 1000), From: 0 },
        Topic: `sdcp/request/${mainboardId}`,
      }),
    );
    return requestId;
  };
  const next = (match: (f: Frame) => boolean) =>
    new Promise<Frame>((resolve, reject) => {
      const i = frames.findIndex(match);
      if (i >= 0) return resolve(frames.splice(i, 1)[0]);
      const timer = setTimeout(() => reject(new AdapterError("SDCP printer did not answer in time.")), TIMEOUT_MS);
      waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  try {
    return await fn(send, next, () => mainboardId);
  } finally {
    ws.close();
  }
}

function statusOf(frame: Frame): Frame | null {
  return frame.Status ?? frame.Data?.Status ?? null;
}

function mapStatus(s: Frame): PrinterState {
  const current: number[] = Array.isArray(s.CurrentStatus) ? s.CurrentStatus : [s.CurrentStatus];
  const printStatus = s.PrintInfo?.Status;
  if (printStatus === 5 || printStatus === 6) return "paused";
  if (current.includes(1)) return "printing";
  if (current.includes(2) || current.includes(3) || current.includes(4)) return "busy";
  if (current.includes(0)) return "idle";
  return "unknown";
}

export const sdcp: PrinterAdapter = {
  type: "sdcp",
  label: "Elegoo Centauri (SDCP)",
  defaultPort: 3030,
  implemented: true,
  secretFields: [{ key: "mainboardId", label: "Mainboard ID (optional, learned automatically)", required: false }],

  async status(t) {
    return withSocket(t, async (send, next) => {
      send(0);
      const frame = await next((f) => statusOf(f) !== null);
      const s = statusOf(frame)!;
      const info = s.PrintInfo ?? {};
      const total = Number(info.TotalTicks) || 0;
      return {
        state: mapStatus(s),
        progress: info.TotalLayer ? info.CurrentLayer / info.TotalLayer : undefined,
        file: info.Filename || undefined,
        nozzleTemp: s.TempOfNozzle,
        bedTemp: s.TempOfHotbed,
        layer: info.CurrentLayer,
        totalLayers: info.TotalLayer,
        remainingSeconds: total ? Math.max(0, total - (Number(info.CurrentTicks) || 0)) : undefined,
        message: info.ErrorNumber ? `Printer error ${info.ErrorNumber}` : undefined,
      };
    });
  },

  async send(t, file) {
    const md5 = file.md5 ?? crypto.createHash("md5").update(fs.readFileSync(file.path)).digest("hex");
    const uuid = crypto.randomUUID().replace(/-/g, "");
    const fd = fs.openSync(file.path, "r");
    try {
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        const buf = Buffer.alloc(Math.min(CHUNK, file.size - offset));
        fs.readSync(fd, buf, 0, buf.length, offset);
        const form = new FormData();
        form.append("S-File-MD5", md5);
        form.append("Check", "1");
        form.append("Offset", String(offset));
        form.append("Uuid", uuid);
        form.append("TotalSize", String(file.size));
        form.append("File", new Blob([buf]), file.name);
        const res = await fetch(`${baseUrl(t)}/uploadFile/upload`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
        const body = (await res.json().catch(() => ({}))) as { code?: string; success?: boolean };
        if (!res.ok || (body.code !== "000000" && body.success !== true)) throw new AdapterError(`Centauri upload failed at byte ${offset}`, body);
      }
    } finally {
      fs.closeSync(fd);
    }
    const remoteName = `/local/${file.name}`;
    await withSocket(t, async (send, next) => {
      if (!t.secret.mainboardId) {
        send(1); // attributes: learn the MainboardID
        await next((f) => Boolean(f.Attributes || f.Data?.Cmd === 1)).catch(() => undefined);
      }
      const id = send(128, { Filename: remoteName, StartLayer: 0 });
      const ack = await next((f) => f.Data?.RequestID === id || f.Data?.Cmd === 128);
      const code = ack.Data?.Data?.Ack;
      if (code !== 0 && code !== undefined) throw new AdapterError(`Centauri refused to start (ack ${code}).`);
    });
    return { remoteName, started: true };
  },

  async pause(t) {
    await withSocket(t, async (send) => void send(129));
  },
  async resume(t) {
    await withSocket(t, async (send) => void send(131));
  },
  async cancel(t) {
    await withSocket(t, async (send) => void send(130));
  },
};
