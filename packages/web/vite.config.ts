import { defineConfig, loadEnv } from "vite";

// Only public account ids leave the root .env: the provider to watch, and agent names for labels.
// Keys never do. VITE_ARKIV_ACCESS_KEY is optional; without it the page uses Arkiv's public endpoint.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const names: Record<string, string> = {};
  for (const n of ["A", "B", "C"]) if (env[`AGENT_${n}_ID`]) names[env[`AGENT_${n}_ID`]] = n;
  return {
    envDir: "../..",
    define: {
      __PROVIDER_ID__: JSON.stringify(env.PROVIDER_ID ?? ""),
      __AGENT_NAMES__: JSON.stringify(names),
    },
  };
});
