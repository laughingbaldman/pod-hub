-- Core schema: accounts, audit, parts, batches, spools, printers, G-code library, print jobs.
-- SQLite (WAL). Money columns are intentionally absent until the finance milestone.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('superadmin','admin','staff','user','customer','demo')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL,
  client       TEXT,
  ip           TEXT,
  impersonator_id INTEGER REFERENCES users(id)
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Append-only audit trail. Triggers below refuse UPDATE and DELETE.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id    INTEGER,
  username   TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  detail     TEXT,
  ip         TEXT
);
CREATE INDEX audit_at ON audit_log(at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE parts (
  number              INTEGER PRIMARY KEY,           -- permanent, assigned once
  internal_name       TEXT NOT NULL,
  public_name         TEXT NOT NULL DEFAULT '',
  public_description  TEXT NOT NULL DEFAULT '',
  category            TEXT NOT NULL DEFAULT '',
  material            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'Draft'
                      CHECK (status IN ('Draft','Quoting','Printing','QC','Stock','Low','Shipped','Hold')),
  confidentiality     TEXT NOT NULL DEFAULT 'Internal'
                      CHECK (confidentiality IN ('Public','Internal','NDA','Patent pending')),
  listing_ready       INTEGER NOT NULL DEFAULT 0,
  grams               REAL NOT NULL DEFAULT 0,
  stock_units         INTEGER NOT NULL DEFAULT 0,
  reserved            INTEGER NOT NULL DEFAULT 0,
  bin                 TEXT NOT NULL DEFAULT '',
  lead                TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  file_version        TEXT NOT NULL DEFAULT '',
  gtin                TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (reserved >= 0 AND stock_units >= 0),
  CHECK (confidentiality = 'Public' OR listing_ready = 0)
);

CREATE TABLE spools (
  id             TEXT PRIMARY KEY,
  brand          TEXT NOT NULL DEFAULT '',
  material       TEXT NOT NULL,
  grams          REAL NOT NULL DEFAULT 0,
  nozzle_temp    INTEGER,
  bed_temp       INTEGER,
  flow           REAL,
  max_volumetric REAL,
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE batches (
  sku          TEXT PRIMARY KEY,                    -- part-month-year, -2/-3 for repeats
  part_number  INTEGER NOT NULL REFERENCES parts(number),
  month        INTEGER NOT NULL,
  year         INTEGER NOT NULL,
  printer      TEXT NOT NULL DEFAULT '',
  material     TEXT NOT NULL DEFAULT '',
  operator     TEXT NOT NULL DEFAULT '',
  qc           TEXT NOT NULL DEFAULT 'Pending' CHECK (qc IN ('Pass','Hold','Fail','Pending')),
  file_version TEXT NOT NULL DEFAULT '',
  profile      TEXT NOT NULL DEFAULT '',
  spool        TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX batches_part ON batches(part_number);

CREATE TABLE printers (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'printer' CHECK (kind IN ('printer','scanner')),
  adapter      TEXT NOT NULL,                       -- moonraker | octoprint | flashforge | sdcp | bambu | manual
  host         TEXT NOT NULL,                       -- IP or hostname typed by the user
  port         INTEGER NOT NULL,
  model        TEXT NOT NULL DEFAULT '',            -- compared with the slicer's printer_model
  nozzle_mm    REAL NOT NULL DEFAULT 0.4,
  bed_x        REAL NOT NULL DEFAULT 256,
  bed_y        REAL NOT NULL DEFAULT 256,
  bed_z        REAL NOT NULL DEFAULT 256,
  materials    TEXT NOT NULL DEFAULT '',            -- comma list it is allowed to run
  loaded_spool TEXT REFERENCES spools(id),
  map_x        REAL NOT NULL DEFAULT 0,
  map_y        REAL NOT NULL DEFAULT 0,
  zone         TEXT NOT NULL DEFAULT '',
  confidential INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  maintenance_reason TEXT,
  last_state   TEXT NOT NULL DEFAULT 'unknown',
  last_status  TEXT,                                -- JSON snapshot from the adapter
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Printer credentials (API keys, access codes) live apart from the printer row,
-- are never returned by the API, and are readable by the adapter layer only.
CREATE TABLE printer_secrets (
  printer_id INTEGER PRIMARY KEY REFERENCES printers(id) ON DELETE CASCADE,
  secret     TEXT NOT NULL                            -- JSON object, adapter-specific
);

CREATE TABLE gcode_files (
  id              INTEGER PRIMARY KEY,
  part_number     INTEGER NOT NULL REFERENCES parts(number),
  version         INTEGER NOT NULL,                 -- 1,2,3 per part
  part_file_version TEXT NOT NULL DEFAULT '',       -- the CAD/model revision it was sliced from
  original_name   TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  storage_path    TEXT NOT NULL,                    -- relative to the data dir
  slicer          TEXT,
  slicer_version  TEXT,
  printer_model   TEXT,
  nozzle_mm       REAL,
  material        TEXT,
  layer_height    REAL,
  layers          INTEGER,
  est_seconds     INTEGER,
  filament_g      REAL,
  filament_mm     REAL,
  bed_x           REAL,
  bed_y           REAL,
  max_z           REAL,
  meta_json       TEXT,                             -- full parsed header/config
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  notes           TEXT NOT NULL DEFAULT '',
  uploaded_by     INTEGER REFERENCES users(id),
  uploaded_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (part_number, version)
);
CREATE INDEX gcode_part ON gcode_files(part_number);

CREATE TABLE print_jobs (
  id           INTEGER PRIMARY KEY,
  gcode_id     INTEGER NOT NULL REFERENCES gcode_files(id),
  printer_id   INTEGER NOT NULL REFERENCES printers(id),
  batch_sku    TEXT REFERENCES batches(sku),
  spool_id     TEXT REFERENCES spools(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  state        TEXT NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued','uploading','printing','paused','complete','failed','cancelled')),
  remote_name  TEXT,
  override_reason TEXT,                             -- set when an Admin overrode a pre-send warning
  message      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at   TEXT,
  ended_at     TEXT
);
CREATE INDEX print_jobs_printer ON print_jobs(printer_id);

CREATE TABLE queue_items (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  owner       TEXT NOT NULL DEFAULT '',
  due         TEXT,
  part_number INTEGER REFERENCES parts(number),
  account     TEXT NOT NULL DEFAULT '',
  done        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE deadlines (
  id     TEXT PRIMARY KEY,
  title  TEXT NOT NULL,
  owner  TEXT NOT NULL DEFAULT '',
  due    TEXT,
  filed  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE shift_log (
  id   INTEGER PRIMARY KEY,
  at   TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
