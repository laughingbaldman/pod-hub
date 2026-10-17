import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, atLeast, hms, serverUrl, token, type Finding, type Gcode, type Part, type Printer, type User } from "../lib/api";
import { Banner } from "./Banner";

interface Candidate {
  printer: Printer;
  findings: Finding[];
  compatible: boolean;
  clean: boolean;
}

/** Part → file → compatible idle printer → confirm. */
export function GcodePanel({ part, user }: { part: Part; user: User }) {
  const [files, setFiles] = useState<Gcode[]>([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState<Gcode | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setFiles(await api<Gcode[]>("GET", `/api/parts/${part.number}/gcode`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [part.number]);
  useEffect(() => void load(), [load]);

  const upload = async (file: File) => {
    setUploading(true);
    setError("");
    const form = new FormData();
    form.append("partFileVersion", part.fileVersion ?? "");
    form.append("file", file, file.name);
    try {
      await api("POST", `/api/parts/${part.number}/gcode`, form);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  const download = async (g: Gcode) => {
    const res = await fetch(`${serverUrl()}/api/gcode/${g.id}/download`, { headers: { Authorization: `Bearer ${token.get()}` } });
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: `part${g.partNumber}-v${g.version}-${g.originalName}` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <h3 className="font-display text-lg">G-code</h3>
        <input ref={input} type="file" accept=".gcode,.gco,.g" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <button className="btn ml-auto" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? "Uploading…" : "Upload G-code"}
        </button>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Ver</th>
              <th>Sliced for</th>
              <th>Slicer</th>
              <th>Time</th>
              <th>Filament</th>
              <th>Layers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map((g) => (
              <tr key={g.id}>
                <td className="mono">
                  v{g.version}
                  <div className="text-xs text-muted">{g.partFileVersion}</div>
                </td>
                <td>
                  {g.printerModel ?? <span className="text-hold">unknown</span>}
                  <div className="text-xs text-muted">
                    {g.nozzleMm ?? "?"} mm · {g.material ?? "?"} {g.bedX ? `· ${g.bedX}×${g.bedY}` : ""}
                  </div>
                </td>
                <td className="text-sm">
                  {g.slicer ?? "?"} <span className="mono text-xs text-muted">{g.slicerVersion}</span>
                </td>
                <td className="mono">{hms(g.estSeconds)}</td>
                <td className="mono">{g.filamentG ? `${g.filamentG} g` : "—"}</td>
                <td className="mono">{g.layers ?? "—"}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="btn mr-1" onClick={() => download(g)}>
                    ↓
                  </button>
                  <button className="btn btn-primary" disabled={g.status !== "active"} onClick={() => setSending(g)}>
                    Send
                  </button>
                </td>
              </tr>
            ))}
            {!files.length && (
              <tr>
                <td colSpan={7} className="text-muted">
                  No G-code yet. Upload the file you sliced in OrcaSlicer; the Hub reads printer, nozzle, time and grams from it.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {sending && <SendDialog file={sending} user={user} onClose={() => setSending(null)} />}
    </div>
  );
}

function SendDialog({ file, user, onClose }: { file: Gcode; user: User; onClose: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [pick, setPick] = useState<Candidate | null>(null);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Candidate[]>("GET", `/api/gcode/${file.id}/printers`)
      .then(setCandidates)
      .catch((e) => setResult({ kind: "error", text: (e as Error).message }));
  }, [file.id]);

  const warns = pick?.findings.filter((f) => f.level === "warn") ?? [];
  const canOverride = atLeast(user, "admin");

  const confirm = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      const r = await api<{ batchSku: string; remoteName: string }>("POST", "/api/print/send", { gcodeId: file.id, printerId: pick.printer.id, overrideReason: warns.length ? reason : undefined });
      setResult({ kind: "ok", text: `Sent to ${pick.printer.name}. Batch ${r.batchSku}. Printer file: ${r.remoteName}` });
    } catch (e) {
      const err = e as ApiError;
      setResult({ kind: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true">
      <div className="card flex max-h-[90dvh] w-full max-w-2xl flex-col gap-3 overflow-auto p-5">
        <div className="flex items-center">
          <h3 className="font-display text-lg">
            Send part {file.partNumber} · G-code v{file.version}
          </h3>
          <button className="btn ml-auto" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="text-sm text-muted">
          Sliced for {file.printerModel ?? "an unknown printer"}, {file.nozzleMm ?? "?"} mm nozzle, {file.material ?? "?"} · {hms(file.estSeconds)} · {file.filamentG ?? "?"} g
        </p>
        {!candidates && !result && <p className="text-muted">Checking printers…</p>}
        {candidates && !result?.text.startsWith("Sent") && (
          <ul className="flex flex-col gap-2">
            {candidates.map((c) => (
              <li key={c.printer.id}>
                <button
                  type="button"
                  disabled={!c.compatible}
                  onClick={() => setPick(c)}
                  className={`card w-full p-3 text-left ${pick?.printer.id === c.printer.id ? "border-primary" : ""} ${c.compatible ? "" : "opacity-60"}`}
                >
                  <div className="flex items-center gap-2">
                    <strong>{c.printer.name}</strong>
                    <span className="text-sm text-muted">{c.printer.model || c.printer.adapter}</span>
                    <span className={`chip ml-auto ${c.printer.state === "idle" ? "chip-primary" : "chip-accent"}`}>{c.printer.state}</span>
                  </div>
                  {c.findings.map((f) => (
                    <div key={f.code} className={`text-sm ${f.level === "block" ? "text-hold" : "text-accent"}`}>
                      {f.level === "block" ? "Blocked: " : "Warning: "}
                      {f.message}
                    </div>
                  ))}
                </button>
              </li>
            ))}
            {!candidates.length && <li className="text-muted">No printers yet. An Admin adds them under Printers.</li>}
          </ul>
        )}
        {pick && warns.length > 0 && !result && (
          <label className="field">
            {canOverride ? "Override reason (logged)" : "Needs an Admin to override"}
            <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={!canOverride} />
          </label>
        )}
        {result && <Banner kind={result.kind}>{result.text}</Banner>}
        {!result?.text.startsWith("Sent") && (
          <button className="btn btn-primary justify-center" disabled={!pick || busy || (warns.length > 0 && (!canOverride || !reason.trim()))} onClick={confirm}>
            {busy ? "Sending…" : pick ? `Confirm: print on ${pick.printer.name}` : "Pick a printer"}
          </button>
        )}
      </div>
    </div>
  );
}
