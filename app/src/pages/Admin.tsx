import { useCallback, useEffect, useState } from "react";
import { api, type Role, type User } from "../lib/api";
import { Banner } from "../components/Banner";

const ROLES: Role[] = ["superadmin", "admin", "staff", "user", "customer", "demo"];

interface Row {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  active: number;
  lastLoginAt: string | null;
}
interface Audit {
  id: number;
  at: string;
  username: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  detail: string | null;
  ip: string | null;
}

export function AdminPage({ user }: { user: User }) {
  const [users, setUsers] = useState<Row[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [nu, setNu] = useState({ username: "", displayName: "", role: "staff" as Role, password: "" });

  const load = useCallback(async () => {
    try {
      const [u, a] = await Promise.all([api<Row[]>("GET", "/api/users"), api<Audit[]>("GET", "/api/audit?limit=100")]);
      setUsers(u);
      setAudit(a);
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }, []);
  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<unknown>, ok: (r: unknown) => string) => {
    try {
      const r = await fn();
      setMsg({ kind: "ok", text: ok(r) });
      void load();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      <section className="card p-4">
        <h2 className="mb-2 font-display text-lg">Accounts</h2>
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Tier</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.displayName} <span className="mono text-xs text-muted">{u.username}</span>
                </td>
                <td>
                  <span className="chip">{u.role}</span>
                </td>
                <td className="text-sm">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
                <td className="text-right">
                  {u.id !== user.id && (
                    <button className="btn" onClick={() => run(() => api("PATCH", `/api/users/${u.id}`, { active: !u.active }), () => `${u.username} ${u.active ? "turned off" : "turned on"}.`)}>
                      {u.active ? "Turn off" : "Turn on"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="mt-3 grid gap-2 sm:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api("POST", "/api/users", nu), () => `Created ${nu.username}. They set their own password at first sign-in.`);
            setNu({ ...nu, username: "", displayName: "", password: "" });
          }}
        >
          <input className="card px-2 py-1.5" placeholder="username" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
          <input className="card px-2 py-1.5" placeholder="display name" value={nu.displayName} onChange={(e) => setNu({ ...nu, displayName: e.target.value })} />
          <select className="card px-2 py-1.5" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <input className="card px-2 py-1.5" type="password" placeholder="temporary password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
          <button className="btn btn-primary">Add account</button>
        </form>
      </section>

      <section className="card flex flex-wrap items-center gap-3 p-4">
        <h2 className="font-display text-lg">Data</h2>
        <button className="btn" onClick={() => run(() => api("POST", "/api/admin/backup"), (r) => `Backup written: ${(r as { file: string }).file}`)}>
          Back up now
        </button>
        {user.role === "superadmin" && (
          <label className="btn">
            Import The Floor export (.json)
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const text = await f.text();
                void run(() => api("POST", "/api/admin/import-book", JSON.parse(text)), (r) => {
                  const x = r as { parts: number; batches: number; printers: number; spools: number; skipped: string[] };
                  return `Imported ${x.parts} parts, ${x.batches} batches, ${x.printers} printers, ${x.spools} spools. Skipped ${x.skipped.length}.`;
                });
              }}
            />
          </label>
        )}
      </section>

      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 font-display text-lg">Audit log</h2>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>What</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td className="text-sm whitespace-nowrap">{new Date(a.at).toLocaleString()}</td>
                <td>{a.username ?? "—"}</td>
                <td className="mono text-xs">{a.action}</td>
                <td className="mono text-xs">
                  {a.entity} {a.entity_id}
                </td>
                <td className="mono text-xs">{a.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
