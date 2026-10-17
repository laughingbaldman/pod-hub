import { useEffect, useState } from "react";
import { api, serverUrl, servedByHub, setServerUrl, token, type User } from "../lib/api";
import { Mark } from "../components/Mark";

export function Login({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [server, setServer] = useState(serverUrl());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean }>("GET", "/api/setup/status")
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch(() => undefined);
  }, [server]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!servedByHub()) setServerUrl(server);
      if (needsSetup) {
        await api("POST", "/api/setup", { username, displayName: username, password });
        setNeedsSetup(false);
      }
      const r = await api<{ token: string; user: User }>("POST", "/api/auth/login", { username, password });
      token.set(r.token);
      onSignedIn(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid h-dvh place-items-center p-6">
      <form onSubmit={submit} className="card flex w-full max-w-sm flex-col gap-3 p-6">
        <Mark />
        <h1 className="font-display text-2xl">{needsSetup ? "Create the first account" : "Sign in"}</h1>
        {needsSetup && <p className="text-sm text-muted">No accounts yet. This one becomes the Superadmin. Do this on the Hub computer itself.</p>}
        {!servedByHub() && (
          <label className="field">
            Hub address
            <input value={server} onChange={(e) => setServer(e.target.value)} onBlur={() => setServerUrl(server)} placeholder="http://192.168.1.10:8787" />
          </label>
        )}
        <label className="field">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label className="field">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={needsSetup ? "new-password" : "current-password"} />
        </label>
        {error && <p className="text-sm text-hold">{error}</p>}
        <button className="btn btn-primary justify-center" type="submit" disabled={busy || !username || !password}>
          {busy ? "…" : needsSetup ? "Create and sign in" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
