# Hub

Shop hub for a small 3D-printing business: parts, batches, a G-code library per part and a
printer fleet you can send prints to. It runs **offline on the shop LAN**, on **Windows 10 and Linux**.

```
┌──────────────────────┐   LAN (http://<hub-ip>:8787)   ┌───────────────────────────────┐
│ Desktop client       │ ─────────────────────────────▶ │ Hub server (one PC, a service)│
│ Tauri window (Win/Lx)│                                │ Fastify API + SQLite (WAL)    │
│ or any LAN browser / │                                │ G-code store, backups, audit  │
│ Android browser      │                                │ printer adapters ───────────┐ │
└──────────────────────┘                                └─────────────────────────────┼─┘
                                         Moonraker · OctoPrint · FlashForge · SDCP ◀──┘
```

* `server/` – Node 24 + TypeScript + Fastify. SQLite through Node's built-in `node:sqlite`
  (no native addon to compile). Printer adapters live here because the server is on the LAN.
* `app/` – React + Vite + Tailwind UI (design tokens from The Floor). `app/src-tauri/` wraps it in a
  desktop window. The server also serves the built UI, so phones and the Android client just open
  `http://<hub-ip>:8787/`.
* `packaging/` – Windows service (WinSW) and Linux systemd files, install/upgrade/rollback scripts.
* `docs/` – architecture and build plan live in the review folder the owner shared; config example here.

## Requirements

| | Development | Build installers |
|---|---|---|
| Node | 24 LTS | 24 LTS |
| Rust | – | stable (Tauri 2) |
| Windows | – | WebView2 (bundled offline by the installer) |
| Linux | – | `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` |

## Run it (dev, any OS)

```sh
npm install
npm test                         # server unit + end-to-end tests (fake printers)
npm run dev:server               # API on http://127.0.0.1:8787 (data in ~/.local/share/part-hub or %ProgramData%\PartHub)
npm run dev:app                  # UI on http://127.0.0.1:5173
npx tsx server/scripts/fake-printers.ts   # optional: fake Moonraker :7125 and OctoPrint :5000 (key dev-octo-key)
```

First run: open the UI **on the Hub PC itself**; with no accounts it offers "Create the first
account" (becomes Superadmin). Or: `npm run cli -w server -- create-admin owner`.

Environment knobs (all optional): `HUB_DATA_DIR`, `HUB_PORT`, `HUB_HOST`, `HUB_BACKUP_DIR`,
`HUB_LOG_STDOUT=1`, `HUB_LOG_LEVEL`. Or put a `config.json` in the data folder
(see `docs/config.example.json`). No secrets are kept in the repo; printer API keys / access codes
are entered in the app and stored server-side only.

## Build installers

CI (`.github/workflows/build.yml`) builds both targets on every tag. By hand, on each OS:

```sh
npm ci
npm run tauri -w app -- build --bundles nsis,msi        # Windows client  -> app/src-tauri/target/release/bundle/
npm run tauri -w app -- build --bundles appimage,deb    # Linux client
node scripts/package-server.mjs                          # server package for this OS -> build/part-hub-server-*
```

Windows server: download `WinSW-x64.exe` (v2.12.0) as `packaging/windows/part-hub-service.exe`
before packaging, then on the Hub PC run, elevated, from the unpacked package:
`powershell -ExecutionPolicy Bypass -File packaging\windows\install-service.ps1`.

Linux server: `sudo ./packaging/linux/install.sh` from the unpacked package (systemd unit `part-hub`).

### Upgrade and roll back

Every version installs side by side (`C:\Program Files\PartHub\releases\<v>` or
`/opt/part-hub/releases/<v>`). The install script backs up first, then switches the service to the
new version. To roll back, run the older release's script with `-Activate` / `--activate`; if the
newer version applied a database migration, also restore the pre-upgrade backup
(`cli.js restore <snapshot>` with the service stopped).

### Backups

Set `backupDir` to a folder on a **second drive**. The server snapshots the database nightly at
about 02:00 (and on demand from Admin → Back up now), copies new G-code files, and keeps the newest
30 snapshots. Restore is offline: stop the service, `node server/dist/cli.js restore <file>`, start it.

## Move data over from The Floor

In The Floor: Health → Export (a `pod-book-v1` JSON file). In the Hub: Admin → Import The Floor
export (Superadmin), or `npm run cli -w server -- import-book export.json`. Existing rows are never
overwritten; the report lists what was skipped. The sample floor is refused unless `--demo`.

## Printer support

| Type | Talks to | Port | Status |
|---|---|---|---|
| `moonraker` | Klipper (incl. Elegoo Neptune 4 series) | 7125 (Neptune 4: 80) | upload + start + status + pause/resume/cancel, tested against a fake |
| `octoprint` | OctoPrint | 80 / 5000 | same, tested against a fake |
| `flashforge` | Adventurer 5M / 5M Pro / AD5X HTTP API | 8898 | best effort from community docs, needs hardware test |
| `sdcp` | Elegoo Centauri Carbon (SDCP v3) | 3030 | best effort from community docs, needs hardware test |
| `bambu` | Bambu LAN (MQTT 8883 + FTPS 990) | – | stub |
| `manual` | anything else | – | tracked on the floor only |

Add a family: one file in `server/src/printers/`, register it in `server/src/printers/index.ts`.

## Security model (inside the company)

Six tiers (superadmin, admin, staff, user, customer, demo) checked **on the server** for every
call; per-user logins with scrypt hashes, lockout after 5 misses, sessions stored hashed;
an append-only audit log (SQLite triggers refuse UPDATE/DELETE); impersonation only by
Superadmin and always audited; customer/demo views are field allowlists. Plain HTTP on the LAN
is a deliberate trade-off for an offline shop; see the architecture doc for adding TLS.
