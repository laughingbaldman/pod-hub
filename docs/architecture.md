# Hub architecture: offline LAN app for Windows 10 and Linux

Status: the scaffold for this design is in `/workspace/pod-hub/hub-app/` and runs on Linux (tested).
It is designed to build and run on Windows 10 as well; that still needs a check on the real PC (see `build_plan.md` M0).

## 1. Constraints this has to meet

- **One shop PC runs everything**: today Windows 10 (out of support), later Linux. It has to run **fully offline**
  on the shop LAN, with no cloud, tunnel, CDN or license server.
- **Threats come from inside, not the internet**: per-person logins, six tiers, an audit log nobody can edit,
  and least privilege for printer control.
- **Its own window and a launcher**, not "open a browser tab". Other LAN PCs and an Android device connect
  by IP.
- **Printers are on the same LAN**, so the server talks to them directly. No bridge or tunnel is needed.
- **Data leaves browser storage** for a real server database, with an importer for The Floor's `pod-book-v1` export.
- **Backups go to a second drive**; updates and rollback go by installer version.
- **Same code on Windows and Linux**: Node/SQLite/Tauri only, no Windows-only APIs in app code.

## 2. Topology

```
 Shop LAN (offline)
 ┌───────────────────────────── Hub PC (Windows 10 now, Linux later) ─────────────────────────────┐
 │  Service "PartHub" (WinSW on Windows / systemd unit part-hub on Linux), auto-start, auto-restart │
 │  ┌──────────────────────────────── Hub server (Node 24 LTS) ─────────────────────────────────┐ │
 │  │ Fastify HTTP API :8787  ── serves the built UI at /  (LAN browsers, Android)              │ │
 │  │ Auth + RBAC + audit │ Parts/batches │ G-code library │ Print jobs │ Backups │ Health      │ │
 │  │ SQLite hub.db (WAL) │ gcode/<sha256>.gcode │ logs/                                        │ │
 │  │ Printer adapters: moonraker · octoprint · flashforge · sdcp · bambu(stub) · manual        │ │
 │  │ Poller (every 10 s) ──────────────────────────────────────────────┐                       │ │
 │  └───────────────────────────────────────────────────────────────────┼───────────────────────┘ │
 │  Tauri window "Hub" (same UI)                     Second drive: D:\HubBackups or /mnt/backup  │
 └──────────────────────────────────────────────────────────────────────┼───────────────────────────┘
        ▲ http://<hub-ip>:8787                                           │ LAN HTTP / WebSocket
        │                                                                ▼
 Other PCs: Tauri client (NSIS/MSI, AppImage/.deb)           Printers by IP: Klipper/Moonraker,
 Android: browser / home-screen shortcut (later a native shell) OctoPrint, FlashForge 8898, Centauri SDCP 3030
```

## 3. Stack choice and why

| Layer | Choice | Why | Rejected |
|---|---|---|---|
| Runtime | **Node.js 24 LTS**, TypeScript | One language for UI and server; official Windows x64 and Linux builds; easy to run as a service; The Floor's code is already TS | Python/Frappe: see ERPNext below |
| HTTP | **Fastify 5** (+ cors, multipart, rate-limit, static) | Small, fast, JSON-schema friendly, built-in structured logging (pino) with header redaction | Express (slower, no built-in logging), Nest (heavy) |
| Database | **SQLite via built-in `node:sqlite`**, WAL mode, `foreign_keys=ON` | Zero install and zero admin: one file that backs up with a single call. **No native addon to compile**, so the same package works on Windows and Linux. WAL lets the poller, API and backup run side by side. Easily handles a shop's write load (tens of users) | **Embedded Postgres**: a second service to install, patch, tune and back up on an unsupported OS; worth it only for many concurrent writers or heavy reporting. **better-sqlite3**: excellent, but it's a native module that must match the Node ABI on each OS; kept as a one-file swap (`server/src/lib/db.ts`) |
| Validation | zod | Same schemas can be shared with the UI later | |
| UI | **React 19 + Vite + Tailwind v4**, The Floor's tokens | Reuses the existing look and React skills; static build served by the server | |
| Desktop shell | **Tauri v2** | Native window and installer with a small footprint. Uses **WebView2 on Windows 10** (bundled offline by the installer) and WebKitGTK on Linux. Bundles **NSIS + MSI** and **AppImage + .deb** | Electron (about 150 MB per client, ships its own Chromium), plain browser (no window or launcher) |
| Service wrapper | **WinSW v2** on Windows, **systemd** on Linux | WinSW is one exe plus XML, with restart-on-failure, delayed auto-start and log rotation; systemd is native and supports hardening | node-windows (wraps WinSW anyway and needs npm at install time), NSSM (unmaintained) |
| Android | The same UI in the browser at `http://<hub-ip>:8787/` (add to home screen) first | Zero extra code. A Tauri-mobile or Capacitor shell can come later, pointed at the same API | Flutter (a second UI codebase) |

