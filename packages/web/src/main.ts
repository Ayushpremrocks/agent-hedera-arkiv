// Read-only market view. Everything comes straight from public sources: Arkiv (profile, offers,
// trades) and the Hedera Mirror Node (slot NFTs, HCS log). No backend, no keys.
import { asc, eq, render } from "@arkiv-network/sdk/query";
import { ProviderProfile, SlotOffer, Trade, type Want, arkivReader, findOffers, offerFilter } from "@qy/shared/arkiv";
import { keccak256, recoverAddress, toBytes } from "viem";

declare const __PROVIDER_ID__: string;
declare const __AGENT_NAMES__: Record<string, string>;

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const HASHSCAN = "https://hashscan.io/testnet";
const NOT_BEFORE_SECONDS = 45; // CUTOFF_SECONDS + SWAP_VALID_SECONDS in shared/src/swap.ts
const REFRESH_MS = 6000;
const PAST_SECONDS = 120; // how much history the schedule shows
const AHEAD_SECONDS = 240;

const providerId = new URLSearchParams(location.search).get("provider") || __PROVIDER_ID__;
const names = __AGENT_NAMES__;
const reader = arkivReader(import.meta.env.VITE_ARKIV_ACCESS_KEY ?? "");

// ---------- helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const now = () => Date.now() / 1000;
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const hbar = (tiny: bigint | number | string) => `${+(Number(tiny) / 1e8).toFixed(4)} HBAR`;
const isAccount = (s: unknown): s is string => typeof s === "string" && /^0\.0\.\d+$/.test(s);
function inHuman(secs: number) {
  const s = Math.round(Math.abs(secs));
  const t = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  return secs >= 0 ? `in ${t}` : `${t} ago`;
}

const AGENT_COLORS: Record<string, string> = { A: "#C8326B", B: "#23786A", C: "#6550C8" };
const OTHER_COLORS = ["#B5651D", "#3B6FB6", "#7A8B2E"];
function color(id: string) {
  const n = names[id];
  if (n) return AGENT_COLORS[n];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return OTHER_COLORS[h % OTHER_COLORS.length];
}
const nameOf = (id: string) => (names[id] ? `Agent ${names[id]}` : id === providerId ? "Provider" : id);
const who = (id: string) =>
  `<span class="who"><i style="background:${color(id)}"></i>${esc(nameOf(id))}</span>`;

async function mirror<T = any>(path: string): Promise<T> {
  const res = await fetch(`${MIRROR}${path}`);
  if (!res.ok) throw new Error(`Mirror Node ${path} answered ${res.status}`);
  return res.json();
}

/** EVM address of a Hedera account, cached. Arkiv entities and HCS signatures are checked against it. */
const evmCache = new Map<string, Promise<string>>();
function evmOf(id: string) {
  if (!evmCache.has(id)) {
    const p = mirror(`/accounts/${id}`).then((a) => String(a.evm_address).toLowerCase());
    p.catch(() => evmCache.delete(id));
    evmCache.set(id, p);
  }
  return evmCache.get(id)!;
}

// ---------- state ----------
type Slot = { serial: number; start: number; owner: string };
type Ev = { seq: number; ts: number; by: string; verified: boolean; e: any };
type Offer = { key: string; serial: number; start: number; latestOk: number; minPrice: bigint; seller: string; byOwner: boolean };
type TradeRow = { key: string; sellerSerial: number; buyerSerial: number; price: bigint; swapTx: string; hcsSeq: string };

let profile: { tokenId: string; topicId: string; slotSeconds: number } | null = null;
let slots: Slot[] = [];
let events: Ev[] = [];
let offers: Offer[] = [];
let trades: TradeRow[] = [];
let matched: Set<string> | null = null;
let updatedAt = 0;
let error = "";
const verifiedCache = new Map<number, Ev>();

