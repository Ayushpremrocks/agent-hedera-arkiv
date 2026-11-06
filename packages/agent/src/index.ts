// Agent: books a slot from the provider (paying through x402), then either
//   sell: lists the slot on Arkiv and serves a swap endpoint (flexible agent), or
//   buy:  if its slot misses its deadline, finds an earlier slot on Arkiv and swaps for it (urgent agent).
//
//   pnpm agent sell --as AGENT_B --deadline 900 --price 2000000 --port 4101
//   pnpm agent buy  --as AGENT_A --deadline 150 --budget 5000000
import { ExpirationTime } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import type { PaymentRequired } from "@x402/core/types";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { parseArgs } from "node:util";
import {
  CUTOFF_SECONDS,
  HBAR,
  HttpError,
  type Job,
  NETWORK,
  ProviderProfile,
  type Res,
  SWAP_VALID_SECONDS,
  SlotOffer,
  type SwapTerms,
  Trade,
  accountEvm,
  arkivReader,
  arkivWriter,
  buildSwap,
  checkSwap,
  evmKey,
  findOffers,
  hashscan,
  hbarPayer,
  hederaClient,
  jobHash,
  need,
  parseKey,
  postEvent,
  postPaid,
  role,
  serve,
  signRequest,
  slotInfo,
} from "@qy/shared";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: "string" }, // role prefix in .env, e.g. AGENT_B
    deadline: { type: "string" }, // seconds from now by which the job must have finished
    price: { type: "string" }, // sell: minimum tinybars to give up the slot
    budget: { type: "string" }, // buy: maximum tinybars to pay for an earlier slot
    port: { type: "string", default: "4100" }, // sell: swap endpoint port
    url: { type: "string" }, // sell: public base URL of the swap endpoint (default http://localhost:<port>)
    seconds: { type: "string", default: "5" }, // simulated job runtime
    label: { type: "string" },
    "max-booking": { type: "string", default: "100000000" }, // x402 cap per booking payment (1 HBAR)
  },
});
const mode = positionals[0];
if (!o.as || !o.deadline || !((mode === "sell" && o.price) || (mode === "buy" && o.budget))) {
  console.error("usage: agent sell --as AGENT_X --deadline <s> --price <tinybars> [--port n]");
  console.error("       agent buy  --as AGENT_X --deadline <s> --budget <tinybars>");
  process.exit(2);
}

const now = () => Math.floor(Date.now() / 1000);
const me = role(o.as);
const client = hederaClient(me.id, me.key);
const deadline = now() + Number(o.deadline);
const reader = arkivReader();

// ---- discover the provider on Arkiv; only trust a profile written by the provider's own key ----
const providerId = need("PROVIDER_ID");
const profile = (
  await reader
    .select()
    .from(ProviderProfile)
    .where(eq("provider", providerId))
    .ownedBy((await accountEvm(providerId)) as `0x${string}`)
    .limit(1)
    .fetch()
).entities[0];
if (!profile) throw new Error(`no provider profile for ${providerId} on Arkiv; is the provider running?`);
// Arkiv returns each column as a typed {type, value} wrapper.
const tokenId = profile.token_id.value;
const topicId = profile.topic_id.value;
const bookingUrl = profile.booking_url.value;
const slotSeconds = Number(profile.slot_seconds.value);
const latestStart = deadline - slotSeconds; // a slot starting later can't finish by the deadline

// ---- book (x402) ----
const job: Job = { kind: "cpu", seconds: Number(o.seconds), label: o.label ?? `${o.as} ${mode}` };
const booked = await postPaid(
  `${bookingUrl}/book`,
  { job, ...signRequest("book", me.id, me.key, jobHash(job)) },
  hbarPayer(me.id, me.key, BigInt(o["max-booking"]!)),
);
if (booked.status !== 200) throw new Error(`booking failed (${booked.status}): ${booked.body.error}`);
const { serial, start } = booked.body as { serial: number; start: number };
console.log(`${me.id} booked slot #${serial} at ${start} (in ${start - now()}s), paid ${booked.body.price} tinybars`);
console.log(`  payment ${hashscan("transaction", booked.body.paymentTx)}`);

if (mode === "sell") await sell();
else await buy();

