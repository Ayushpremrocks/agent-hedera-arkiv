// The escrow keeper. Bookings are paid into one escrow account; the keeper pays a provider once its
// ticket starts on time and refunds the ticket's holder otherwise, so a refund never depends on the
// provider having the money or the will. Every decision comes from public data (the provider's signed
// HCS log, consensus timestamps, the payment and NFT transfers on the Mirror Node) through the rules in
// @qy/shared/escrow, so anyone can re-run them and check each payout.
//
// shortcut: the keeper is a trusted custodian (its key is derived from the host's secret). A Hedera smart
// contract could hold the money trustlessly, at about 1 US cent per ticket in gas today; move there
// when that's cheaper than the trust it removes.
import { AccountCreateTransaction, type Client, Hbar, PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";
import { type Bands, type LoggedEvent, MIRROR, bandPrice, decide, hederaClient } from "@qy/shared";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Entry = {
  provider: string;
  ticket: number;
  amount: string; // tinybars held
  owner: string; // who booked it
  startBy: number;
  limit?: number;
  bands?: Bands; // the provider's prices by size at booking: the job is charged the band it used
  charged?: string; // tinybars the provider kept (the band used, less any lateness credit)
  status: "held" | "released" | "partial" | "refunded" | "not-escrowed"; // partial: some of the deposit went back (a smaller band used, or a lateness credit)
  refund?: string; // tinybars that went back to the ticket's holder
  to?: string; // who got the refund, if any
  reason?: string;
  tx?: string;
};
type ProviderRef = { id: string; tokenId: string };

const mirror = async (path: string) => {
  const res = await fetch(`${MIRROR}${path}`);
  if (!res.ok) throw new Error(`Mirror ${path}: ${res.status}`);
  return res.json() as Promise<any>;
};
// "0.0.5@1700000000.123456789" (SDK form) -> "0.0.5-1700000000-123456789" (Mirror Node form)
export const mirrorTxId = (id: string) => id.replace("@", "-").replace(/\.(\d+)$/, "-$1");

/** Did this payment move at least `amount` tinybars into `escrow`, successfully? */
async function paidInto(paymentTx: string, escrow: string, amount: bigint) {
  const tx = (await mirror(`/transactions/${mirrorTxId(paymentTx)}`)).transactions?.[0];
  return tx?.result === "SUCCESS" && (tx.transfers as { account: string; amount: number }[]).some((t) => t.account === escrow && BigInt(t.amount) >= amount);
}

/** Who held an NFT at consensus time `at`: the receiver of its last transfer up to then. */
async function holderAt(tokenId: string, serial: number, at: number): Promise<string | null> {
  const r = await mirror(`/tokens/${tokenId}/nfts/${serial}/transactions?timestamp=lte:${at}&order=desc&limit=1`);
  return r.transactions?.[0]?.receiver_account_id ?? null;
}

export async function startEscrow(opts: {
  key: string; // derived from the host's secret
  operator: Client; // pays to create the account the first time
  dataDir: string;
  live: () => string[]; // providers to watch for new bookings
  known: (id: string) => ProviderRef | undefined; // any provider ever seen, so held money settles even after it goes offline
  readLog: (provider: string) => Promise<LoggedEvent[]>;
}) {
  const accountFile = `${opts.dataDir}/escrow.json`;
  const stateFile = `${opts.dataDir}/escrow-state.json`;
  let id: string;
  if (existsSync(accountFile)) id = JSON.parse(readFileSync(accountFile, "utf8")).id;
  else {
    // 5 HBAR of float pays the keeper's own transfer fees; everything else in it is held bookings.
    const receipt = await (
      await new AccountCreateTransaction().setECDSAKeyWithAlias(PrivateKey.fromStringDer(opts.key)).setInitialBalance(new Hbar(5)).execute(opts.operator)
    ).getReceipt(opts.operator);
    id = receipt.accountId!.toString();
    writeFileSync(accountFile, JSON.stringify({ id }, null, 2));
  }
  const client = hederaClient(id, opts.key);
  const entries: Record<string, Entry> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  const save = () => writeFileSync(stateFile, JSON.stringify(entries));

  async function settle() {
    const nowS = Date.now() / 1000;
    // Each decision credits the provider (what it keeps) and/or the ticket's holder (the refund).
    const decided: { e: Entry; credits: [string, bigint][]; status: Entry["status"]; reason: string; refund: string; to: string; charged: string }[] = [];
    const watch = new Set([...opts.live(), ...Object.values(entries).filter((e) => e.status === "held").map((e) => e.provider)]);
    for (const p of [...watch].flatMap((pid) => opts.known(pid) ?? [])) {
      const own = (await opts.readLog(p.id)).filter((x) => x.by === p.id); // only the provider's own signed messages
      const dispatch = new Map<number, LoggedEvent>();
      const done = new Map<number, { ok: boolean; tokens: number }>();
      const serialOf = new Map<number, number>();
      for (const x of own) {
        if (x.e.type === "dispatch") dispatch.set(x.e.ticket, x);
        if (x.e.type === "done") done.set(x.e.ticket, { ok: x.e.ok, tokens: x.e.tokens });
        if (x.e.type === "tokenized") serialOf.set(x.e.ticket, x.e.serial);
      }
      for (const x of own) {
        if (x.e.type !== "booked" || !x.e.paymentTx || typeof x.e.startBy !== "number") continue;
        const key = `${p.id}:${x.e.ticket}`;
        let e = entries[key];
        if (!e) {
          const held = await paidInto(x.e.paymentTx, id, BigInt(x.e.price)).catch(() => null);
          if (held === null) continue; // Mirror Node not answering: look again next round
          e = entries[key] = { provider: p.id, ticket: x.e.ticket, amount: x.e.price, owner: x.e.owner, startBy: x.e.startBy, limit: x.e.limit, bands: x.e.bands, status: held ? "held" : "not-escrowed" };
        }
        if (e.status !== "held") continue;
        const d = dispatch.get(e.ticket);
        const verdict = decide(
          { startBy: e.startBy, limit: e.limit, dispatch: d?.e.type === "dispatch" ? { ts: d.ts, jobHash: d.e.jobHash } : undefined, done: done.get(e.ticket) },
          nowS,
        );
        if (verdict.action === "hold") continue;
        // Pay as you go: the deposit covered the job's maximum size; the provider is owed the band the job
        // actually used (a job-less reservation: the smallest band), less its lateness credit. The rest
        // of the deposit goes back. Bookings from before bands were priced flat: the whole deposit.
        const amount = BigInt(e.amount);
        const used = done.get(e.ticket);
        const owed = !e.bands?.length ? amount : bandPrice(e.bands, used?.ok ? used.tokens : 0);
        const kept = ((owed < amount ? owed : amount) * BigInt(100 - verdict.refundPct)) / 100n;
        const refund = amount - kept;
        let to = e.owner;
        if (refund > 0n) {
          // The refund belongs to whoever held the ticket: the booker, or the NFT's holder if it was traded,
          // read from the NFT's own transfer history (never from what the provider says).
          const serial = serialOf.get(e.ticket);
          to = serial === undefined ? e.owner : ((await holderAt(p.tokenId, serial, d?.ts ?? nowS).catch(() => null)) ?? e.owner);
        }
        const credits: [string, bigint][] = [];
        if (refund > 0n) credits.push([to, refund]);
        if (amount > refund) credits.push([p.id, amount - refund]);
        const status = refund === 0n ? "released" : refund === amount ? "refunded" : "partial";
        decided.push({ e, credits, status, reason: verdict.reason, refund: refund.toString(), to, charged: kept.toString() });
      }
    }
    if (!decided.length) return;
    // One all-or-nothing transfer per round: it either settles every decision in it or none, so a failure
    // can't pay anyone twice. A transfer takes ten accounts, so decisions past that wait for the next round.
    const total = new Map<string, bigint>();
    const batch: typeof decided = [];
    for (const d of decided) {
      const accounts = new Set([...total.keys(), ...d.credits.map(([a]) => a)]);
      if (accounts.size > 9) continue;
      for (const [a, v] of d.credits) total.set(a, (total.get(a) ?? 0n) + v);
      batch.push(d);
    }
    const sum = [...total.values()].reduce((x, y) => x + y, 0n);
    const tx = new TransferTransaction().setTransactionMemo("dani.ai escrow").addHbarTransfer(id, Hbar.fromTinybars((-sum).toString()));
    for (const [a, v] of total) tx.addHbarTransfer(a, Hbar.fromTinybars(v.toString()));
    try {
      const sent = await tx.execute(client);
      await sent.getReceipt(client);
      const txId = sent.transactionId.toString();
      for (const d of batch) Object.assign(d.e, { status: d.status, reason: d.reason, refund: d.refund, charged: d.charged, to: d.refund === "0" ? undefined : d.to, tx: txId });
      console.log(`escrow: settled ${batch.length} ticket(s): ${[...total].map(([a, v]) => `${a} +${v}`).join(", ")} (${txId})`);
    } catch (err) {
      console.error(`escrow payout failed, retrying next round: ${(err as Error).message}`);
    }
    save();
  }

  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    settle()
      .catch((e) => console.error("escrow:", e.message))
      .finally(() => (busy = false));
  }, 20_000);

  return {
    id,
    /** Held, paid out and refunded for one provider (or all), in counts and tinybars. */
    /** One ticket's settlement: deposit, what the provider kept, what went back, and why. */
    entry(provider: string, ticket: number) {
      const e = entries[`${provider}:${ticket}`];
      return e ? { status: e.status, deposit: e.amount, charged: e.charged ?? null, returned: e.refund ?? null, reason: e.reason ?? null, tx: e.tx ?? null } : null;
    },
    stats(provider?: string) {
      const s = { held: 0, released: 0, partial: 0, refunded: 0, heldAmount: 0n, paidAmount: 0n, refundedAmount: 0n };
      for (const e of Object.values(entries)) {
        if (provider && e.provider !== provider) continue;
        if (e.status === "not-escrowed") continue;
        s[e.status]++;
        if (e.status === "held") s.heldAmount += BigInt(e.amount);
        else {
          const back = BigInt(e.refund ?? (e.status === "refunded" ? e.amount : "0")); // entries from before credits: all or nothing
          s.refundedAmount += back;
          s.paidAmount += BigInt(e.amount) - back;
        }
      }
      return { ...s, heldAmount: s.heldAmount.toString(), paidAmount: s.paidAmount.toString(), refundedAmount: s.refundedAmount.toString() };
    },
  };
}
