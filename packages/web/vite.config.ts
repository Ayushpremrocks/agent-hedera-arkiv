import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Nothing from the root .env reaches the browser except VITE_* values (VITE_ARKIV_ACCESS_KEY is optional;
// without it the page uses Arkiv's public endpoint). Accounts are per user, never baked into the build.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const host = env.HOST_API ?? "http://localhost:4100";
  return {
    plugins: [react(), tailwindcss()],
    envDir: "../..",
    // The agent host serves /api; proxying keeps the app same-origin, on this machine or over the LAN.
    // changeOrigin: hosted backends (Railway) route by the Host header, so send theirs, not localhost's.
    server: { host: true, proxy: { "/api": { target: host, changeOrigin: true } } },
    preview: { host: true, proxy: { "/api": { target: host, changeOrigin: true } } },
    // Loaded lazily (on sign-in, on PDF drop), so the dev server would only find them then and re-bundle
    // mid-session, breaking open tabs ("Failed to fetch dynamically imported module"). Pre-bundle them up front.
    optimizeDeps: { include: ["@hashgraph/hedera-wallet-connect", "@hiero-ledger/sdk", "magic-sdk", "@magic-ext/hedera", "pdfjs-dist"] },
    define: {
      global: "globalThis", // WalletConnect's dependencies expect Node's global
    },
  };
});
