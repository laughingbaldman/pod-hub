/**
 * Build a self-contained Hub server release for THIS machine's OS/arch:
 *   build/part-hub-server-<version>-<platform>-<arch>/
 *     node/node(.exe)        the Node 24 runtime running this script
 *     server/dist, server/package.json, server/node_modules (production only)
 *     app-dist/              the built UI, served to LAN browsers / Android
 *     packaging/             service files (WinSW or systemd) + install scripts
 *     VERSION
 * Run on Windows for the Windows package and on Linux for the Linux package (CI does both).
 * The Windows service wrapper (WinSW-x64.exe) is downloaded by CI, not committed.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const name = `part-hub-server-${version}-${process.platform}-${process.arch}`;
const out = path.join(root, "build", name);
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Package with Node 24+ (node:sqlite).");
run("npm run build");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "server"), { recursive: true });
fs.mkdirSync(path.join(out, "node"), { recursive: true });

fs.cpSync(path.join(root, "server", "dist"), path.join(out, "server", "dist"), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, "server", "package.json"), "utf8"));
delete pkg.devDependencies;
fs.writeFileSync(path.join(out, "server", "package.json"), JSON.stringify(pkg, null, 2));
run("npm install --omit=dev --no-audit --no-fund --ignore-scripts", path.join(out, "server"));
fs.cpSync(path.join(root, "app", "dist"), path.join(out, "app-dist"), { recursive: true });
fs.cpSync(path.join(root, "packaging"), path.join(out, "packaging"), { recursive: true });
fs.copyFileSync(process.execPath, path.join(out, "node", process.platform === "win32" ? "node.exe" : "node"));
fs.writeFileSync(path.join(out, "VERSION"), version + "\n");
console.log(`\nServer package ready: ${out}`);
