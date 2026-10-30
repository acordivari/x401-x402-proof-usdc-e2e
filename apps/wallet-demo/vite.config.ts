import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const ORCHESTRATOR = process.env.DEMO_SERVER_URL ?? "http://localhost:4040";

// Dev: Vite serves the SPA and proxies the API + Proof callback to the
// orchestrator (so the browser only ever talks to one origin — no CORS).
// Build: emits to ./dist, which the orchestrator serves in production.
export default defineConfig({
  plugins: [svelte({ preprocess: vitePreprocess({ script: true }) })],
  server: {
    port: 5173,
    proxy: {
      "/api": ORCHESTRATOR,
      "/proof": ORCHESTRATOR,
      // Latest variant: the verifier's CIMD, the x401 return channel, and the
      // emulated Proof wallet provider's APIs. The hosted wallet PAGE
      // (/emulator/proof/wallet/:id) is deliberately not proxied — Vite serves
      // the SPA for it in dev. Run the orchestrator with
      // PUBLIC_ORIGIN=http://localhost:5173 so links and return_uris point here.
      "/.well-known": ORCHESTRATOR,
      "/x401": ORCHESTRATOR,
      "/emulator/proof/handoff": ORCHESTRATOR,
      "/emulator/proof/wallet/signatures": ORCHESTRATOR,
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
