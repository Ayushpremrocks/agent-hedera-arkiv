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

/** POST JSON. On 402, pay once through x402 and retry with the PAYMENT-SIGNATURE header. */
export async function postPaid(url: string, body: unknown, payer?: x402Client) {
  const post = (headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let res = await post();
  const required = res.headers.get("payment-required");
  if (res.status === 402 && payer && required) {
    const payload = await payer.createPaymentPayload(decodePaymentRequiredHeader(required));
    res = await post({ "payment-signature": encodePaymentSignatureHeader(payload) });
  }
  return { status: res.status, body: (await res.json()) as any };
}
