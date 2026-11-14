import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/** The SPA is built next to the server bundle: `dist/web/`. */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  // Browser dev server only; the bridge owns `/api` in production.
  server: { proxy: { "/api": { target: "http://127.0.0.1:7801" } } },
});
