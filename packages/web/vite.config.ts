import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Only public account ids leave the root .env: the provider to watch, and agent names for labels.
// Keys never do. VITE_ARKIV_ACCESS_KEY is optional; without it the page uses Arkiv's public endpoint.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^AGENT_([A-Z0-9]+)_ID$/);
    if (m && v) names[v] = m[1];
  }
  const host = env.HOST_API ?? "http://localhost:4100";
  return {
    plugins: [react()],
    envDir: "../..",
    // The agent host serves /api; proxying keeps the app same-origin, on this machine or over the LAN.
    server: { host: true, proxy: { "/api": host } },
    preview: { host: true, proxy: { "/api": host } },
    define: {
      global: "globalThis", // WalletConnect's dependencies expect Node's global
      __PROVIDER_ID__: JSON.stringify(env.PROVIDER_ID ?? ""),
      __AGENT_NAMES__: JSON.stringify(names),
    },
  };
});