### Why not ERPNext
ERPNext/Frappe officially targets Linux (bench, Python 3, MariaDB, Redis, Node, nginx/supervisor). There's
**no supported native Windows install**; on Windows it means WSL2 or Docker Desktop, which is a poor fit
for an out-of-support Windows 10 box that has to run unattended and offline. It's also a large surface to
lock down and customize for six tiers and printer control. We take its *module map* (stock, batches,
accounting, CRM, purchasing, HR) as the roadmap, and build the slices the shop actually uses on our own
schema. If ERPNext is wanted after the Linux move, the Hub can sync to it through its REST API.

## 4. Repository layout (`hub-app/`)

```
server/            Fastify API, SQLite, printer adapters, backups, importer, CLI, tests
  migrations/      001_core.sql … (forward-only, tracked in _migrations)
  src/lib/         config (cross-platform paths), db, auth/RBAC, audit, gcode parser, preflight, sku, backup, importer
  src/printers/    types.ts (interface) + one file per family + index.ts (registry)
  src/routes/      auth, parts, gcode, printers, print (send flow + poller), admin
  test/            unit tests + end-to-end test against fake Moonraker/OctoPrint servers
app/               React UI (Vite) + src-tauri/ (Rust shell, icons, tauri.conf.json)
packaging/         windows/ (WinSW XML, install-service.ps1), linux/ (systemd unit, install.sh)
scripts/           package-server.mjs (self-contained server release for the current OS)
.github/workflows/ build.yml (test + bundle on ubuntu-22.04 and windows-2022)
```

## 5. Data model (v0.1, `server/migrations/001_core.sql`)

- `users` (six tiers, scrypt hash, lockout fields, must-change-password) · `sessions` (token **hash**, expiry,
  impersonator) · `audit_log` (append-only by trigger)
- `parts` (permanent number, public/internal fields, confidentiality, listing rules as `CHECK`s) · `batches`
  (SKU `part-month-year[-n]`) · `spools`
- `printers` (adapter, host/IP, port, **model, nozzle, bed X/Y/Z**, allowed materials, loaded spool, map
  position, zone, confidential, maintenance) · `printer_secrets` (never returned by the API)
- `gcode_files`: per part, a **version** (1, 2, 3…) with the **part file version** it was sliced from,
  **printer model, nozzle, material, slicer + slicer version**, layer height, layers, estimated time,
  filament g/mm, bed size, max Z, SHA-256, size, the full parsed config, uploader, and status (active/retired)
- `print_jobs`: G-code, printer, **batch SKU, spool, user**, state, remote file name, override reason, timestamps
- `queue_items`, `deadlines`, `shift_log`, `settings` (for The Floor import and later modules)

Later migrations add the ERP/CRM modules (see `build_plan.md`): contacts/accounts/interactions,
opportunities and pipeline, quotes/orders/invoices with **price settings kept out of code**, purchasing,
stock moves and locations, projects/tasks, staff/time, tickets, documents, and feature flags.

