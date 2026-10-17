/**
 * Runtime configuration. Cross-platform: only node:path / node:os, no Windows-only APIs.
 *
 * Data directory (database, G-code files, logs):
 *   HUB_DATA_DIR if set, otherwise
 *   Windows: %ProgramData%\PartHub      (service-wide, survives user logoff)
 *   Linux:   /var/lib/part-hub when running as the systemd service user, else ~/.local/share/part-hub
 *
 * Secrets never live in this file or in git. Printer credentials are stored in the
 * database (printer_secrets) and are never returned by the API.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface HubConfig {
  host: string;
  port: number;
  dataDir: string;
  backupDir: string | null;
  backupKeep: number;
  sessionHours: number;
  pollSeconds: number;
  /** Max G-code upload size in MB. */
  maxUploadMb: number;
  /** Extra browser origins allowed to call the API (the Tauri webview origin is always allowed). */
  corsOrigins: string[];
  appDistDir: string | null;
}

export function defaultDataDir(): string {
  if (process.env.HUB_DATA_DIR) return path.resolve(process.env.HUB_DATA_DIR);
  if (process.platform === "win32") {
    const base = process.env.ProgramData ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "PartHub");
  }
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "part-hub");
  if (fs.existsSync("/var/lib/part-hub")) return "/var/lib/part-hub";
  return path.join(os.homedir(), ".local", "share", "part-hub");
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  // Optional config.json in the data dir (written by the installer / admin screen).
  let file: Partial<HubConfig> = {};
  const cfgPath = path.join(dataDir, "config.json");
  if (fs.existsSync(cfgPath)) {
    try {
      file = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Partial<HubConfig>;
    } catch {
      file = {};
    }
  }
  return {
    host: overrides.host ?? process.env.HUB_HOST ?? file.host ?? "0.0.0.0",
    port: overrides.port ?? num(process.env.HUB_PORT, file.port ?? 8787),
    dataDir,
    backupDir: overrides.backupDir ?? process.env.HUB_BACKUP_DIR ?? file.backupDir ?? null,
    backupKeep: overrides.backupKeep ?? file.backupKeep ?? 30,
    sessionHours: overrides.sessionHours ?? file.sessionHours ?? 12,
    pollSeconds: overrides.pollSeconds ?? file.pollSeconds ?? 10,
    maxUploadMb: overrides.maxUploadMb ?? file.maxUploadMb ?? 512,
    corsOrigins: overrides.corsOrigins ?? file.corsOrigins ?? [],
    appDistDir: overrides.appDistDir ?? process.env.HUB_APP_DIST ?? file.appDistDir ?? null,
  };
}

export function ensureDirs(cfg: HubConfig): void {
  for (const dir of [cfg.dataDir, path.join(cfg.dataDir, "gcode"), path.join(cfg.dataDir, "logs")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
