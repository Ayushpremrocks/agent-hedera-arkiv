// End-to-end market check against a running provider (default LEAD_SECONDS=120, WORKERS=2):
//   B (flexible) and C (tight deadline) book the same start S and list offers on Arkiv.
//   C first tries to sneak an extra HBAR transfer past B's checks: rejected, nothing moves.
//   A books S+30, misses its deadline, finds only B's offer on Arkiv (C's deadline filters it out)
//   and swaps atomically. B can't sell twice; C refuses B's later slot before any money moves.
//   Finally the provider runs A's job in B's old slot and B's job in A's old slot.
import { Hbar, PublicKey, TransferTransaction } from "@hiero-ledger/sdk";
import { MIRROR, accountKey, hederaClient, type Job, jobHash, parseKey, postPaid, role, SWAP_VALID_SECONDS } from "@qy/shared";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const A = role("AGENT_A");
const B = role("AGENT_B");
const C = role("AGENT_C");
const now = () => Math.floor(Date.now() / 1000);
function expect(label: string, ok: boolean, got: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} ${got}`);
  if (!ok) process.exitCode = 1;
}

/** Spawn the agent CLI and let the test wait for lines it prints. */
function agent(args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", "packages/agent/src/index.ts", ...args]);
  let out = "";
  const tag = args[2];
  const onData = (d: Buffer) => {
    out += d;
    for (const l of d.toString().trimEnd().split("\n")) console.log(`  [${tag}] ${l}`);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const exited = new Promise<number>((ok) => child.on("exit", (code) => ok(code ?? -1)));
  const waitFor = async (re: RegExp, ms = 90_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = out.match(re);
      if (m) return m;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`${tag}: never printed ${re}`);
  };
  return { child, exited, waitFor, out: () => out };
}
const booked = /booked slot #(\d+) at (\d+)/;

// The earliest bookable start moves with the clock. Launch B and C together just after it steps,
// so both reserve the same start S (2 workers) and A's later booking lands after S.
const LEAD = Number(process.env.LEAD_SECONDS ?? 120);
const SLOT = 30;
const phase = (now() + LEAD) % SLOT;
if (phase > 2) await new Promise((r) => setTimeout(r, (SLOT - phase + 1) * 1000));
const S = Math.ceil((now() + LEAD) / SLOT) * SLOT;

const b = agent(["sell", "--as", "AGENT_B", "--deadline", "900", "--price", "2000000", "--port", "4101"]);
// C needs to finish by S+40: its own slot S is fine, but A's S+30 would not be.
const c = agent(["sell", "--as", "AGENT_C", "--deadline", String(S + 40 - now()), "--price", "1000000", "--port", "4102"]);
const [, bSerial, bStart] = (await b.waitFor(booked)).map(Number);
const [, cSerial, cStart] = (await c.waitFor(booked)).map(Number);
expect("B and C both got start S", bStart === S && cStart === S, `${bStart} ${cStart} want ${S}`);
await Promise.all([b.waitFor(/swap endpoint/), c.waitFor(/swap endpoint/)]);

// --- C tries a swap with B that also moves 1 HBAR from B to C ---
const bUrl = `http://localhost:4101/offers/${bSerial}/swap`;
const quote = await postPaid(bUrl, { buyer: C.id, buyerSerial: cSerial });
expect("B quotes C with 402", quote.status === 402, quote.status);
const clientC = hederaClient(C.id, C.key);
const price = BigInt(quote.body.accepts[0].amount);
const tokenId = quote.body.accepts[0].extra.tokenId;
const evil = await new TransferTransaction()
  .addNftTransfer(tokenId, bSerial, B.id, C.id)
  .addNftTransfer(tokenId, cSerial, C.id, B.id)
  .addHbarTransfer(C.id, Hbar.fromTinybars((-price + 100_000_000n).toString()))
  .addHbarTransfer(B.id, Hbar.fromTinybars((price - 100_000_000n).toString()))
  .setTransactionValidDuration(SWAP_VALID_SECONDS)
  .freezeWith(clientC)
  .sign(parseKey(C.key));
const evilRes = await postPaid(bUrl, { buyer: C.id, buyerSerial: cSerial, tx: Buffer.from(evil.toBytes()).toString("base64") });
expect("B rejects a swap with an extra HBAR debit", evilRes.status === 400, `${evilRes.status} ${evilRes.body.error}`);
clientC.close();

// --- A: urgent, needs to finish by S+40 too ---
const a = agent(["buy", "--as", "AGENT_A", "--deadline", String(S + 40 - now()), "--budget", "5000000"]);
const [, aSerial, aStart] = (await a.waitFor(booked)).map(Number);
expect("A's own slot is later than S", aStart > S, `${aStart}`);
await a.exited;
expect("only B's offer matched on Arkiv (C filtered by its deadline)", /1 matching offer\(s\)/.test(a.out()));
expect("A bought B's slot", new RegExp(`BOUGHT #${bSerial} from ${B.id}`).test(a.out()));

// --- after the trade ---
const again = await postPaid(bUrl, { buyer: C.id, buyerSerial: cSerial });
expect("B can't sell the same slot twice", again.status === 410, `${again.status} ${again.body.error}`);
const direct = await postPaid(`http://localhost:4102/offers/${cSerial}/swap`, { buyer: B.id, buyerSerial: aSerial });
expect("C refuses a slot past its deadline, before any money moves", direct.status === 422, `${direct.status} ${direct.body.error}`);

const wait = (aStart + 30) * 1000 - Date.now() + 10_000;
console.log(`waiting ${Math.round(wait / 1000)}s for slots ${S} and ${aStart} to run...`);
await new Promise((r) => setTimeout(r, wait));
b.child.kill();
c.child.kill();

type Env = { body: string; by: string; sig: string };
const infra = JSON.parse(readFileSync("data/provider/infra.json", "utf8")) as { topicId: string };
const msgs = (await (await fetch(`${MIRROR}/topics/${infra.topicId}/messages?limit=100&order=desc`)).json()) as any;
const events: { e: any; ok: boolean }[] = [];
for (const m of msgs.messages) {
  const env: Env = JSON.parse(Buffer.from(m.message, "base64").toString());
  const ok = PublicKey.fromStringECDSA(await accountKey(env.by)).verify(new TextEncoder().encode(env.body), Buffer.from(env.sig, "hex"));
  events.push({ e: { ...JSON.parse(env.body), by: env.by }, ok });
}
const job = (as: string, mode: string): Job => ({ kind: "cpu", seconds: 5, label: `${as} ${mode}` });
const trade = events.find(({ e }) => e.type === "trade" && e.sellerSerial === bSerial);
expect("trade logged on HCS, signed by B", !!trade && trade.ok && trade.e.by === B.id);
const ran = (serial: number, j: Job) => events.some(({ e }) => e.type === "done" && e.serial === serial && e.jobHash === jobHash(j) && e.ok);
expect(`A's job ran in B's old slot #${bSerial}`, ran(bSerial, job("AGENT_A", "buy")));
expect(`B's job ran in A's old slot #${aSerial}`, ran(aSerial, job("AGENT_B", "sell")));
expect(`C's job ran in its own slot #${cSerial}`, ran(cSerial, job("AGENT_C", "sell")));
