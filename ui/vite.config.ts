import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// In dev (`bun run dev:ui`), Vite serves the UI with HMR and proxies the API
// to a running `lcr --no-open` (default port 4747, override with LCR_PORT).
const api = `http://127.0.0.1:${process.env.LCR_PORT ?? 4747}`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 5000 },
  server: {
    proxy: {
      "/api": api,
      "/ws": { target: api.replace("http", "ws"), ws: true },
    },
  },
});
