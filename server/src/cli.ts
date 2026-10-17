/**
 * Admin CLI (run on the Hub PC):
 *   create-admin <username> [display name]      prompts for the password (or HUB_NEW_PASSWORD)
 *   import-book <file.json> [--demo]             import The Floor export
 *   backup                                       one backup now to backupDir
 *   restore <snapshot-file-name>                 offline restore (stop the service first)
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { createUser } from "./lib/auth.js";
import { audit } from "./lib/audit.js";
import { listBackups, restoreBackup, runBackup } from "./lib/backup.js";
import { ensureDirs, loadConfig } from "./lib/config.js";
import { openDb } from "./lib/db.js";
import { importPodBook } from "./lib/importer.js";
import { VERSION } from "./version.js";

const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig();
ensureDirs(cfg);

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

if (cmd === "create-admin") {
  const [username, ...name] = args;
  if (!username) throw new Error("usage: create-admin <username> [display name]");
  const password = process.env.HUB_NEW_PASSWORD ?? (await ask("New password (10+ characters): "));
  const db = openDb(path.join(cfg.dataDir, "hub.db"));
  const id = createUser(db, { username, displayName: name.join(" ") || username, role: "superadmin", password });
  audit(db, null, "cli.superadmin_created", "user", id, { username });
  console.log(`Superadmin "${username}" created.`);
} else if (cmd === "import-book") {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("usage: import-book <file.json> [--demo]");
  const db = openDb(path.join(cfg.dataDir, "hub.db"));
  const report = importPodBook(db, JSON.parse(fs.readFileSync(file, "utf8")), { allowDemo: args.includes("--demo") });
  audit(db, null, "cli.import_pod_book_v1", "import", report.kind, { ...report, skipped: report.skipped.length });
  console.log(JSON.stringify(report, null, 2));
} else if (cmd === "backup") {
  if (!cfg.backupDir) throw new Error("Set backupDir in config.json or HUB_BACKUP_DIR first.");
  const db = openDb(path.join(cfg.dataDir, "hub.db"));
  console.log(await runBackup(db, cfg.dataDir, cfg.backupDir, cfg.backupKeep, VERSION));
} else if (cmd === "restore") {
  if (!cfg.backupDir) throw new Error("Set backupDir first.");
  if (!args[0]) {
    console.log(listBackups(cfg.backupDir));
    throw new Error("usage: restore <snapshot-file-name>  (stop the Hub service first)");
  }
  console.log(`Restored into ${restoreBackup(cfg.backupDir, args[0], cfg.dataDir)}. Start the service again.`);
} else {
  console.log("commands: create-admin | import-book | backup | restore");
}
