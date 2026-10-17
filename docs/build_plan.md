# Build plan: phased milestones with acceptance checks

Repo: `/workspace/pod-hub/hub-app/` (to be pushed to the private GitHub repo by Chet). Each milestone is one or
more PRs. A milestone is **done** only when its acceptance checks pass **on Linux and on Windows CI**, plus the
listed manual checks on the real Hub PC. Rules for every PR: no secrets in code (config/env only),
non-proprietary sample data (`example.com`), tests updated, audit events for every state change,
permission checks on the server, and no Windows-only or Linux-only APIs outside `packaging/`.

## M0: Vertical slice and packaging (**done in the scaffold**, needs a check on the Windows PC)

Done and tested on Linux (Node 24): log in (first-run setup → admin → change password), parts list and search
from SQLite with tier views, G-code upload to a part with Orca header/footer parsing, add a printer by IP,
connection test, pre-send check, send to Moonraker/OctoPrint (against fake servers), job log with batch SKU,
nightly and on-demand backups, pod-book-v1 importer, audit log. 26 automated tests pass. The UI was checked in
Chrome at desktop and phone size. The server release package was built and smoke-tested.

Still to do for M0:
- [ ] CI is green on `ubuntu-22.04` and `windows-2022` (first push).
- [ ] `tauri build` produces NSIS/MSI on Windows and AppImage/.deb on Linux (it couldn't be compiled in the review
      box, which has no WebKitGTK).
- [ ] On the **real Windows 10 PC**: `install-service.ps1` installs, the service auto-starts after a reboot,
      `http://<hub-ip>:8787/api/health` answers from another PC and the Android browser, and the firewall rule is Private only.
- [ ] Run the service under a dedicated low-privilege account, ACL the data folder, and set the backup folder to the second drive.
- [ ] Test against **one real printer of each model the shop owns** (the models are an open decision).

Acceptance: a fresh PC goes from installer to first print with no internet; a reboot keeps everything running;
`git clone && npm ci && npm test` passes on both OSes.

## M1: Accounts, tiers and audit hardening

- Admin screens to create, disable and reset users, a role matrix page, a forced first password change, and session lists with "sign out everywhere".
- Audit viewer filters (actor, action, date), CSV export, and a hash chain (each row stores the hash of the previous one) so tampering is detectable.
- Optional TOTP 2FA for admin and superadmin (works offline).
- Acceptance: a staff user can't call any admin route (tests enumerate every route × role). Changing an audit row in SQLite
  breaks the chain check. A locked account unlocks after 15 minutes. Impersonation is visible in every audit row.

## M2: Parts and G-code library, complete

- Part create/edit forms with every Floor field, a confidentiality and listing-rules UI, file version bumps, and drag-and-drop
  G-code upload with progress. Retire or restore a G-code version, and compare two versions' settings.
- A per-printer-model "profile" table, so models are matched by an exact profile name rather than a text match.
- Acceptance: uploading the same file twice is refused. A Prusa/Bambu file still gets model, nozzle and material
  when present. Customer and demo accounts never receive `internal_*` or `notes` fields (an API test checks every route).

## M3: Shift operations (ported from The Floor)

- Port `floor-ops.ts` behaviour: start, finish or abort a plate; use up spool grams; QC pass, hold or fail with a reason; reprint.
  Queue with priorities, deadlines, shift log, and stock and reserved counts updated on QC pass.
- Acceptance: the same 10 scenarios as `floor-ops.test.ts` pass against the API. Reserved never goes above stock,
  stock never goes negative (the DB `CHECK` holds), and a Hold part can't be sent to a printer.

## M4: Fleet and floor map

- A 2D floor map with printers placed by drag (`map_x/map_y`), zones, and live state colours from the poller. Maintenance
  mode with a reason. Up to 24+ printers.
- Adapters hardened on real hardware: FlashForge (check code), Centauri SDCP (chunked upload, status codes), Moonraker on
  port 80 for Neptune 4, and a Bambu LAN adapter if the shop has Bambu printers.
- Pause, resume and cancel from the job page (staff+), and a printer-control kill switch (admin).
- Acceptance: unplugging a printer marks it offline within 30 s. Sending to a printer in maintenance is blocked. Each adapter
  has a recorded fake-server test built from real captures.

## M5: CRM

- Accounts, contacts, interactions (call, email or visit notes), a pipeline of opportunities, tasks, and tickets/service requests.
  Customers are linked to parts and orders. Everything is local; no email sending in v1.
- Acceptance: tier views apply (customer tier sees only its own account's records). Merging duplicate contacts is audited.
  A search covers contacts, parts and orders.

## M6: Quotes, orders and ERP basics

- Quotes → sales orders → work orders (which create batches and print jobs) → shipments → invoices (PDF made locally).
  **Pricing rules live in settings/data, not code**, and only admins can see or edit them.
- Purchasing (suppliers, POs, receiving into stock), stock locations and moves, spool inventory with reorder points.
- Basic accounting export (CSV in a layout the accountant's package can import), so the Hub doesn't try to be a general ledger in v1.
- Projects and tasks (internal R&D), and staff time entries per work order.
- Acceptance: one order flows end to end, from quote to invoice PDF, with stock and batches correct. Every money field is
  integer cents. A user below admin never receives price-rule fields.

## M7: Dashboards and admin/IT tooling

- Dashboards: printer utilization, jobs per day, failure rate by printer and material, on-time deadlines, stock below reorder.
- Admin/IT: a health page (DB size, disk free on the data and backup drives, last backup, last poll), a log viewer, feature flags
  and kill switches, per-route rate limits, a **restore drill** (restore the latest backup into a scratch folder and verify it),
  and a support bundle export (logs and config with secrets removed).
- Acceptance: the restore drill passes from the UI. Disk free under 10% shows a banner to admins. A feature flag turns a module
  off for everyone without a restart.

## M8: Android and LAN hardening

- Make the UI a PWA (manifest, icons, offline shell, camera barcode scan for bins and batches). Later, optionally, a Tauri-mobile
  or Capacitor shell pointing at the Hub.
- Optional TLS: a self-signed certificate made at install time, with the fingerprint shown in Admin and pinned by Tauri clients.
- Acceptance: a phone on shop Wi-Fi can log in, look up a part by scan, and mark QC. With TLS on, a client with the wrong
  certificate refuses to connect.

## M9: Linux move

- Install the same release on the Linux Hub (`packaging/linux/install.sh`), restore the latest Windows backup (the SQLite file is
  portable between OSes), and point clients at the new IP.
- Acceptance: the data matches by row counts and G-code SHA-256 values. All clients work after changing only the Hub address.

## CI notes (both targets)

- Workflow: `.github/workflows/build.yml`.
  - `test` matrix: `ubuntu-22.04` and `windows-2022`, Node 24, running `npm ci`, `npm run typecheck`, `npm test`.
  - `bundle` matrix:
    - Linux needs `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`, and builds `--bundles appimage,deb`.
    - Windows builds `--bundles nsis,msi`; WebView2 is bundled through `webviewInstallMode: offlineInstaller`.
    - Both run `node scripts/package-server.mjs` and upload the artifacts.
- Pin the WinSW version in the workflow (currently `v2.12.0`) and verify its SHA-256 before packaging.
- Add before the first real release:
  - Windows code signing (an OV/EV certificate held as a GitHub secret, never in the repo);
  - a `gitleaks` scan;
  - a release job on `v*` tags that attaches the installers and server packages;
  - a check that `server/src/version.ts`, `app/package.json` and `tauri.conf.json` versions match.
- A tagged release can only be cut when all checks are green on both OSes.
