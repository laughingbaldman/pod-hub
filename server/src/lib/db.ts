/**
 * SQLite through Node's built-in node:sqlite (Node 24+). No native addon to compile,
 * so the same code ships on Windows 10 and Linux. WAL mode lets the poller, API and
 * backup run side by side. Keep all SQL behind this module so a swap to better-sqlite3
 * (near-identical API) stays a one-file change.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

const here = path.dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  // src/lib -> ../../migrations (dev) ; dist/lib -> ../migrations (built, copied)
  const candidates = [path.join(here, "..", "..", "migrations"), path.join(here, "..", "migrations")];
  const found = candidates.find((dir) => fs.existsSync(dir));
  if (!found) throw new Error("migrations folder not found");
  return found;
}

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

export function migrate(db: Db): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((row) => row.name),
  );
  const files = fs
    .readdirSync(migrationsDir())
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir(), name), "utf8");
    tx(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
    });
    applied.push(name);
  }
  return applied;
}

/** Run fn inside a transaction. Nested calls join the outer one. */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
