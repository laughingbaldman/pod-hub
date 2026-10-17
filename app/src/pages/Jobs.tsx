import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface Job {
  id: number;
  state: string;
  printer_name: string;
  part_number: number;
  gcode_version: number;
  batch_sku: string;
  spool_id: string | null;
  username: string;
  created_at: string;
  message: string | null;
  override_reason: string | null;
}

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    const load = () => api<Job[]>("GET", "/api/print/jobs").then(setJobs).catch(() => undefined);
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="card overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Job</th>
            <th>When</th>
            <th>Batch</th>
            <th>Part / G-code</th>
            <th>Printer</th>
            <th>Spool</th>
            <th>By</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td className="mono">{j.id}</td>
              <td className="text-sm">{new Date(j.created_at).toLocaleString()}</td>
              <td className="mono">{j.batch_sku}</td>
              <td className="mono">
                #{j.part_number} v{j.gcode_version}
              </td>
              <td>{j.printer_name}</td>
              <td className="mono">{j.spool_id ?? "—"}</td>
              <td>{j.username}</td>
              <td>
                <span className={`chip ${j.state === "failed" ? "chip-hold" : j.state === "printing" ? "chip-accent" : ""}`}>{j.state}</span>
                {j.message && <div className="text-xs text-muted">{j.message}</div>}
                {j.override_reason && <div className="text-xs text-accent">override: {j.override_reason}</div>}
              </td>
            </tr>
          ))}
          {!jobs.length && (
            <tr>
              <td colSpan={8} className="text-muted">
                No print jobs yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
