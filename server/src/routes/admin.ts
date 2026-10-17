import type { FastifyInstance } from "fastify";
import { audit } from "../lib/audit.js";
import { listBackups, runBackup } from "../lib/backup.js";
import { importPodBook } from "../lib/importer.js";
import { HttpError, requirePerm, type Hub } from "../context.js";

export function adminRoutes(app: FastifyInstance, hub: Hub) {
  const { db, cfg } = hub;

  // Public health probe for the service manager and the LAN status light. No data in it.
  app.get("/api/health", async () => {
    let dbOk = true;
    try {
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    return { ok: dbOk, version: hub.version, uptimeSeconds: Math.round((Date.now() - hub.startedAt) / 1000), db: dbOk ? "ok" : "error", lastPollAt: hub.lastPollAt };
  });

  app.post("/api/admin/backup", async (req) => {
    const user = requirePerm(req, "backup.run");
    if (!cfg.backupDir) throw new HttpError(400, "No backup folder is set. Set backupDir in config.json to a folder on a second drive.");
    const result = await runBackup(db, cfg.dataDir, cfg.backupDir, cfg.backupKeep, hub.version);
    audit(db, user, "backup.run", "backup", result.file, result, req.ip);
    return result;
  });

  app.get("/api/admin/backups", async (req) => {
    requirePerm(req, "backup.run");
    return { backupDir: cfg.backupDir, backups: cfg.backupDir ? listBackups(cfg.backupDir) : [] };
  });

  // Body: the JSON file exported from The Floor (Health → Export). ?demo=1 allows the sample floor.
  app.post("/api/admin/import-book", { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const user = requirePerm(req, "import.run");
    const allowDemo = (req.query as { demo?: string }).demo === "1";
    try {
      const report = importPodBook(db, req.body, { allowDemo });
      audit(db, user, "import.pod_book_v1", "import", report.kind, { ...report, skipped: report.skipped.length }, req.ip);
      return report;
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });
}
