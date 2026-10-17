/**
 * Local accounts for an offline LAN install: username + password, six tiers, server-side
 * permission checks, lockout after repeated failures, opaque session tokens stored hashed.
 */
import crypto from "node:crypto";
import type { Db } from "./db.js";

export const ROLES = ["superadmin", "admin", "staff", "user", "customer", "demo"] as const;
export type Role = (typeof ROLES)[number];

const LEVEL: Record<Role, number> = { superadmin: 6, admin: 5, staff: 4, user: 3, customer: 2, demo: 1 };

export const PERMISSIONS = {
  "parts.read": "demo",
  "parts.internal": "user", // see Internal parts, bins, stock
  "parts.private": "staff", // see NDA / patent-pending parts and notes
  "parts.write": "staff",
  "gcode.read": "staff",
  "gcode.upload": "staff",
  "print.send": "staff",
  "print.override": "admin",
  "printers.read": "user",
  "printers.manage": "admin",
  "users.manage": "admin",
  "audit.read": "admin",
  "backup.run": "admin",
  "import.run": "superadmin",
  "impersonate": "superadmin",
} as const satisfies Record<string, Role>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return LEVEL[role] >= LEVEL[PERMISSIONS[permission]];
}

/** An actor may only create or edit accounts below their own tier (superadmin may edit any). */
export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === "superadmin") return true;
  return can(actor, "users.manage") && LEVEL[target] < LEVEL[actor];
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// scrypt parameters: N=2^15 is ~50 ms on a desktop CPU; fine for an interactive login.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password.normalize("NFKC"), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = crypto.scryptSync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (password.length > 200) return "Password is too long.";
  return null;
}

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  impersonatorId: number | null;
}

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export type LoginResult =
  | { ok: true; token: string; user: SessionUser; expiresAt: string }
  | { ok: false; reason: "invalid" | "locked" | "inactive" };

export function login(db: Db, username: string, password: string, hours: number, ip: string, client: string): LoginResult {
  const row = db
    .prepare("SELECT id, username, display_name, role, password_hash, active, failed_logins, locked_until, must_change_password FROM users WHERE username = ?")
    .get(username) as
    | { id: number; username: string; display_name: string; role: Role; password_hash: string; active: number; failed_logins: number; locked_until: string | null; must_change_password: number }
    | undefined;
  if (!row) {
    // Spend the same time as a real check so usernames can't be probed by timing.
    verifyPassword(password, hashPassword("timing-pad"));
    return { ok: false, reason: "invalid" };
  }
  if (!row.active) return { ok: false, reason: "inactive" };
  if (row.locked_until && row.locked_until > new Date().toISOString()) return { ok: false, reason: "locked" };
  if (!verifyPassword(password, row.password_hash)) {
    const fails = row.failed_logins + 1;
    const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
    db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : fails, lock, row.id);
    return { ok: false, reason: lock ? "locked" : "invalid" };
  }
  db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  const { token, expiresAt } = createSession(db, row.id, hours, ip, client, null);
  return {
    ok: true,
    token,
    expiresAt,
    user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role, mustChangePassword: Boolean(row.must_change_password), impersonatorId: null },
  };
}

export function createSession(db: Db, userId: number, hours: number, ip: string, client: string, impersonatorId: number | null) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, client, ip, impersonator_id) VALUES (?, ?, ?, ?, ?, ?)").run(
    sha256(token),
    userId,
    expiresAt,
    client.slice(0, 120),
    ip,
    impersonatorId,
  );
  return { token, expiresAt };
}

export function sessionUser(db: Db, token: string): SessionUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.active, u.must_change_password, s.expires_at, s.impersonator_id
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as
    | { id: number; username: string; display_name: string; role: Role; active: number; must_change_password: number; expires_at: string; impersonator_id: number | null }
    | undefined;
  if (!row || !row.active || row.expires_at <= new Date().toISOString()) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, mustChangePassword: Boolean(row.must_change_password), impersonatorId: row.impersonator_id };
}

export function logout(db: Db, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function createUser(db: Db, input: { username: string; displayName: string; role: Role; password: string; mustChange?: boolean }): number {
  const problem = passwordProblem(input.password);
  if (problem) throw new Error(problem);
  if (!/^[a-z0-9._-]{2,40}$/i.test(input.username)) throw new Error("Username: 2-40 letters, digits, dot, dash or underscore.");
  const result = db
    .prepare("INSERT INTO users (username, display_name, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?)")
    .run(input.username, input.displayName || input.username, input.role, hashPassword(input.password), input.mustChange ? 1 : 0);
  return Number(result.lastInsertRowid);
}

export function userCount(db: Db): number {
  return (db.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n;
}
