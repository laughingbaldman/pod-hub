/**
 * One interface for every printer family. The Hub server owns the LAN connection;
 * adapters are plain modules registered in ./index.ts, so a new family is one file.
 */
export type PrinterState = "idle" | "printing" | "paused" | "busy" | "error" | "offline" | "unknown";

export interface PrinterTarget {
  host: string;
  port: number;
  model: string;
  /** Adapter-specific credentials (API key, serial + check code, access code). Never logged. */
  secret: Record<string, string>;
}

export interface PrinterStatus {
  state: PrinterState;
  progress?: number; // 0..1
  file?: string;
  nozzleTemp?: number;
  bedTemp?: number;
  layer?: number;
  totalLayers?: number;
  remainingSeconds?: number;
  message?: string;
}

export interface UploadFile {
  path: string; // local path on the Hub server
  name: string; // file name to use on the printer
  size: number;
  md5?: string;
}

export interface SendResult {
  remoteName: string;
  started: boolean;
}

export interface SecretField {
  key: string;
  label: string;
  required: boolean;
}

export interface PrinterAdapter {
  type: string;
  label: string;
  defaultPort: number;
  /** Fields the "add printer" form should ask for. Stored apart from the printer row. */
  secretFields: SecretField[];
  /** True when the adapter really talks to hardware (false for stubs). */
  implemented: boolean;
  status(target: PrinterTarget): Promise<PrinterStatus>;
  /** Upload and start in one step. */
  send(target: PrinterTarget, file: UploadFile): Promise<SendResult>;
  pause?(target: PrinterTarget): Promise<void>;
  resume?(target: PrinterTarget): Promise<void>;
  cancel?(target: PrinterTarget): Promise<void>;
}

export class AdapterError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

export const TIMEOUT_MS = 5000;
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export function baseUrl(t: PrinterTarget): string {
  const host = t.host.includes(":") && !t.host.startsWith("[") ? `[${t.host}]` : t.host; // IPv6 literal
  return `http://${host}:${t.port}`;
}

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS) });
  } catch (error) {
    throw new AdapterError(`No answer from ${new URL(url).host}: ${(error as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new AdapterError(`${new URL(url).pathname} returned HTTP ${res.status}`, text.slice(0, 300));
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new AdapterError(`${new URL(url).pathname} did not return JSON`, text.slice(0, 300));
  }
}
