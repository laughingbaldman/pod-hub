export function Banner({ kind = "info", children }: { kind?: "info" | "error" | "ok"; children: React.ReactNode }) {
  const color = kind === "error" ? "border-hold text-hold" : kind === "ok" ? "border-primary text-primary" : "border-line text-muted";
  return <div className={`border px-3 py-2 text-sm ${color}`}>{children}</div>;
}
