import { useCallback, useEffect, useState } from "react";
import { api, atLeast, type Part, type User } from "../lib/api";
import { Banner } from "../components/Banner";
import { GcodePanel } from "../components/GcodePanel";

export function PartsPage({ user }: { user: User }) {
  const [parts, setParts] = useState<Part[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [newMaterial, setNewMaterial] = useState("PETG");

  const load = useCallback(async () => {
    try {
      setParts(await api<Part[]>("GET", `/api/parts${q ? `?q=${encodeURIComponent(q)}` : ""}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [q]);
  useEffect(() => void load(), [load]);

  const internal = atLeast(user, "user");
  const part = parts.find((p) => p.number === selected) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex gap-2">
          <input className="card flex-1 px-3 py-2" placeholder="Search parts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search parts" />
        </div>
        {error && <Banner kind="error">{error}</Banner>}
        {atLeast(user, "staff") && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api<{ number: number }>("POST", "/api/parts", { internalName: newName, material: newMaterial });
                setNewName("");
                await load();
                setSelected(r.number);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <input className="card min-w-40 flex-1 px-3 py-2" placeholder="New part name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input className="card w-28 px-3 py-2" value={newMaterial} onChange={(e) => setNewMaterial(e.target.value)} aria-label="Material" />
            <button className="btn btn-primary" disabled={!newName.trim()}>
              Cut part
            </button>
          </form>
        )}
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Material</th>
                {internal && <th>Status</th>}
                {internal && <th>Stock</th>}
                {internal && <th>Flag</th>}
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => (
                <tr key={p.number} className="row" onClick={() => setSelected(p.number)} aria-selected={p.number === selected}>
                  <td className="mono">{p.number}</td>
                  <td>{internal ? p.internalName : p.name}</td>
                  <td>{p.material}</td>
                  {internal && <td><span className={`chip ${p.status === "Hold" ? "chip-hold" : ""}`}>{p.status}</span></td>}
                  {internal && <td className="mono">{p.stockUnits}{p.reserved ? ` (${p.reserved} res)` : ""}</td>}
                  {internal && <td><span className={`chip ${p.confidentiality === "Public" ? "chip-primary" : "chip-accent"}`}>{p.confidentiality}</span></td>}
                </tr>
              ))}
              {!parts.length && (
                <tr>
                  <td colSpan={6} className="text-muted">No parts yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="min-w-0">{part ? <PartDetail key={part.number} part={part} user={user} onChanged={load} /> : <p className="text-muted">Pick a part.</p>}</section>
    </div>
  );
}

function PartDetail({ part, user, onChanged }: { part: Part; user: User; onChanged: () => void }) {
  const [notes, setNotes] = useState(part.notes ?? "");
  const [fileVersion, setFileVersion] = useState(part.fileVersion ?? "");
  const [msg, setMsg] = useState("");
  const staff = atLeast(user, "staff");
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api("PATCH", `/api/parts/${part.number}`, patch);
      setMsg("Saved.");
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="card p-4">
        <div className="flex items-baseline gap-3">
          <span className="mono text-2xl text-primary">#{part.number}</span>
          <h2 className="font-display text-xl">{part.internalName ?? part.name}</h2>
        </div>
        <p className="text-sm text-muted">
          {part.material} · {part.category || "no category"} {part.bin ? `· bin ${part.bin}` : ""}
        </p>
        {staff && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="field">
              Model / file revision
              <input value={fileVersion} onChange={(e) => setFileVersion(e.target.value)} onBlur={() => fileVersion !== part.fileVersion && save({ fileVersion })} />
            </label>
            <label className="field sm:col-span-2">
              Notes (staff only)
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (part.notes ?? "") && save({ notes })} />
            </label>
          </div>
        )}
        {msg && <p className="mt-2 text-sm text-muted">{msg}</p>}
      </div>
      {staff ? <GcodePanel part={part} user={user} /> : <p className="text-sm text-muted">G-code files are visible to Staff and above.</p>}
    </div>
  );
}
