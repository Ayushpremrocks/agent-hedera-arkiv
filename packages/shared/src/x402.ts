import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { parseKey } from "./hedera.js";

export const NETWORK = "hedera:testnet";
export const HBAR = "0.0.0"; // x402 asset id for native HBAR; amounts are tinybars

/** An x402 client that pays HBAR from `id`, never more than `maxTinybars` per payment. */
export function hbarPayer(id: string, key: string, maxTinybars: bigint) {
  const signer = createClientHederaSigner(id, parseKey(key), { network: NETWORK });
  return new x402Client()
    .register("hedera:*", new ExactHederaScheme(signer))
    // HBAR isn't a USD "default asset", so opt in explicitly with a hard per-payment cap.
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: HBAR, maxAmountPerPayment: maxTinybars.toString() }] });
}

/**
 * POST JSON. On 402, pay through x402 and retry with the PAYMENT-SIGNATURE header. If the price rose
 * in between, the server re-quotes without settling anything, so pay the new quote (a few times at
 * most; the payer's spend cap still bounds every payment).
 */
export async function postPaid(url: string, body: unknown, payer?: x402Client, attempts = 3, timeoutMs = 60_000, payTo?: string) {
  const post = (headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs), // a peer that never answers can't stall the caller
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  let res = await post();
  for (let i = 0; i < attempts && res.status === 402 && payer; i++) {
    const required = res.headers.get("payment-required");
    if (!required) break;
    const terms = decodePaymentRequiredHeader(required);
    // Paying into escrow is what backs the refund: refuse terms that pay anyone else.
    if (payTo && terms.accepts.some((a) => a.payTo !== payTo)) throw new Error(`asked to pay ${terms.accepts.map((a) => a.payTo).join(", ")}, not the escrow ${payTo}`);
    const payload = await payer.createPaymentPayload(terms);
    res = await post({ "payment-signature": encodePaymentSignatureHeader(payload) });
  }
  return { status: res.status, body: (await res.json()) as any };
}