## 6. Printing: G-code library, pre-send check, send flow

1. **Upload** (Staff+): `POST /api/parts/:n/gcode`, multipart, streamed to disk while hashing (SHA-256
   for storage and dedupe, MD5 for printers that need it). Only plain-text `.gcode/.gco/.g` files are accepted;
   binary content and exact duplicates are refused. Files are stored content-addressed at `data/gcode/<sha256>.gcode`.
2. **Parse** (`server/src/lib/gcode.ts`): reads the first 256 KB and the last 2 MB. OrcaSlicer's header
   (`; generated by OrcaSlicer x.y.z`, `; total layer number`) and footer (`; estimated printing time
   (normal mode)`, `; filament used [g]/[mm]`, then the `CONFIG_BLOCK` with `printer_model`, `nozzle_diameter`,
   `printable_area`, `printable_height`, `filament_type`, `layer_height`, `*_settings_id`). Bambu Studio and
   Prusa/Cura variants are handled best-effort. The whole config is saved in `meta_json`, so a future
   "reprint with the same slicer build" check has what it needs.
3. **Pick a printer**: `GET /api/gcode/:id/printers` runs the **pre-send check** against every printer
   (`server/src/lib/preflight.ts`):
   - **Hard blocks** (no override): different printer model, different nozzle, file bed larger than the printer
     bed, print taller than the printer, printer disabled or down, printer not idle, file retired, adapter
     can't receive files.
   - **Warnings** (Admin override with a written reason, audited): model or nozzle not stated, material not
     allowed on that printer, loaded spool material differs.
4. **Confirm and send**: `POST /api/print/send` re-polls the printer and re-runs the check on the server
   (the client's view is never trusted). It then creates or uses the batch (`nextBatchSku` → `1-10-2026`,
   `1-10-2026-2`…), writes a `print_jobs` row (batch, spool, user), uploads through the adapter and starts the print.
   The remote name is `p<part>-v<ver>-<sku>.gcode`, so the printer's own screen shows traceability.
5. **Track**: the poller asks every enabled printer for its status every 10 s, stores it on the printer row,
   and moves jobs to printing, paused, complete or failed.

**Adapter contract** (`server/src/printers/types.ts`): `status()`, `send()` (upload + start), optional
`pause/resume/cancel`, the default port, and the credential fields the "add printer" form asks for. One file per
family, registered in `index.ts`. Since printer models aren't confirmed yet, nothing else depends on a specific brand.

**Slicer:** the Hub doesn't embed OrcaSlicer. The G-code file is the contract: staff slice in Orca on
their PC and upload. An optional later step can run the Orca CLI on the Hub PC to re-slice saved 3MF
projects, but it isn't needed to print. The OrcaSlicer configuration docs (orcaslicer.org/configuration)
are the reference for which config keys to read.

## 7. Security model (inside the company)

| Tier | Can |
|---|---|
| superadmin | everything, plus import, impersonation, and creating admins |
| admin | manage users below admin, manage printers, override pre-send warnings, read the audit log, run backups |
| staff | edit parts, upload G-code, send prints, see NDA/patent-pending parts and notes |
| user | read internal parts and printers, no changes |
| customer / demo | Public, listing-ready, non-Hold parts only, through a **field allowlist** |

- Every route checks permissions **on the server** (`requirePerm`). The UI only hides buttons.
- Passwords: scrypt (N=2^15) with a minimum of 10 characters. Accounts lock for 15 minutes after 5 misses. Admin-set
  passwords force a change at first sign-in. A 10/min rate limit applies to login.
- Sessions: 32-byte random tokens, **only the SHA-256 is stored**, 12-hour expiry, cleared when a user is turned off
  or their password is reset.
