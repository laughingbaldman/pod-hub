import type { FastifyReply, FastifyRequest } from "fastify";
import type { HubConfig } from "./lib/config.js";
import type { Db } from "./lib/db.js";
import { can, type Permission, type SessionUser } from "./lib/auth.js";

export interface Hub {
  db: Db;
  cfg: HubConfig;
  version: string;
  startedAt: number;
  lastPollAt: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    token: string | null;
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, "Sign in first.");
  return req.user;
}

export function requirePerm(req: FastifyRequest, perm: Permission): SessionUser {
  const user = requireUser(req);
  if (user.mustChangePassword && perm !== "parts.read") throw new HttpError(403, "Change your password first.");
  if (!can(user.role, perm)) throw new HttpError(403, "Your role cannot do that.");
  return user;
}

export function parseId(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "Bad id.");
  return n;
}

export function send(reply: FastifyReply, status: number, body: unknown) {
  return reply.code(status).send(body);
}
