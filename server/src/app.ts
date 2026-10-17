import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { sessionUser } from "./lib/auth.js";
import { ensureDirs, type HubConfig } from "./lib/config.js";
import { openDb } from "./lib/db.js";
import { HttpError, type Hub } from "./context.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { gcodeRoutes } from "./routes/gcode.js";
import { partRoutes } from "./routes/parts.js";
import { printerRoutes } from "./routes/printers.js";
import { printRoutes, startPoller } from "./routes/print.js";
import { VERSION } from "./version.js";

// Origins of the desktop shell's webview (Tauri v2 on Windows / Linux) and the dev server.
const BUILTIN_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:5173", "http://127.0.0.1:5173"];

export async function buildApp(cfg: HubConfig, opts: { logger?: boolean; poll?: boolean } = {}): Promise<{ app: FastifyInstance; hub: Hub }> {
  ensureDirs(cfg);
  const db = openDb(path.join(cfg.dataDir, "hub.db"));
  const hub: Hub = { db, cfg, version: VERSION, startedAt: Date.now(), lastPollAt: null };

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: process.env.HUB_LOG_LEVEL ?? "info",
            redact: ["req.headers.authorization", "req.headers.cookie"],
            ...(process.env.HUB_LOG_STDOUT ? {} : { file: path.join(cfg.dataDir, "logs", "hub.log") }),
          },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });

  await app.register(cors, { origin: [...BUILTIN_ORIGINS, ...cfg.corsOrigins], credentials: false });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1, fields: 10 } });

  app.decorateRequest("user", null);
  app.decorateRequest("token", null);
  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    req.token = token || null;
    req.user = token ? sessionUser(db, token) : null;
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message, ...error.extra });
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    req.log.error({ err: error }, "unhandled");
    return reply.code(500).send({ error: "Something broke on the Hub server. It is in the log." });
  });

  authRoutes(app, hub);
  partRoutes(app, hub);
  gcodeRoutes(app, hub);
  printerRoutes(app, hub);
  printRoutes(app, hub);
  adminRoutes(app, hub);

  // Serve the built UI so phones / Android / any LAN browser can use http://<hub-ip>:<port>/
  // Repo layout: server/{src,dist} next to app/dist. Package layout: server/dist next to app-dist/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = cfg.appDistDir ?? [path.join(here, "..", "..", "app", "dist"), path.join(here, "..", "..", "app-dist")].find((d) => fs.existsSync(path.join(d, "index.html")));
  if (dist && fs.existsSync(path.join(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: path.resolve(dist), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found." });
      return reply.sendFile("index.html");
    });
  }

  let stopPoller = () => {};
  if (opts.poll !== false) stopPoller = startPoller(hub, (m) => app.log.warn(m));
  app.addHook("onClose", async () => {
    stopPoller();
    db.close();
  });
  return { app, hub };
}
