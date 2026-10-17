/**
 * API client. The Hub address is:
 *  - the page's own origin when the UI is served by the Hub server (LAN browser / Android), or
 *  - what the user typed on the sign-in screen (Tauri window, dev server), kept in localStorage.
 * Only the address and the session token are stored on the device; all business data lives on the server.
 */
const SERVER_KEY = "hub-server";
const TOKEN_KEY = "hub-token";

export function servedByHub(): boolean {
  return location.protocol.startsWith("http") && location.port !== "5173" && !location.hostname.endsWith("tauri.localhost");
}

export function serverUrl(): string {
  if (servedByHub()) return location.origin;
  return localStorage.getItem(SERVER_KEY) ?? "http://127.0.0.1:8787";
}

export function setServerUrl(url: string) {
  localStorage.setItem(SERVER_KEY, url.replace(/\/+$/, ""));
}

export const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY) ?? "",
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown>) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(serverUrl() + path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, `Can't reach the Hub at ${serverUrl()}. Is the Hub computer on?`, {});
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (res.status === 401 && t) {
    token.clear();
    window.dispatchEvent(new Event("hub-signed-out"));
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data);
  return data as T;
}

export type Role = "superadmin" | "admin" | "staff" | "user" | "customer" | "demo";
export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  impersonatorId: number | null;
}
const LEVEL: Record<Role, number> = { superadmin: 6, admin: 5, staff: 4, user: 3, customer: 2, demo: 1 };
/** UI hint only. The server re-checks every permission. */
export const atLeast = (u: User | null, role: Role) => Boolean(u && LEVEL[u.role] >= LEVEL[role]);

export interface Part {
  number: number;
  name: string;
  description: string;
  category: string;
  material: string;
  lead: string;
  internalName?: string;
  status?: string;
  confidentiality?: string;
  listingReady?: boolean;
  grams?: number;
  stockUnits?: number;
  reserved?: number;
  bin?: string;
  fileVersion?: string;
  notes?: string;
}

export interface Gcode {
  id: number;
  partNumber: number;
  version: number;
  partFileVersion: string;
  originalName: string;
  sizeBytes: number;
  slicer: string | null;
  slicerVersion: string | null;
  printerModel: string | null;
  nozzleMm: number | null;
  material: string | null;
  layerHeight: number | null;
  layers: number | null;
  estSeconds: number | null;
  filamentG: number | null;
  filamentMm: number | null;
  bedX: number | null;
  bedY: number | null;
  status: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface PrinterStatus {
  state: string;
  progress?: number;
  file?: string;
  nozzleTemp?: number;
  bedTemp?: number;
  message?: string;
}

export interface Printer {
  id: number;
  name: string;
  kind: string;
  adapter: string;
  host: string;
  port: number;
  model: string;
  nozzleMm: number;
  bedX: number;
  bedY: number;
  bedZ: number;
  materials: string;
  zone: string;
  enabled: boolean;
  maintenanceReason: string | null;
  state: string;
  status: PrinterStatus | null;
  lastSeenAt: string | null;
}

export interface Finding {
  level: "block" | "warn";
  code: string;
  message: string;
}

export function hms(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
