import { buildApp } from "./app.js";
import { loadConfig } from "./lib/config.js";
import { runBackup } from "./lib/backup.js";

const cfg = loadConfig();
const { app, hub } = await buildApp(cfg);

// Nightly backup at about 02:00 local time when a backup folder is configured.
if (cfg.backupDir) {
  let lastDay = "";
  setInterval(() => {
    const now = new Date();
    const day = now.toDateString();
    if (now.getHours() === 2 && day !== lastDay) {
      lastDay = day;
      runBackup(hub.db, cfg.dataDir, cfg.backupDir!, cfg.backupKeep, hub.version)
        .then((r) => app.log.info({ backup: r }, "nightly backup"))
        .catch((e) => app.log.error({ err: e }, "nightly backup failed"));
    }
  }, 60_000).unref();
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: shutting down`);
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: cfg.host, port: cfg.port });
console.log(`Hub server ${hub.version} listening on http://${cfg.host}:${cfg.port}  data: ${cfg.dataDir}`);
