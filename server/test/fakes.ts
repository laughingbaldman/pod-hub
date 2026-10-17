/** Minimal fake Moonraker and OctoPrint servers for tests. They record what they receive. */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Fake {
  port: number;
  uploads: { name: string; bytes: number; fields: Record<string, string> }[];
  state: string;
  close(): Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function parseMultipart(body: Buffer, contentType: string) {
  const boundary = contentType.split("boundary=")[1];
  const fields: Record<string, string> = {};
  let file = { name: "", bytes: 0 };
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const m = part.match(/name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*)\r\n$/);
    if (!m) continue;
    if (m[2]) file = { name: m[2], bytes: Buffer.byteLength(m[3], "latin1") };
    else fields[m[1]] = m[3];
  }
  return { fields, file };
}

function listen(handler: (fake: Fake, req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>, port = 0): Promise<Fake> {
  return new Promise((resolve) => {
    const fake = { uploads: [], state: "", port: 0 } as unknown as Fake;
    const server = http.createServer((req, res) => void handler(fake, req, res));
    server.listen(port, "127.0.0.1", () => {
      fake.port = (server.address() as AddressInfo).port;
      fake.close = () => new Promise((r) => server.close(() => r()));
      resolve(fake);
    });
  });
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export function fakeMoonraker(port = 0): Promise<Fake> {
  return listen(async (fake, req, res) => {
    fake.state ||= "standby";
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/printer/objects/query") {
      return json(res, 200, { result: { status: { webhooks: { state: "ready" }, print_stats: { state: fake.state, filename: "" }, virtual_sdcard: { progress: 0 }, extruder: { temperature: 24 }, heater_bed: { temperature: 23 } } } });
    }
    if (url.pathname === "/server/files/upload" && req.method === "POST") {
      const { fields, file } = parseMultipart(await readBody(req), String(req.headers["content-type"]));
      fake.uploads.push({ ...file, fields });
      if (fields.print === "true") fake.state = "printing";
      return json(res, 201, { result: { item: { path: file.name, root: "gcodes" }, print_started: fields.print === "true", action: "create_file" } });
    }
    json(res, 404, { error: "not found" });
  }, port);
}

export function fakeOctoPrint(apiKey: string, port = 0): Promise<Fake> {
  return listen(async (fake, req, res) => {
    fake.state ||= "Operational";
    if (req.headers["x-api-key"] !== apiKey) return json(res, 403, { error: "Invalid API key" });
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/api/job") return json(res, 200, { state: fake.state, job: { file: { name: null } }, progress: { completion: null, printTimeLeft: null } });
    if (url.pathname === "/api/printer") return json(res, 200, { temperature: { tool0: { actual: 25 }, bed: { actual: 24 } } });
    if (url.pathname === "/api/files/local" && req.method === "POST") {
      const { fields, file } = parseMultipart(await readBody(req), String(req.headers["content-type"]));
      fake.uploads.push({ ...file, fields });
      if (fields.print === "true") fake.state = "Printing";
      return json(res, 201, { done: true, files: { local: { name: file.name, path: file.name, origin: "local" } } });
    }
    json(res, 404, { error: "not found" });
  }, port);
}