// =============================================================================================
async function sell() {
  if (start > latestStart) {
    console.log(`slot #${serial} already misses my own deadline (latest start ${latestStart}); not offering it`);
    return client.close();
  }
  const minPrice = BigInt(o.price!);
  const port = Number(o.port);
  const endpoint = `${o.url ?? `http://localhost:${port}`}/offers/${serial}/swap`;
  const writer = arkivWriter(evmKey(me.key));

  // The offer vanishes from Arkiv by itself once it can no longer be traded.
  const offer = await writer.createEntity(
    SlotOffer,
    {
      provider: providerId,
      slot_serial: u64(serial),
      slot_start: u64(start),
      latest_ok_start: u64(latestStart),
      min_price: u64(minPrice),
      seller: me.id,
      endpoint,
      job_hash: jobHash(job),
    },
    { expiration: ExpirationTime.atDate(new Date((start - CUTOFF_SECONDS) * 1000)) },
  );
  console.log(`offer ${offer.entityKey} on Arkiv: #${serial} for >= ${minPrice} tinybars, I accept any slot starting <= ${latestStart}`);

  let live = true;
  let busy = false;
  await serve(port, {
    "POST /offers/:serial/swap": async ({ params, body }): Promise<Res> => {
      if (Number(params.serial) !== serial || !live) throw new HttpError(410, "offer no longer available");
      if (busy) throw new HttpError(409, "another swap for this slot is in progress");
      busy = true; // one trade at a time; atomicity makes a second sale fail anyway, this just fails it early
      try {
        return await swap(body);
      } finally {
        busy = false;
      }
    },
  });
  console.log(`swap endpoint ${endpoint}`);

  async function swap(body: any): Promise<Res> {
    const buyer = String(body?.buyer ?? "");
    const buyerSerial = Number(body?.buyerSerial);
    if (!/^0\.0\.\d+$/.test(buyer) || !Number.isInteger(buyerSerial)) throw new HttpError(400, "need buyer and buyerSerial");
    if (now() > start - CUTOFF_SECONDS) {
      live = false;
      throw new HttpError(410, "my slot starts too soon to trade");
    }

    // Ask consensus, not Arkiv or the Mirror Node: who holds what, and when the buyer's slot runs.
    const [mine, theirs] = await Promise.all([slotInfo(client, tokenId, serial), slotInfo(client, tokenId, buyerSerial)]);
    if (mine.owner !== me.id) {
      live = false;
      throw new HttpError(410, "I no longer hold this slot");
    }
    if (theirs.owner !== buyer) throw new HttpError(403, `${buyer} does not hold slot #${buyerSerial}`);
    if (theirs.meta.s > latestStart) throw new HttpError(422, `slot #${buyerSerial} starts at ${theirs.meta.s}, after my latest acceptable start ${latestStart}`);
    if (theirs.meta.s < now() + CUTOFF_SECONDS) throw new HttpError(422, `slot #${buyerSerial} starts too soon to trade`);

    const terms: SwapTerms = { tokenId, seller: me.id, sellerSerial: serial, buyer, buyerSerial, price: minPrice };
    if (!body.tx) {
      // x402-shaped quote. Payment isn't a separate transfer: it rides inside the swap transaction.
      const required: PaymentRequired = {
        x402Version: 2,
        resource: { url: endpoint, description: `swap into slot #${serial}`, mimeType: "application/json" },
        accepts: [
          {
            scheme: "qy-atomic-swap",
            network: NETWORK,
            asset: HBAR,
            amount: minPrice.toString(),
            payTo: me.id,
            maxTimeoutSeconds: SWAP_VALID_SECONDS,
            extra: { tokenId, sellerSerial: serial, buyerSerial },
          },
        ],
      };
      return { status: 402, body: required, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } };
    }

    let tx;
    try {
      tx = checkSwap(Buffer.from(String(body.tx), "base64"), terms);
    } catch (e) {
      throw new HttpError(400, `rejected swap: ${(e as Error).message}`);
    }
    try {
      await (await (await tx.sign(parseKey(me.key))).execute(client)).getReceipt(client);
    } catch (e) {
      throw new HttpError(409, `swap did not settle: ${(e as Error).message}`);
    }
    live = false;
    const swapTx = tx.transactionId!.toString();
    console.log(`SOLD #${serial} to ${buyer} for ${minPrice} tinybars, now holding #${buyerSerial}: ${hashscan("transaction", swapTx)}`);

    // The trade already settled on Hedera; bookkeeping failures are logged, never returned as errors.
    const event = { type: "trade", sellerSerial: serial, buyerSerial, seller: me.id, buyer, price: minPrice.toString(), swapTx } as const;
    const hcsSeq = await postEvent(client, topicId, me.id, me.key, event).catch((e) => (console.error("HCS:", e.message), ""));
    await writer.deleteEntity({ entityKey: offer.entityKey }).catch((e) => console.error("Arkiv delete:", e.message));
    await writer
      .createEntity(
        Trade,
        { provider: providerId, seller_serial: u64(serial), buyer_serial: u64(buyerSerial), price: u64(minPrice), swap_tx: swapTx, hcs_seq: hcsSeq },
        { expiration: ExpirationTime.fromDays(1) },
      )
      .catch((e) => console.error("Arkiv trade:", e.message));
    return { body: { swapTx, hcsSeq, hashscan: hashscan("transaction", swapTx) } };
  }
}