// ---------- loading ----------
async function loadProfile() {
  const owner = (await evmOf(providerId)) as `0x${string}`;
  const row = (await reader.select().from(ProviderProfile).where(eq("provider", providerId)).ownedBy(owner).limit(1).fetch()).entities[0];
  if (!row) throw new Error(`No provider profile for ${providerId} on Arkiv yet. Start the provider with pnpm provider.`);
  profile = { tokenId: row.token_id.value, topicId: row.topic_id.value, slotSeconds: Number(row.slot_seconds.value) };
  $("refs").innerHTML = [
    ["Provider account", `${HASHSCAN}/account/${providerId}`, providerId],
    ["Slot token", `${HASHSCAN}/token/${profile.tokenId}`, profile.tokenId],
    ["Log topic", `${HASHSCAN}/topic/${profile.topicId}`, profile.topicId],
  ]
    .map(([label, href, id]) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} <span>${esc(id)}</span></a>`)
    .join("");
}

/** A message counts as signed by `by` only if the signature recovers to that account's EVM address. */
async function verify(body: string, by: string, sig: string) {
  if (!/^[0-9a-f]{128}$/i.test(sig)) return false;
  const hash = keccak256(toBytes(body));
  const want = await evmOf(by);
  for (const v of ["1b", "1c"]) {
    try {
      if ((await recoverAddress({ hash, signature: `0x${sig}${v}` })).toLowerCase() === want) return true;
    } catch {}
  }
  return false;
}

async function parseMessage(m: any): Promise<Ev | null> {
  const seq = Number(m.sequence_number);
  if (verifiedCache.has(seq)) return verifiedCache.get(seq)!;
  try {
    const env = JSON.parse(atob(m.message));
    if (!isAccount(env.by) || typeof env.body !== "string") return null;
    const ev: Ev = { seq, ts: Number(m.consensus_timestamp), by: env.by, verified: await verify(env.body, env.by, String(env.sig)), e: JSON.parse(env.body) };
    verifiedCache.set(seq, ev);
    return ev;
  } catch {
    return null; // anyone can post to the topic; unreadable messages are skipped
  }
}

async function refresh() {
  if (!profile) await loadProfile();
  const { tokenId, topicId } = profile!;
  const [nfts, msgs, offerRows, tradeRows] = await Promise.all([
    mirror(`/tokens/${tokenId}/nfts?limit=100&order=desc`),
    mirror(`/topics/${topicId}/messages?limit=100&order=desc`),
    reader.select().from(SlotOffer).where(eq("provider", providerId)).orderBy(asc("slot_start")).limit(50).fetch(),
    reader.select().from(Trade).where(eq("provider", providerId)).limit(50).fetch(),
  ]);

  slots = [];
  for (const n of nfts.nfts as any[]) {
    if (n.deleted) continue;
    try {
      slots.push({ serial: n.serial_number, start: JSON.parse(atob(n.metadata)).s, owner: n.account_id });
    } catch {}
  }
  events = (await Promise.all((msgs.messages as any[]).map(parseMessage))).filter((x): x is Ev => !!x);

  offers = await Promise.all(
    offerRows.entities.map(async (r) => {
      const seller = r.seller.value;
      return {
        key: r.$key,
        serial: Number(r.slot_serial.value),
        start: Number(r.slot_start.value),
        latestOk: Number(r.latest_ok_start.value),
        minPrice: r.min_price.value,
        seller,
        byOwner: isAccount(seller) && r.$owner.toLowerCase() === (await evmOf(seller).catch(() => "")),
      };
    }),
  );
  trades = tradeRows.entities.map((r) => ({
    key: r.$key,
    sellerSerial: Number(r.seller_serial.value),
    buyerSerial: Number(r.buyer_serial.value),
    price: r.price.value,
    swapTx: r.swap_tx.value,
    hcsSeq: r.hcs_seq.value,
  }));
  updatedAt = now();
  error = "";
  renderData();
}

// ---------- rendering ----------
function statusOf(serial: number, start: number) {
  const dispatch = events.find((x) => x.verified && x.by === providerId && x.e.type === "dispatch" && x.e.serial === serial);
  const done = events.find((x) => x.verified && x.by === providerId && x.e.type === "done" && x.e.serial === serial);
  if (done) return done.e.ok ? { kind: "ran", text: `ran ${(done.e.ms / 1000).toFixed(1)}s`, owner: done.e.owner } : { kind: "killed", text: String(done.e.result).startsWith("timeout") ? "killed at end" : "failed", owner: done.e.owner };
  if (dispatch) return dispatch.e.jobHash ? { kind: "running", text: "running", owner: dispatch.e.owner } : { kind: "idle", text: "no job", owner: dispatch.e.owner };
  if (start > now()) return { kind: "waiting", text: "waiting", owner: null };
  return { kind: "idle", text: "not run", owner: null };
}

function renderChart() {
  const svg = $("chart") as unknown as SVGSVGElement;
  if (!profile) return;
  const slot = profile.slotSeconds;
  const t0 = now() - PAST_SECONDS;
  const t1 = now() + AHEAD_SECONDS;
  const W = 1000, G = 64, LANE = 58, TOP = 56, BLOCK = 44;
  const x = (t: number) => G + ((t - t0) / (t1 - t0)) * (W - G - 8);

  const visible = slots.filter((s) => s.start + slot > t0 && s.start < t1).sort((a, b) => a.start - b.start || a.serial - b.serial);
  const byStart = new Map<number, Slot[]>();
  for (const s of visible) byStart.set(s.start, [...(byStart.get(s.start) ?? []), s]);
  const lanes = Math.max(2, ...[...byStart.values()].map((l) => l.length));
  const H = TOP + lanes * LANE + 28;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const pos = new Map<number, { cx: number; y: number }>();
  let out = "";
  for (let i = 0; i < lanes; i++) {
    const y = TOP + i * LANE;
    out += `<rect class="lane" x="${G}" y="${y}" width="${W - G - 8}" height="${BLOCK}" />`;
    out += `<text class="lane-label" x="${G - 10}" y="${y + BLOCK / 2 + 4}" text-anchor="end">Worker ${i + 1}</text>`;
  }
  for (let t = Math.ceil(t0 / 60) * 60; t < t1; t += 60) {
    out += `<line class="tick" x1="${x(t)}" x2="${x(t)}" y1="${TOP - 6}" y2="${TOP + lanes * LANE}" />`;
    out += `<text class="tick-label" x="${x(t)}" y="${TOP + lanes * LANE + 16}" text-anchor="middle">${clock(t).slice(0, 5)}</text>`;
  }
  for (const [start, list] of byStart) {
    list.forEach((s, i) => {
      const st = statusOf(s.serial, s.start);
      const owner = st.owner ?? s.owner;
      const c = color(owner);
      const bx = Math.max(G, x(s.start) + 1);
      const bw = Math.min(x(start + slot) - 1, W - 8) - bx;
      if (bw <= 2) return;
      const y = TOP + i * LANE;
      pos.set(s.serial, { cx: bx + bw / 2, y });
      const tip = `Slot #${s.serial}, ${clock(s.start)}, held by ${nameOf(owner)}: ${st.text}`;
      out += `<g class="block ${st.kind}" style="--c:${c}"><title>${esc(tip)}</title>`;
      out += `<rect x="${bx}" y="${y}" width="${bw}" height="${BLOCK}" rx="3" />`;
      if (st.kind === "killed") out += `<rect class="hatch" x="${bx}" y="${y}" width="${bw}" height="${BLOCK}" rx="3" />`;
      if (bw > 40) {
        out += `<text class="b1" x="${bx + 6}" y="${y + 18}">#${s.serial} ${esc(names[owner] ?? "")}</text>`;
        out += `<text class="b2" x="${bx + 6}" y="${y + 34}">${esc(st.text)}</text>`;
      }
      out += `</g>`;
    });
  }
  // Swaps: an arc over the two slots that changed hands, labelled with the price.
  for (const t of events) {
    if (!t.verified || t.e.type !== "trade" || t.by !== t.e.seller) continue;
    const a = pos.get(t.e.sellerSerial);
    const b = pos.get(t.e.buyerSerial);
    if (!a || !b) continue;
    const apex = Math.min(a.y, b.y) - 40;
    const mx = (a.cx + b.cx) / 2;
    out += `<path class="arc" d="M ${a.cx} ${a.y} Q ${mx} ${apex} ${b.cx} ${b.y}" />`;
    out += `<text class="arc-label" x="${mx}" y="${apex + 14}" text-anchor="middle">swapped for ${esc(hbar(t.e.price))}</text>`;
  }
  if (!visible.length)
    out += `<text class="empty-chart" x="${(G + W) / 2}" y="${TOP + (lanes * LANE) / 2}" text-anchor="middle">No slots in this window. A new booking shows up about two minutes ahead of now.</text>`;
  const nx = x(now());
  out += `<line class="now" x1="${nx}" x2="${nx}" y1="${TOP - 14}" y2="${TOP + lanes * LANE - 8}" />`;
  out += `<text class="now-label" x="${nx}" y="${TOP - 18}" text-anchor="middle">now</text>`;
  svg.innerHTML = out;

  const owners = [...new Set(visible.map((s) => statusOf(s.serial, s.start).owner ?? s.owner))];
  $("legend").innerHTML =
    owners.map((o) => `<li>${who(o)} <span class="muted">${esc(o)}</span></li>`).join("") +
    `<li class="key"><b class="k waiting"></b>waiting</li><li class="key"><b class="k ran"></b>ran</li>` +
    `<li class="key"><b class="k killed"></b>killed at slot end</li><li class="key"><b class="k idle"></b>no job</li>`;
}

