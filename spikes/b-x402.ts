// Spike (b): A pays B in HBAR through an x402 facilitator on hedera:testnet.
// Server and client run in-process; the HTTP 402 wiring is done later in the agent package.
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme as ClientScheme } from "@x402/hedera/exact/client";
import { ExactHederaScheme as ServerScheme } from "@x402/hedera/exact/server";
import { MIRROR, hashscan, need, parseKey, role } from "@qy/shared";

const A = role("AGENT_A");
const B = role("AGENT_B");
const PRICE = "1000000"; // tinybars = 0.01 HBAR

const balance = async (id: string) =>
  ((await (await fetch(`${MIRROR}/balances?account.id=${id}`)).json()) as any).balances[0]?.balance as number;

const facilitator = new HTTPFacilitatorClient({ url: need("X402_FACILITATOR_URL") });
const server = new x402ResourceServer(facilitator).register("hedera:testnet", new ServerScheme());
await server.initialize();

const reqs = await server.buildPaymentRequirements({
  scheme: "exact",
  network: "hedera:testnet",
  payTo: B.id,
  price: { asset: "0.0.0", amount: PRICE },
  maxTimeoutSeconds: 120,
});
const required = await server.createPaymentRequiredResponse(reqs, { url: "spike://swap" });
console.log("402 requirements:", JSON.stringify(required.accepts, null, 1));

const signer = createClientHederaSigner(A.id, parseKey(A.key), { network: "hedera:testnet" });
const client = new x402Client()
  .register("hedera:*", new ClientScheme(signer))
  // HBAR isn't a USD "default asset", so opt in explicitly with a hard per-payment cap.
  .setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: "100000000" }] });
const payload = await client.createPaymentPayload(required);

const match = server.findMatchingRequirements(reqs, payload);
if (!match) throw new Error("payload matches no requirement");
const before = await balance(B.id);
const verified = await server.verifyPayment(payload, match);
console.log("verify:", verified);
const settled = await server.settlePayment(payload, match);
console.log("settle:", settled);
if (!settled.success) process.exit(1);
console.log(hashscan("transaction", settled.transaction));

await new Promise((r) => setTimeout(r, 6000)); // mirror lag
console.log(`B balance ${before} -> ${await balance(B.id)} (expect +${PRICE})`);
console.log("spike (b) done");
