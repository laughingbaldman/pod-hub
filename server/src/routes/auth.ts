import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { canManageRole, createSession, createUser, hashPassword, isRole, login, logout, passwordProblem, ROLES, userCount, verifyPassword } from "../lib/auth.js";
import { HttpError, parseId, requirePerm, requireUser, type Hub } from "../context.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function authRoutes(app: FastifyInstance, hub: Hub) {
  const { db, cfg } = hub;

  app.get("/api/setup/status", async () => ({ needsSetup: userCount(db) === 0 }));

  // First-run: create the Superadmin. Only while no users exist, and only from the Hub PC itself.
  app.post("/api/setup", async (req) => {
    if (userCount(db) > 0) throw new HttpError(409, "Setup is already done.");
    if (!LOOPBACK.has(req.ip)) throw new HttpError(403, "Run first-time setup on the Hub computer itself.");
    const body = z.object({ username: z.string(), displayName: z.string().default(""), password: z.string() }).parse(req.body);
    const id = createUser(db, { ...body, role: "superadmin" });
    audit(db, null, "setup.superadmin_created", "user", id, { username: body.username }, req.ip);
    return { ok: true };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
    const result = login(db, body.username, body.password, cfg.sessionHours, req.ip, String(req.headers["user-agent"] ?? ""));
    if (!result.ok) {
      audit(db, null, "auth.login_failed", "user", body.username, { reason: result.reason }, req.ip);
      throw new HttpError(401, result.reason === "locked" ? "Too many tries. This account is locked for 15 minutes." : result.reason === "inactive" ? "This account is turned off." : "Wrong username or password.");
    }
    audit(db, result.user, "auth.login", "user", result.user.id, undefined, req.ip);
    return { token: result.token, expiresAt: result.expiresAt, user: result.user };
  });

  app.post("/api/auth/logout", async (req) => {
    if (req.token) logout(db, req.token);
    if (req.user) audit(db, req.user, "auth.logout", "user", req.user.id, undefined, req.ip);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({ user: requireUser(req) }));

  app.post("/api/auth/password", async (req) => {
    const user = requireUser(req);
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string };
    if (!verifyPassword(body.current, row.password_hash)) throw new HttpError(400, "Current password is wrong.");
    const problem = passwordProblem(body.next);
    if (problem) throw new HttpError(400, problem);
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hashPassword(body.next), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(user.id, "");
    audit(db, user, "auth.password_changed", "user", user.id, undefined, req.ip);
    return { ok: true, signInAgain: true };
  });

  app.get("/api/users", async (req) => {
    requirePerm(req, "users.manage");
    return db.prepare("SELECT id, username, display_name AS displayName, role, active, last_login_at AS lastLoginAt, created_at AS createdAt FROM users ORDER BY username").all();
  });

  app.post("/api/users", async (req) => {
    const actor = requirePerm(req, "users.manage");
    const body = z.object({ username: z.string(), displayName: z.string().default(""), role: z.enum(ROLES), password: z.string() }).parse(req.body);
    if (!canManageRole(actor.role, body.role)) throw new HttpError(403, "You can only create accounts below your own tier.");
    try {
      const id = createUser(db, { ...body, mustChange: true });
      audit(db, actor, "user.created", "user", id, { username: body.username, role: body.role }, req.ip);
      return { id };
    } catch (error) {
      throw new HttpError(400, (error as Error).message.includes("UNIQUE") ? "That username is taken." : (error as Error).message);
    }
  });

  app.patch("/api/users/:id", async (req) => {
    const actor = requirePerm(req, "users.manage");
    const id = parseId((req.params as { id: string }).id);
    const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: number; role: string } | undefined;
    if (!target || !isRole(target.role)) throw new HttpError(404, "No such user.");
    if (!canManageRole(actor.role, target.role) || id === actor.id) throw new HttpError(403, "You cannot change this account.");
    const body = z.object({ role: z.enum(ROLES).optional(), active: z.boolean().optional(), resetPassword: z.string().optional(), displayName: z.string().max(80).optional() }).parse(req.body);
    if (body.role && !canManageRole(actor.role, body.role)) throw new HttpError(403, "You cannot grant that tier.");
    if (body.role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.role, id);
    if (body.displayName !== undefined) db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(body.displayName, id);
    if (body.active !== undefined) {
      db.prepare("UPDATE users SET active = ? WHERE id = ?").run(body.active ? 1 : 0, id);
      if (!body.active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    if (body.resetPassword) {
      const problem = passwordProblem(body.resetPassword);
      if (problem) throw new HttpError(400, problem);
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?").run(hashPassword(body.resetPassword), id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    audit(db, actor, "user.updated", "user", id, { role: body.role, active: body.active, passwordReset: Boolean(body.resetPassword) }, req.ip);
    return { ok: true };
  });

  // Support impersonation: a short session flagged with the Superadmin's id; every action it takes is audited as such.
  app.post("/api/users/:id/impersonate", async (req) => {
    const actor = requirePerm(req, "impersonate");
    const id = parseId((req.params as { id: string }).id);
    if (id === actor.id) throw new HttpError(400, "That is you.");
    const target = db.prepare("SELECT id, username, display_name, role, active FROM users WHERE id = ?").get(id) as { id: number; username: string; display_name: string; role: string; active: number } | undefined;
    if (!target || !target.active) throw new HttpError(404, "No such active user.");
    const { token, expiresAt } = createSession(db, id, 1, req.ip, "impersonation", actor.id);
    audit(db, actor, "user.impersonate", "user", id, { as: target.username }, req.ip);
    return { token, expiresAt, user: { id: target.id, username: target.username, displayName: target.display_name, role: target.role, mustChangePassword: false, impersonatorId: actor.id } };
  });

  app.get("/api/audit", async (req) => {
    requirePerm(req, "audit.read");
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200), before: z.coerce.number().int().optional() }).parse(req.query);
    return q.before
      ? db.prepare("SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?").all(q.before, q.limit)
      : db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(q.limit);
  });
}
