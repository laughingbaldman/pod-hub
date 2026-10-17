import type { Db } from "./db.js";
import type { SessionUser } from "./auth.js";

/** Append one line to the audit trail. The table refuses UPDATE/DELETE at the SQL level. */
export function audit(db: Db, actor: SessionUser | null, action: string, entity?: string, entityId?: string | number, detail?: unknown, ip?: string): void {
  const who = actor ? (actor.impersonatorId ? `${actor.username} (as impersonated by #${actor.impersonatorId})` : actor.username) : null;
  db.prepare("INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    actor?.id ?? null,
    who,
    action,
    entity ?? null,
    entityId === undefined ? null : String(entityId),
    detail === undefined ? null : JSON.stringify(detail).slice(0, 4000),
    ip ?? null,
  );
}
