// Attack a live seller from a hostile buyer account while a fleet is running:
//   pnpm fleet --agents 3 --minutes 8      (in another terminal)
//   pnpm exec tsx spikes/attack-check.ts --as AGENT_D
// The attacker books a real slot, then tries to cheat a real seller. Every attempt must be refused
// before the seller signs anything, so no HBAR or slot can move.
import { ExpirationTime } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { parseArgs } from "node:util";
import {
  CUTOFF_SECONDS,
  type Job,
  ProviderProfile,
  SWAP_VALID_SECONDS,
  SlotOffer,
  arkivReader,
  arkivWriter,
  buildSwap,
  evmKey,
  findOffers,
  hbarPayer,
  hederaClient,
  jobHash,
  need,
  parseKey,
  postPaid,
  role,
  signRequest,
} from "@qy/shared";

const { values: o } = parseArgs({ options: { as: { type: "string", default: "AGENT_D" } } });
const X = role(o.as!);
const now = () => Math.floor(Date.now() / 1000);
function expect(label: string, ok: boolean, got: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} ${got}`);
  if (!ok) process.exitCode = 1;
}

const reader = arkivReader();
const providerId = need("PROVIDER_ID");
const profile = (await reader.select().from(ProviderProfile).where(eq("provider", providerId)).limit(1).fetch()).entities[0];
const bookingUrl = profile.booking_url.value;
const tokenId = profile.token_id.value;

// A real slot to offer in swaps.
const job: Job = { kind: "llm", task: "Reply with one word.", input: "attack check", maxTokens: 5, deadline: now() + 3600, label: "attack check" };
const booked = await postPaid(`${bookingUrl}/book`, { job, ...signRequest("book", X.id, X.key, jobHash(job)) }, hbarPayer(X.id, X.key, 1_000_000_000n));
if (booked.status !== 200) throw new Error(`attacker could not book: ${booked.status} ${booked.body.error}`);
const myTicket: number = booked.body.ticket;
const myStart: number = booked.body.startBy;
console.log(`attacker ${X.id} holds ticket #${myTicket} starting in ~${myStart - now()}s`);

// Wait for a live offer from a fleet seller that would accept this slot.
let offer;
for (let i = 0; i < 60 && !offer; i++) {
  const { entities } = await findOffers(reader, providerId, { myStart, myLatest: myStart, notBefore: now() + CUTOFF_SECONDS + SWAP_VALID_SECONDS, budget: 10n ** 12n });
  offer = entities.find((r) => r.seller.value !== X.id);
  if (!offer) await new Promise((r) => setTimeout(r, 5000));
}
if (!offer) throw new Error("no fleet offer accepts the attacker's slot; is a fleet running?");
const seller = offer.seller.value;
const sellerTicket = Number(offer.ticket.value);
const url = offer.endpoint.value;
console.log(`target: ${seller}'s ticket #${sellerTicket} at ${url}`);

// Tickets are NFTs only once tokenized; the attacker pays for that like any buyer.
const tickets = [sellerTicket, myTicket];
const tok = await postPaid(`${bookingUrl}/tickets/tokenize`, { tickets, ...signRequest("tokenize", X.id, X.key, tickets.join(",")) }, hbarPayer(X.id, X.key, 1_000_000_000n));
if (tok.status !== 200) throw new Error(`tokenize failed: ${tok.status} ${tok.body.error}`);
const sellerSerial = Number(tok.body.serials[sellerTicket]);
const mySerial = Number(tok.body.serials[myTicket]);

const notMine = await postPaid(url, { buyer: X.id, buyerTicket: sellerTicket });
expect("offering a ticket the attacker doesn't hold is refused (403)", notMine.status === 403, `${notMine.status} ${notMine.body.error}`);

const quote = await postPaid(url, { buyer: X.id, buyerTicket: myTicket });
expect("honest request gets the 402 terms", quote.status === 402, quote.status);
const price = BigInt(quote.body.accepts?.[0]?.amount ?? 0);

const client = hederaClient(X.id, X.key);
const send = async (tx: TransferTransaction) => {
  const signed = await tx.sign(parseKey(X.key));
  return postPaid(url, { buyer: X.id, buyerTicket: myTicket, tx: Buffer.from(signed.toBytes()).toString("base64") });
};
const legit = () =>
  new TransferTransaction().addNftTransfer(tokenId, sellerSerial, seller, X.id).addNftTransfer(tokenId, mySerial, X.id, seller).setTransactionValidDuration(SWAP_VALID_SECONDS);

// Correct slots and price, plus 1 HBAR from the seller to the attacker hidden in the same transaction.
const skim = await send(
  legit()
    .addHbarTransfer(X.id, Hbar.fromTinybars((-price + 100_000_000n).toString()))
    .addHbarTransfer(seller, Hbar.fromTinybars((price - 100_000_000n).toString()))
    .freezeWith(client),
);
expect("hidden extra debit from the seller is refused (400)", skim.status === 400, `${skim.status} ${skim.body.error}`);

const cheap = await send(buildSwap(client, { tokenId, seller, sellerSerial, buyer: X.id, buyerSerial: mySerial, price: price / 2n }));
expect("paying half the quote is refused (400)", cheap.status === 400, `${cheap.status} ${cheap.body.error}`);

const free = await send(legit().freezeWith(client));
expect("swapping without paying is refused (400)", free.status === 400, `${free.status} ${free.body.error}`);

// An offer written by the attacker in the seller's name: buyers must not trust it.
const fake = await arkivWriter(evmKey(X.key)).createEntity(
  SlotOffer,
  { provider: providerId, ticket: u64(sellerTicket), start_by: offer.start_by, max_tokens: offer.max_tokens, latest_ok_start: u64(now() + 3600), min_price: u64(1n), seller, endpoint: "http://localhost:9/evil", job_hash: "" },
  { expiration: ExpirationTime.fromSeconds(120) },
);
const forged = (await reader.select().from(SlotOffer).where(eq("provider", providerId)).fetch()).entities.find((r) => r.$key === fake.entityKey);
expect("a forged offer is visible on Arkiv but its owner isn't the seller", !!forged && forged.$owner.toLowerCase() !== offer.$owner.toLowerCase(), forged?.$owner);
console.log("(agents compare $owner with the seller's EVM address from the Mirror Node before trading, see take() in packages/agent)");
client.close();
