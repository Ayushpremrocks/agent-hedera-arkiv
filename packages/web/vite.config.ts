import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Nothing from the root .env reaches the browser except VITE_* values (VITE_ARKIV_ACCESS_KEY is optional;
// without it the page uses Arkiv's public endpoint). Accounts are per user, never baked into the build.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const host = env.HOST_API ?? "http://localhost:4100";
  return {
    plugins: [react()],
    envDir: "../..",
    // The agent host serves /api; proxying keeps the app same-origin, on this machine or over the LAN.
    server: { host: true, proxy: { "/api": host } },
    preview: { host: true, proxy: { "/api": host } },
    define: {
      global: "globalThis", // WalletConnect's dependencies expect Node's global
    },
  };
});
