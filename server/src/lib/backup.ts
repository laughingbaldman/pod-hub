/**
 * Local backups to a second drive (e.g. D:\PartHubBackups or /mnt/backup/part-hub).
 * - Database: consistent online snapshot via node:sqlite backup() (safe while WAL is live).
 * - G-code: content-addressed by SHA-256, so copying only missing files makes it incremental.
 * - Keeps the newest N snapshots. Restore is an offline CLI step (stop the service first).
 */
import fs from "node:fs";
import path from "node:path";
import { backup as sqliteBackup } from "node:sqlite";
import type { Db } from "./db.js";

export interface BackupResult {
  file: string;
  gcodeCopied: number;
  pruned: number;
  at: string;
}

export async function runBackup(db: Db, dataDir: string, backupDir: string, keep: number, appVersion: string): Promise<BackupResult> {
  if (path.resolve(backupDir).startsWith(path.resolve(dataDir))) throw new Error("Backup folder must not be inside the data folder.");
  const at = new Date().toISOString();
  const stamp = at.replace(/[:.]/g, "-");
  const dbDir = path.join(backupDir, "db");
  const gcodeDir = path.join(backupDir, "gcode");
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(gcodeDir, { recursive: true });

  const file = path.join(dbDir, `hub-${stamp}.db`);
  await sqliteBackup(db, file);
  const migrations = (db.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  fs.writeFileSync(`${file}.json`, JSON.stringify({ at, appVersion, migrations }, null, 2));

  let gcodeCopied = 0;
  const src = path.join(dataDir, "gcode");
  if (fs.existsSync(src)) {
    for (const name of fs.readdirSync(src)) {
      if (!name.endsWith(".gcode")) continue;
      const dest = path.join(gcodeDir, name);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(src, name), dest);
        gcodeCopied++;
      }
    }
  }

  const snapshots = fs.readdirSync(dbDir).filter((n) => /^hub-.*\.db$/.test(n)).sort();
  let pruned = 0;
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    fs.rmSync(path.join(dbDir, old), { force: true });
    fs.rmSync(path.join(dbDir, `${old}.json`), { force: true });
    pruned++;
  }
  return { file, gcodeCopied, pruned, at };
}

export function listBackups(backupDir: string): { file: string; at: string; appVersion?: string }[] {
  const dbDir = path.join(backupDir, "db");
  if (!fs.existsSync(dbDir)) return [];
  return fs
    .readdirSync(dbDir)
    .filter((n) => n.endsWith(".db"))
    .sort()
    .reverse()
    .map((n) => {
      let meta: { at?: string; appVersion?: string } = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dbDir, `${n}.json`), "utf8"));
      } catch {
        /* manifest optional */
      }
      return { file: n, at: meta.at ?? "", appVersion: meta.appVersion };
    });
}

/** Offline restore: copy a snapshot over the live database. The service must be stopped. */
export function restoreBackup(backupDir: string, snapshot: string, dataDir: string): string {
  const src = path.join(backupDir, "db", path.basename(snapshot));
  if (!fs.existsSync(src)) throw new Error(`No snapshot ${snapshot}`);
  const live = path.join(dataDir, "hub.db");
  if (fs.existsSync(live)) fs.copyFileSync(live, `${live}.before-restore-${Date.now()}`);
  for (const ext of ["-wal", "-shm"]) fs.rmSync(live + ext, { force: true });
  fs.copyFileSync(src, live);
  const gsrc = path.join(backupDir, "gcode");
  const gdst = path.join(dataDir, "gcode");
  fs.mkdirSync(gdst, { recursive: true });
  if (fs.existsSync(gsrc)) for (const n of fs.readdirSync(gsrc)) if (!fs.existsSync(path.join(gdst, n))) fs.copyFileSync(path.join(gsrc, n), path.join(gdst, n));
  return live;
}