- Audit: login and failed login, user changes, part edits, uploads and downloads, printer changes, blocked sends,
  sends with override reason, imports and backups. `UPDATE`/`DELETE` on `audit_log` are refused by SQLite triggers.
- Impersonation: Superadmin only, a 1-hour session flagged with the impersonator's id, and every action is
  logged that way.
- First-run setup only works while no users exist **and** only from the Hub PC itself (loopback).
- Printer credentials (API keys, check codes) sit in `printer_secrets`, are never returned by the API and never logged.
- Network: Windows firewall rule for the port on the **Private** profile only. CORS is limited to the Tauri origins.
- **Plain HTTP on the LAN** is a deliberate v1 trade-off. To harden later: a self-signed certificate made on
  first run, with Tauri clients pinning it, or Caddy with `tls internal` in front. Anyone on the LAN could sniff
  sessions, so keep shop Wi-Fi WPA2/3 and separate from guests.
- On the Hub PC itself: a dedicated service account. On Linux it's `parthub`, already set in the unit. On Windows,
  WinSW defaults to LocalSystem; switching to a dedicated low-privilege account is an M0 task. The data folder should be ACL'd to that account and Admins (M0). BitLocker or LUKS on the disk is recommended.

## 8. Cross-platform rules (enforced in review)

- Paths only through `node:path` and `os.homedir()`. Data dir: `%ProgramData%\PartHub` or `/var/lib/part-hub`
  (`server/src/lib/config.ts`). No drive letters or backslashes in code.
- No native Node addons, no shelling out to OS tools from the server, and no Windows registry or WMI from app code
  (that stays in the install scripts).
- File names on printers are sanitized to `[A-Za-z0-9._-]`. Line endings are LF in the repo (`.gitattributes`;
  `.ps1` is CRLF).
- Tests run on both OSes in CI.

## 9. Backups, updates, rollback

- **Backup** (`server/src/lib/backup.ts`): an online SQLite snapshot (`node:sqlite` `backup()`, safe under WAL)
  to `<backupDir>/db/hub-<timestamp>.db` with a manifest (app version, applied migrations). G-code files are copied
  incrementally (content-addressed). The newest 30 are kept. It runs nightly at about 02:00 and on demand (Admin).
  The backup folder can't be inside the data folder. **Put it on a second physical drive.**
- **Restore**: offline CLI (`cli.js restore <snapshot>`, with the service stopped). The current DB is kept as `hub.db.before-restore-*`.
- **Updates**: every release installs side by side (`…\PartHub\releases\<version>` or
  `/opt/part-hub/releases/<version>`). The installer backs up, then switches the service. **Rollback** = run the
  older release's script with `-Activate` / `--activate`, and restore the pre-upgrade backup if the newer version
  ran a migration (migrations are forward-only). Desktop clients: the MSI upgrade code is pinned in
  `tauri.conf.json`, so newer MSIs upgrade cleanly. To roll a client back, install the older MSI/NSIS.

## 10. Operations and admin tooling

- `GET /api/health`: DB check, version, uptime and last poll. No data. Used by the service check and the UI.
- Structured JSON logs (pino) with the `authorization` header redacted. Rotation is done by WinSW (roll-by-size) or journald.
- Login rate limiting. Planned (M7): feature flags / kill switches in `settings`, a printer-control kill switch,
  per-route rate limits, a log viewer and error list in Admin, and a backup-restore drill.

## 11. CI (`.github/workflows/build.yml`)

- `test` job on **ubuntu-22.04 and windows-2022**: `npm ci`, typecheck, `npm test`.
- `bundle` job per OS: install Rust (and on Linux `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`),
  run `tauri build --bundles nsis,msi` (Windows) or `appimage,deb` (Linux), download WinSW on Windows, run
  `scripts/package-server.mjs`, and upload the installers plus the server package as artifacts.
- To add later: code signing for the Windows installers (otherwise SmartScreen warns), a `gitleaks` step,
  and a release job on `v*` tags.
