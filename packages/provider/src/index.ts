// Provider: sells execution slots as HTS NFTs and runs whichever job belongs to each slot's
// current owner when the slot starts.
import { ExpirationTime } from "@arkiv-network/sdk";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import {
  type HcsEvent,
  HttpError,
  MAX_JOB_SECONDS,
  ProviderProfile,
  arkivReader,
  arkivWriter,
  decodeSlot,
  evmKey,
  hashscan,
  hederaClient,
  jobHash,
  nftOwner,
  ownedSerials,
  parseJob,
  postEvent,
  role,
  serve,
  tokenNfts,
  verifyRequest,
} from "@qy/shared";
import { ensureInfra, issueSlot } from "./chain.js";
import { runJob } from "./runner.js";
import { pending, savePending } from "./store.js";

const PORT = Number(process.env.PROVIDER_PORT ?? 4000);
const BOOKING_URL = process.env.PROVIDER_URL ?? `http://localhost:${PORT}`;
const SLOT_SECONDS = Number(process.env.SLOT_SECONDS ?? 30);
const WORKERS = Number(process.env.WORKERS ?? 2); // slots per start time = jobs run in parallel
const LEAD_SECONDS = Number(process.env.LEAD_SECONDS ?? 120); // earliest bookable start, leaves time to trade
if (MAX_JOB_SECONDS >= SLOT_SECONDS) throw new Error("SLOT_SECONDS must exceed MAX_JOB_SECONDS");

const P = role("PROVIDER");
const T = role("TREASURY");
const client = hederaClient(P.id, P.key);
const { tokenId, topicId } = await ensureInfra(client, P, T);
console.log(`provider ${P.id}  token ${hashscan("token", tokenId)}  topic ${hashscan("topic", topicId)}`);

/** HCS logging never blocks or breaks the caller; failures are only printed. */
function log(event: HcsEvent) {
  console.log(event);
  postEvent(client, topicId, P.id, P.key, event).catch((e) => console.error("HCS post failed:", e.message));
}

// ---- schedule: start time -> serials (null = reserved while minting) ----
const slots = new Map<number, (number | null)[]>();
const now = () => Math.floor(Date.now() / 1000);

function place(start: number, serial: number | null) {
  if (!slots.has(start)) {
    slots.set(start, []);
    setTimeout(() => dispatch(start), Math.max(0, start * 1000 - Date.now()));
  }
  slots.get(start)!.push(serial);
}

/** Reserve the earliest start with a free worker. Synchronous, so concurrent bookings can't collide. */
function reserve(): number {
  let start = Math.ceil((now() + LEAD_SECONDS) / SLOT_SECONDS) * SLOT_SECONDS;
  while ((slots.get(start)?.length ?? 0) >= WORKERS) start += SLOT_SECONDS;
  place(start, null);
  return start;
}

function settle(start: number, serial: number | null) {
  const list = slots.get(start)!;
  list.splice(list.indexOf(null), 1);
  if (serial !== null) list.push(serial);
}

async function dispatch(start: number) {
  const serials = (slots.get(start) ?? []).filter((s): s is number => s !== null);
  slots.delete(start);
  await Promise.all(serials.map((serial) => runSlot(serial, start)));
}

async function runSlot(serial: number, start: number) {
  let owner: string;
  try {
    owner = await nftOwner(tokenId, serial); // ownership is whatever Hedera says now, after any swaps
  } catch (e) {
    return console.error(`slot #${serial}: owner lookup failed`, e);
  }
  const p = pending.get(owner);
  log({ type: "dispatch", serial, start, owner, jobHash: p?.hash ?? null });
  if (!p) return; // owner never bound a job: the slot idles
  pending.delete(owner);
  savePending();

  const t0 = Date.now();
  try {
    const r = await runJob(p.job, `${serial}:${p.hash}`);
    log({ type: "done", serial, owner, jobHash: p.hash, ok: true, result: `${r.digest}/${r.iterations}`, ms: Date.now() - t0 });
  } catch (e) {
    log({ type: "done", serial, owner, jobHash: p.hash, ok: false, result: (e as Error).message, ms: Date.now() - t0 });
  }
}

// Rebuild upcoming slots from the NFTs themselves, so a restart loses nothing.
for (const nft of await tokenNfts(tokenId)) {
  const { s } = decodeSlot(nft.metadata);
  if (!nft.deleted && s > now() - SLOT_SECONDS) place(s, nft.serial_number);
}
console.log(`restored ${[...slots.values()].flat().length} upcoming slots, ${pending.size} pending jobs`);

// ---- HTTP ----
async function authed(action: string, body: any) {
  let job;
  try {
    job = parseJob(body?.job);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const hash = jobHash(job);
  try {
    return { job, hash, account: await verifyRequest(action, hash, body) };
  } catch (e) {
    throw new HttpError(401, (e as Error).message);
  }
}

await serve(PORT, {
  /** Buy a slot: mints a slot NFT to the caller and stores the job privately. */
  "POST /book": async ({ body }) => {
    const { job, hash, account } = await authed("book", body);
    if (pending.has(account)) throw new HttpError(409, "account already has a pending job; use /bind to replace it");
    pending.set(account, { job, hash }); // claim first so a parallel /book from the same account gets 409

    const start = reserve();
    let issued;
    try {
      issued = await issueSlot(client, tokenId, T, account, { s: start, h: hash });
    } catch (e) {
      settle(start, null);
      pending.delete(account);
      throw e;
    }
    settle(start, issued.serial);
    savePending();
    log({ type: "booked", serial: issued.serial, start, owner: account, jobHash: hash });
    return { body: { serial: issued.serial, start, tokenId, topicId, transferTx: issued.transferTx } };
  },

  /** Replace the caller's pending job. Only accounts currently holding a slot may bind. */
  "POST /bind": async ({ body }) => {
    const { job, hash, account } = await authed("bind", body);
    const held = await ownedSerials(account, tokenId);
    if (!held.length) throw new HttpError(403, "account holds no slot");
    pending.set(account, { job, hash });
    savePending();
    log({ type: "bound", account, jobHash: hash });
    return { body: { jobHash: hash, slots: held } };
  },
});
console.log(`listening on ${BOOKING_URL}`);

// Publish (or refresh) the provider profile on Arkiv so agents can discover token, topic and URL.
const writer = arkivWriter(evmKey(P.key));
const profile = { provider: P.id, token_id: tokenId, topic_id: topicId, slot_seconds: u64(SLOT_SECONDS), booking_url: BOOKING_URL };
const existing = (
  await arkivReader().select({ $key: true }).from(ProviderProfile).where(eq("provider", P.id)).ownedBy(writer.account.address).limit(1).fetch()
).entities[0];
if (existing) {
  await writer.patchEntity(ProviderProfile, existing.$key, { set: profile });
  await writer.extendEntity({ entityKey: existing.$key, expiration: ExpirationTime.fromDays(7) });
} else {
  await writer.createEntity(ProviderProfile, profile, { expiration: ExpirationTime.fromDays(7) });
}
console.log("provider profile on Arkiv:", existing ? `updated ${existing.$key}` : "created");
