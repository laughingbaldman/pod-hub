import { useCallback, useEffect, useState } from "react";
import { api, atLeast, token, type User } from "./lib/api";
import { Login } from "./pages/Login";
import { PartsPage } from "./pages/Parts";
import { PrintersPage } from "./pages/Printers";
import { JobsPage } from "./pages/Jobs";
import { AdminPage } from "./pages/Admin";
import { Mark } from "./components/Mark";

type Station = "parts" | "printers" | "jobs" | "admin";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [station, setStation] = useState<Station>("parts");

  const refresh = useCallback(async () => {
    if (!token.get()) {
      setUser(null);
      setChecking(false);
      return;
    }
    try {
      setUser((await api<{ user: User }>("GET", "/api/auth/me")).user);
    } catch {
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const out = () => setUser(null);
    window.addEventListener("hub-signed-out", out);
    return () => window.removeEventListener("hub-signed-out", out);
  }, [refresh]);

  if (checking) return <main className="grid h-dvh place-items-center text-muted">Connecting…</main>;
  if (!user) return <Login onSignedIn={setUser} />;

  const nav: { id: Station; label: string; show: boolean }[] = [
    { id: "parts", label: "Parts", show: true },
    { id: "printers", label: "Printers", show: atLeast(user, "user") },
    { id: "jobs", label: "Print jobs", show: atLeast(user, "user") },
    { id: "admin", label: "Admin", show: atLeast(user, "admin") },
  ];

  const signOut = async () => {
    await api("POST", "/api/auth/logout").catch(() => undefined);
    token.clear();
    setUser(null);
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-4 border-b border-line px-4 py-2">
        <Mark />
        <nav className="flex gap-1" aria-label="Stations">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <button key={n.id} type="button" onClick={() => setStation(n.id)} className={`px-3 py-1.5 text-sm ${station === n.id ? "bg-primary text-on-primary" : "text-muted hover:text-fg"}`}>
                {n.label}
              </button>
            ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user.impersonatorId && <span className="chip chip-hold">Impersonating</span>}
          <span className="text-muted">
            {user.displayName} <span className="chip">{user.role}</span>
          </span>
          <button type="button" className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto p-4">
        {user.mustChangePassword ? (
          <ChangePassword onDone={signOut} />
        ) : station === "parts" ? (
          <PartsPage user={user} />
        ) : station === "printers" ? (
          <PrintersPage user={user} />
        ) : station === "jobs" ? (
          <JobsPage />
        ) : (
          <AdminPage user={user} />
        )}
      </main>
    </div>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="card mx-auto mt-10 flex max-w-sm flex-col gap-3 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("POST", "/api/auth/password", { current, next });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <h1 className="font-display text-xl">Set a new password</h1>
      <p className="text-sm text-muted">An admin set a temporary password for you. Pick your own (10+ characters).</p>
      <label className="field">
        Temporary password
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="field">
        New password
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </label>
      {error && <p className="text-sm text-hold">{error}</p>}
      <button className="btn btn-primary" type="submit">
        Save and sign in again
      </button>
    </form>
  );
}
