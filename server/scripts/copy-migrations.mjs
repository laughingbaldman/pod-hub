// Copies SQL migrations next to the compiled server so the packaged build is self-contained.
import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
cpSync(path.join(here, "..", "migrations"), path.join(here, "..", "dist", "migrations"), { recursive: true });
