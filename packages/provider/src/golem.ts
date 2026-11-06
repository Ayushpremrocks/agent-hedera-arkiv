// Rent a machine on the Golem Network, run an LLM server on it, and expose that server's API on a local
// port. A Dani.ai provider then sells the machine's capacity: run it with
// LLM_BASE_URL=http://localhost:<port>/v1. The provider calibrates its speed through the tunnel, so its
// promises reflect the rented machine, not this laptop.
//
// The machine runs Golem's plain Debian Node image; we upload a llama.cpp server build and a GGUF model
// to it (Golem's registry no longer has a ready Ollama image). llama-server speaks the same
// OpenAI-compatible API as Ollama, so nothing else changes.
//
//   yagna service run          (YAGNA_AUTOCONF_APPKEY=<key>; the Windows build works, though Golem only supports Linux)
//   yagna payment fund         (testnet: free tGLM)
//   GOLEM_FILES=<dir with llama.tgz and model.gguf> node --import tsx src/golem.ts
//
// Testnet has CPU machines only. GPUs are on Polygon mainnet (GOLEM_GPU=1, paid in GLM) and would need
// llama.cpp's CUDA build instead.
import { GolemNetwork } from "@golem-sdk/golem-js";

const PORT = Number(process.env.GOLEM_PORT ?? 11500);
const GPU = process.env.GOLEM_GPU === "1";
const FILES = process.env.GOLEM_FILES ?? "./golem-files";
const LLAMA_DIR = process.env.LLAMA_DIR ?? "llama-b12177"; // top folder inside llama.tgz
const WORK = process.env.GOLEM_WORKDIR ?? "/golem/work";
const HOURS = Number(process.env.GOLEM_RENT_HOURS ?? 1);
const PARALLEL = Number(process.env.GOLEM_PARALLEL ?? 2); // concurrent requests llama-server serves

const glm = new GolemNetwork({
  api: { key: process.env.YAGNA_APPKEY ?? "try_golem" },
  // Files go over yagna's WebSocket API: the gftp helper is refused by yagna 0.18 on Windows
  // ("Manager service address is outside its reserved namespace").
  dataTransferProtocol: "ws",
  ...(GPU ? { payment: { driver: "erc20", network: "polygon" } } : {}),
});
let stopping = false;
process.on("SIGINT", () => (stopping = true));

await glm.connect();
const network = await glm.createNetwork({ ip: "192.168.7.0/24" });
console.log(`looking for a ${GPU ? "GPU (mainnet)" : "CPU (testnet)"} provider...`);
// shortcut: no timeout on finding a provider; Ctrl+C stops the process.
const rental = await glm.oneOf({
  order: {
    demand: {
      workload: {
        imageTag: "golem/node:20",
        minMemGib: 2,
        minCpuThreads: 2,
        capabilities: GPU ? ["!exp:gpu", "vpn"] : ["vpn"],
        runtime: { name: GPU ? "vm-nvidia" : "vm" },
      },
    },
    market: {
      rentHours: HOURS,
      pricing: GPU
        ? { model: "linear", maxStartPrice: 0, maxCpuPerHourPrice: 0, maxEnvPerHourPrice: 2 }
        : { model: "linear", maxStartPrice: 0.5, maxCpuPerHourPrice: 1, maxEnvPerHourPrice: 0.5 },
    },
    network,
  },
});
try {
  const exe = await rental.getExeUnit();
  console.log(`rented ${exe.provider.name} (${exe.provider.id}); uploading llama.cpp and the model...`);
  const t0 = Date.now();
  await exe.uploadFile(`${FILES}/llama.tgz`, `${WORK}/llama.tgz`);
  await exe.uploadFile(`${FILES}/model.gguf`, `${WORK}/model.gguf`);
  console.log(`uploaded in ${Math.round((Date.now() - t0) / 1000)}s; starting llama-server...`);
  const unpack = await exe.run(`cd ${WORK} && tar xzf llama.tgz && nproc && ls ${LLAMA_DIR} | head -3`);
  if (unpack.result !== "Ok") throw new Error(`unpack failed: ${unpack.stderr}`);
  console.log(`cpu threads on the provider: ${String(unpack.stdout).split("\n")[0]}`);

  let ready = false;
  const server = await exe.runAndStream(
    `cd ${WORK} && LD_LIBRARY_PATH=${WORK}/${LLAMA_DIR} ./${LLAMA_DIR}/llama-server -m model.gguf --host 0.0.0.0 --port 11434 -c ${2048 * PARALLEL} -np ${PARALLEL}`,
  );
  const watch = (d: unknown) => {
    const text = String(d);
    if (/listening/i.test(text)) ready = true;
    if (/error|fail/i.test(text)) console.error("provider !!", text.trim().slice(0, 300));
  };
  server.stdout.subscribe(watch);
  server.stderr.subscribe(watch);
  while (!ready && !stopping && !server.isFinished()) await new Promise((r) => setTimeout(r, 2000));
  if (!ready) throw new Error("llama-server stopped before it was ready");
  const proxy = exe.createTcpProxy(11434);
  proxy.events.on("error", (e) => console.error("tunnel error:", e));
  await proxy.listen(PORT);
  console.log(`GOLEM READY http://localhost:${PORT}/v1 on ${exe.provider.name}`);
  while (!server.isFinished() && !stopping) await new Promise((r) => setTimeout(r, 3000));
  await proxy.close();
} finally {
  await rental.stopAndFinalize();
  await glm.disconnect();
}
