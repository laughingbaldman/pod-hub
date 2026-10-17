import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The UI is served three ways: Vite dev server, the Tauri window, and by the Hub server itself
// for LAN browsers / Android. API calls go to the configured Hub address (see src/lib/api.ts).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  build: { outDir: "dist", target: "es2022", sourcemap: true },
});
