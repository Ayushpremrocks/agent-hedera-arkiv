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
import { type LoggedEvent, MIRROR, decide, hederaClient } from "@qy/shared";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Entry = {
  provider: string;
  ticket: number;
  amount: string; // tinybars held
  owner: string; // who booked it
  startBy: number;
  status: "held" | "released" | "refunded" | "not-escrowed";
  to?: string; // who was paid
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
    const credits = new Map<string, bigint>();
    const decided: { e: Entry; to: string; status: "released" | "refunded"; reason: string }[] = [];
    const watch = new Set([...opts.live(), ...Object.values(entries).filter((e) => e.status === "held").map((e) => e.provider)]);
    for (const p of [...watch].flatMap((pid) => opts.known(pid) ?? [])) {
      const own = (await opts.readLog(p.id)).filter((x) => x.by === p.id); // only the provider's own signed messages
      const dispatch = new Map<number, LoggedEvent>();
      const done = new Map<number, boolean>();
      const serialOf = new Map<number, number>();
      for (const x of own) {
        if (x.e.type === "dispatch") dispatch.set(x.e.ticket, x);
        if (x.e.type === "done") done.set(x.e.ticket, x.e.ok);
        if (x.e.type === "tokenized") serialOf.set(x.e.ticket, x.e.serial);
      }
      for (const x of own) {
        if (x.e.type !== "booked" || !x.e.paymentTx || typeof x.e.startBy !== "number") continue;
        const key = `${p.id}:${x.e.ticket}`;
        let e = entries[key];
        if (!e) {
          const held = await paidInto(x.e.paymentTx, id, BigInt(x.e.price)).catch(() => null);
          if (held === null) continue; // Mirror Node not answering: look again next round
          e = entries[key] = { provider: p.id, ticket: x.e.ticket, amount: x.e.price, owner: x.e.owner, startBy: x.e.startBy, status: held ? "held" : "not-escrowed" };
        }
        if (e.status !== "held") continue;
        const d = dispatch.get(e.ticket);
        const verdict = decide(
          { startBy: e.startBy, dispatch: d?.e.type === "dispatch" ? { ts: d.ts, jobHash: d.e.jobHash } : undefined, done: done.has(e.ticket) ? { ok: done.get(e.ticket)! } : undefined },
          nowS,
        );
        if (verdict.action === "hold") continue;
        let to = p.id;
        if (verdict.action === "refund") {
          // The refund belongs to whoever held the ticket: the booker, or the NFT's holder if it was traded,
          // read from the NFT's own transfer history (never from what the provider says).
          const serial = serialOf.get(e.ticket);
          to = serial === undefined ? e.owner : ((await holderAt(p.tokenId, serial, d?.ts ?? nowS).catch(() => null)) ?? e.owner);
        }
        credits.set(to, (credits.get(to) ?? 0n) + BigInt(e.amount));
        decided.push({ e, to, status: verdict.action === "release" ? "released" : "refunded", reason: verdict.reason });
      }
    }
    if (!decided.length) return;
    // One transfer settles many decisions (a handful of accounts per transaction).
    const accounts = [...credits.entries()];
    for (let i = 0; i < accounts.length; i += 8) {
      const chunk = accounts.slice(i, i + 8);
      const total = chunk.reduce((s, [, a]) => s + a, 0n);
      const tx = new TransferTransaction().setTransactionMemo("dani.ai escrow").addHbarTransfer(id, Hbar.fromTinybars((-total).toString()));
      for (const [acct, a] of chunk) tx.addHbarTransfer(acct, Hbar.fromTinybars(a.toString()));
      try {
        const sent = await tx.execute(client);
        await sent.getReceipt(client);
        const txId = sent.transactionId.toString();
        for (const d of decided) if (chunk.some(([acct]) => acct === d.to)) Object.assign(d.e, { status: d.status, to: d.to, reason: d.reason, tx: txId });
        console.log(`escrow: paid ${chunk.map(([a, t]) => `${a} ${t}`).join(", ")} (${txId})`);
      } catch (err) {
        console.error(`escrow payout failed, retrying next round: ${(err as Error).message}`);
      }
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
    stats(provider?: string) {
      const s = { held: 0, released: 0, refunded: 0, heldAmount: 0n, releasedAmount: 0n, refundedAmount: 0n };
      for (const e of Object.values(entries)) {
        if (provider && e.provider !== provider) continue;
        if (e.status === "held" || e.status === "released" || e.status === "refunded") {
          s[e.status]++;
          s[`${e.status}Amount`] += BigInt(e.amount);
        }
      }
      return { ...s, heldAmount: s.heldAmount.toString(), releasedAmount: s.releasedAmount.toString(), refundedAmount: s.refundedAmount.toString() };
    },
  };
}