function renderOffers() {
  const live = offers.filter((o) => o.start > now());
  if (!live.length) {
    $("offers").innerHTML = `<p class="empty">No slots for sale right now. List one with <code>pnpm agent sell --as AGENT_B --deadline 900 --price 2000000</code>.</p>`;
    return;
  }
  const rows = live.map((o) => {
    const holder = slots.find((s) => s.serial === o.serial)?.owner;
    const check = !o.byOwner
      ? `<span class="warn">Not written by ${esc(o.seller)}</span>`
      : holder && holder !== o.seller
        ? `<span class="warn">Seller no longer holds it</span>`
        : `Written by the seller`;
    return `<tr class="${matched?.has(o.key) ? "hit" : ""}">
      <td>#${o.serial}</td>
      <td>${clock(o.start)} <span class="muted">${inHuman(o.start - now())}</span></td>
      <td>${who(o.seller)}</td>
      <td class="num">${hbar(o.minPrice)}</td>
      <td>${clock(o.latestOk)}</td>
      <td>${check}</td></tr>`;
  });
  $("offers").innerHTML = `<table><thead><tr><th>Slot</th><th>Starts</th><th>Seller</th><th class="num">Asks at least</th><th>Seller accepts slots up to</th><th>Check</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderTrades() {
  if (!trades.length) {
    $("trades").innerHTML = `<p class="empty">No trades yet. A buyer whose slot misses its deadline trades with <code>pnpm agent buy --as AGENT_A --deadline 150 --budget 5000000</code>.</p>`;
    return;
  }
  const rows = trades
    .map((t) => ({ t, ev: events.find((x) => x.verified && x.e.type === "trade" && x.e.swapTx === t.swapTx) }))
    .sort((a, b) => (b.ev?.ts ?? 0) - (a.ev?.ts ?? 0))
    .map(({ t, ev }) => {
      const parties = ev ? `${who(ev.e.seller)} to ${who(ev.e.buyer)}` : `<span class="muted">not in recent log</span>`;
      return `<tr>
        <td>${ev ? clock(ev.ts) : ""}</td>
        <td>#${t.sellerSerial} for #${t.buyerSerial}</td>
        <td>${parties}</td>
        <td class="num">${hbar(t.price)}</td>
        <td><a href="${HASHSCAN}/transaction/${encodeURIComponent(t.swapTx)}" target="_blank" rel="noopener">Swap transaction</a></td></tr>`;
    });
  $("trades").innerHTML = `<table><thead><tr><th>Time</th><th>Slots</th><th>Seller to buyer</th><th class="num">Price</th><th>Proof</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function describe(ev: Ev) {
  const e = ev.e;
  const n = (id: unknown) => (isAccount(id) ? esc(nameOf(id)) : "?");
  switch (e.type) {
    case "booked": return `${n(e.owner)} booked slot #${e.serial} for ${clock(e.start)}`;
    case "bound": return `${n(e.account)} bound a new job`;
    case "dispatch": return e.jobHash ? `Slot #${e.serial} started ${n(e.owner)}'s job` : `Slot #${e.serial} started with no job bound`;
    case "done": return e.ok ? `Slot #${e.serial} finished ${n(e.owner)}'s job in ${(e.ms / 1000).toFixed(1)}s` : `Slot #${e.serial}: ${n(e.owner)}'s job ${String(e.result).startsWith("timeout") ? "was killed at slot end" : "failed"}`;
    case "trade": return `${n(e.seller)} sold slot #${e.sellerSerial} to ${n(e.buyer)} for ${esc(hbar(e.price))} and took #${e.buyerSerial}`;
    case "refund": return `Provider refunded ${esc(hbar(e.amount))} to ${n(e.buyer)}`;
    default: return `Unknown message type`;
  }
}

function renderLog() {
  $("log").innerHTML = events
    .slice(0, 30)
    .map(
      (ev) => `<li class="${ev.verified ? "" : "unverified"}">
        <time>${clock(ev.ts)}</time>
        <span>${describe(ev)}</span>
        <span class="sig" title="${ev.verified ? "Signature matches the sender's Hedera key" : "Signature does not match the claimed sender"}">${ev.verified ? `Signed by ${esc(nameOf(ev.by))}` : `Unverified, claims ${esc(ev.by)}`}</span>
      </li>`,
    )
    .join("");
}

function renderSlotPicker() {
  const sel = $<HTMLSelectElement>("q-slot");
  const prev = sel.value;
  const upcoming = slots.filter((s) => s.start > now()).sort((a, b) => b.start - a.start);
  sel.innerHTML = upcoming.length
    ? upcoming.map((s) => `<option value="${s.start}">#${s.serial} at ${clock(s.start)}, held by ${esc(nameOf(s.owner))}</option>`).join("")
    : `<option value="">No upcoming slots</option>`;
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  renderQueryText();
}

function want(): Want | null {
  const myStart = Number($<HTMLSelectElement>("q-slot").value);
  if (!myStart || !profile) return null;
  const within = Number($<HTMLInputElement>("q-within").value);
  const budget = BigInt(Math.max(0, Math.round(Number($<HTMLInputElement>("q-budget").value) * 1e8)));
  const t = Math.floor(now());
  return { myStart, myLatest: t + within - profile.slotSeconds, notBefore: t + NOT_BEFORE_SECONDS, budget };
}

function renderQueryText() {
  const w = want();
  $("q-text").textContent = w ? render(offerFilter(providerId, w)) : "Book a slot first: the query starts from a slot you hold.";
}

async function runQuery(ev: Event) {
  ev.preventDefault();
  const w = want();
  if (!w) return;
  renderQueryText();
  $("q-result").textContent = "Asking Arkiv…";
  try {
    const { entities } = await findOffers(reader, providerId, w);
    matched = new Set(entities.map((e) => e.$key));
    $("q-result").textContent = entities.length
      ? `${entities.length} offer${entities.length > 1 ? "s" : ""} match, cheapest first: ${entities.map((e) => `#${e.slot_serial.value} from ${nameOf(e.seller.value)} at ${hbar(e.min_price.value)}`).join(", ")}. Matches are highlighted in the table.`
      : w.myLatest >= w.myStart
        ? "Your own slot already meets that deadline, so nothing earlier is needed. Try a shorter time."
        : "No offer matches. Either no seller can take your later slot, or every price is over budget.";
  } catch (e) {
    $("q-result").textContent = `Arkiv didn't answer: ${(e as Error).message}`;
  }
  renderOffers();
}

function renderStatus() {
  $("status").textContent = error
    ? `${error} Retrying every ${REFRESH_MS / 1000} seconds.`
    : updatedAt
      ? `Live. Updated ${Math.round(now() - updatedAt)}s ago.`
      : "Connecting…";
  $("status").classList.toggle("bad", !!error);
}

function renderData() {
  renderChart();
  renderOffers();
  renderTrades();
  renderLog();
  renderSlotPicker();
  renderStatus();
}

// ---------- wiring ----------
$("qform").addEventListener("submit", runQuery);
for (const id of ["q-slot", "q-within", "q-budget"]) $(id).addEventListener("input", renderQueryText);

async function loop() {
  try {
    await refresh();
  } catch (e) {
    error = (e as Error).message;
    renderStatus();
  }
  setTimeout(loop, REFRESH_MS);
}
loop();
// The schedule and countdowns move every second between data refreshes.
setInterval(() => {
  renderChart();
  renderOffers();
  renderStatus();
}, 1000);