// =============================================================================================
async function buy() {
  if (start <= latestStart) {
    console.log(`slot #${serial} already meets my deadline; nothing to buy`);
    return client.close();
  }
  const budget = BigInt(o.budget!);
  // Skip offers that would start before a signed swap could even expire.
  const want = { myStart: start, myLatest: latestStart, notBefore: now() + CUTOFF_SECONDS + SWAP_VALID_SECONDS, budget };
  const { entities: offers } = await findOffers(reader, providerId, want);
  console.log(`slot #${serial} misses my deadline by ${start - latestStart}s; ${offers.length} matching offer(s) on Arkiv`);

  for (const offer of offers) {
    try {
      const swapTx = await take(offer);
      console.log(`BOUGHT #${offer.slot_serial.value} from ${offer.seller.value}: ${hashscan("transaction", swapTx)}`);
      return client.close();
    } catch (e) {
      console.log(`  skipped offer ${offer.$key}: ${(e as Error).message}`);
    }
  }
  console.log("no offer worked; keeping my own slot");
  client.close();

  async function take(row: (typeof offers)[number]) {
    const offer = {
      key: row.$key,
      owner: row.$owner,
      seller: row.seller.value,
      endpoint: row.endpoint.value,
      slotStart: Number(row.slot_start.value),
    };
    const sellerSerial = Number(row.slot_serial.value);
    // Arkiv rows are claims: check who wrote it and what Hedera says before signing anything.
    if (offer.owner.toLowerCase() !== (await accountEvm(offer.seller))) throw new Error("offer was not written by the seller it names");
    const slot = await slotInfo(client, tokenId, sellerSerial);
    if (slot.owner !== offer.seller) throw new Error(`seller no longer holds #${sellerSerial}`);
    if (slot.meta.s !== offer.slotStart || slot.meta.s > latestStart) throw new Error("slot start on Hedera doesn't match the offer");

    const ask = await postPaid(offer.endpoint, { buyer: me.id, buyerSerial: serial });
    if (ask.status !== 402) throw new Error(`seller refused (${ask.status}): ${ask.body.error}`);
    const quote = ask.body.accepts?.[0];
    if (quote?.scheme !== "qy-atomic-swap" || quote.payTo !== offer.seller || quote.extra?.sellerSerial !== sellerSerial)
      throw new Error("seller quoted different terms than its offer");
    const price = BigInt(quote.amount);
    if (price > budget) throw new Error(`price ${price} over budget ${budget}`);

    const tx = await buildSwap(client, { tokenId, seller: offer.seller, sellerSerial, buyer: me.id, buyerSerial: serial, price }).sign(parseKey(me.key));
    const res = await postPaid(offer.endpoint, { buyer: me.id, buyerSerial: serial, tx: Buffer.from(tx.toBytes()).toString("base64") });
    if (res.status !== 200) throw new Error(`swap failed (${res.status}): ${res.body.error}`);
    return res.body.swapTx as string;
  }
}
