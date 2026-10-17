import { useCallback, useEffect, useState } from "react";
import { api, atLeast, type Printer, type User } from "../lib/api";
import { Banner } from "../components/Banner";

interface PrinterType {
  type: string;
  label: string;
  defaultPort: number;
  implemented: boolean;
  secretFields: { key: string; label: string; required: boolean }[];
}

export function PrintersPage({ user }: { user: User }) {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [types, setTypes] = useState<PrinterType[]>([]);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState<number | null>(null);
  const admin = atLeast(user, "admin");

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([api<Printer[]>("GET", "/api/printers"), api<PrinterType[]>("GET", "/api/printer-types")]);
      setPrinters(p);
      setTypes(t);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const check = async (id: number) => {
    setChecking(id);
    try {
      await api("POST", `/api/printers/${id}/test`);
    } finally {
      setChecking(null);
      void load();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <Banner kind="error">{error}</Banner>}
      <section>
        <h2 className="mb-2 font-display text-lg">Floor</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {printers.map((p) => (
            <div key={p.id} className="card flex flex-col gap-1 p-3">
              <div className="flex items-center gap-2">
                <strong>{p.name}</strong>
                <span className={`chip ml-auto ${p.state === "idle" ? "chip-primary" : p.state === "printing" ? "chip-accent" : p.state === "offline" || p.state === "error" ? "chip-hold" : ""}`}>{p.maintenanceReason ? "down" : p.state}</span>
              </div>
              <div className="text-sm text-muted">{p.model || "model not set"}</div>
              <div className="mono text-xs text-muted">
                {p.adapter} · {p.host || "no address"}:{p.port} · {p.nozzleMm} mm · {p.bedX}×{p.bedY}×{p.bedZ}
              </div>
              {p.status?.state === "printing" && typeof p.status.progress === "number" && (
                <div className="h-1.5 bg-line">
                  <div className="h-full bg-accent" style={{ width: `${Math.round(p.status.progress * 100)}%` }} />
                </div>
              )}
              {p.status?.message && <div className="text-xs text-muted">{p.status.message}</div>}
              {p.maintenanceReason && <div className="text-xs text-hold">{p.maintenanceReason}</div>}
              <button className="btn mt-1 self-start" disabled={checking === p.id || !p.host} onClick={() => check(p.id)}>
                {checking === p.id ? "Checking…" : "Check connection"}
              </button>
            </div>
          ))}
          {!printers.length && <p className="text-muted">No printers yet.</p>}
        </div>
      </section>
      {admin && <AddPrinter types={types} onAdded={load} />}
    </div>
  );
}

function AddPrinter({ types, onAdded }: { types: PrinterType[]; onAdded: () => void }) {
  const [adapter, setAdapter] = useState("moonraker");
  const [form, setForm] = useState({ name: "", host: "", port: "", model: "", nozzleMm: "0.4", bedX: "256", bedY: "256", bedZ: "256", materials: "", zone: "" });
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const type = types.find((t) => t.type === adapter);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("POST", "/api/printers", {
        adapter,
        name: form.name,
        host: form.host,
        port: form.port ? Number(form.port) : undefined,
        model: form.model,
        nozzleMm: Number(form.nozzleMm),
        bedX: Number(form.bedX),
        bedY: Number(form.bedY),
        bedZ: Number(form.bedZ),
        materials: form.materials,
        zone: form.zone,
        secret: Object.keys(secret).length ? secret : undefined,
      });
      setMsg({ kind: "ok", text: `Added ${form.name}. Use "Check connection" on its card.` });
      setForm({ ...form, name: "", host: "" });
      setSecret({});
      onAdded();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  };

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-4">
      <h2 className="font-display text-lg">Add a printer by IP</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="field">
          Type
          <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Name
          <input value={form.name} onChange={set("name")} placeholder="Bay 4" required />
        </label>
        <label className="field">
          IP address
          <input value={form.host} onChange={set("host")} placeholder="192.168.1.50" required />
        </label>
        <label className="field">
          Port
          <input value={form.port} onChange={set("port")} placeholder={String(type?.defaultPort ?? "")} inputMode="numeric" />
        </label>
        <label className="field sm:col-span-2">
          Model (as the slicer names it)
          <input value={form.model} onChange={set("model")} placeholder="e.g. the printer_model in your Orca profile" />
        </label>
        <label className="field">
          Nozzle mm
          <input value={form.nozzleMm} onChange={set("nozzleMm")} inputMode="decimal" />
        </label>
        <label className="field">
          Bed X × Y × Z (mm)
          <div className="flex gap-1">
            <input className="w-full" value={form.bedX} onChange={set("bedX")} aria-label="Bed X" />
            <input className="w-full" value={form.bedY} onChange={set("bedY")} aria-label="Bed Y" />
            <input className="w-full" value={form.bedZ} onChange={set("bedZ")} aria-label="Bed Z" />
          </div>
        </label>
        <label className="field">
          Allowed materials (comma list)
          <input value={form.materials} onChange={set("materials")} placeholder="any" />
        </label>
        {type?.secretFields.map((f) => (
          <label key={f.key} className="field">
            {f.label}
            <input type="password" autoComplete="off" value={secret[f.key] ?? ""} onChange={(e) => setSecret({ ...secret, [f.key]: e.target.value })} required={f.required} />
          </label>
        ))}
      </div>
      {type && !type.implemented && <Banner>{type.label}: the Hub tracks it on the floor but cannot send files to it yet.</Banner>}
      {adapter === "moonraker" && <p className="text-xs text-muted">Klipper is usually port 7125. Elegoo Neptune 4 printers answer on port 80.</p>}
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      <button className="btn btn-primary self-start">Add printer</button>
    </form>
  );
}
