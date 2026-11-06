import { CopyButton } from "../components/motion";
import { Notice, PageHeader } from "../components/ui";
import { hashscan } from "../lib/format";
import { useMe } from "../lib/hooks";
import { useSession } from "../lib/session";

export function Settings() {
  const { account, signOut } = useSession();
  const me = useMe();
  const agent = me.data?.agent;
  return (
    <>
      <PageHeader title="Settings" />
      <Notice text={me.error?.message} kind="error" />
      <div className="split">
        <section className="block" aria-labelledby="acct-h">
          <div className="block-head">
            <h2 id="acct-h">Accounts</h2>
          </div>
          <dl className="facts">
            <div>
              <dt>Your wallet</dt>
              <dd>
                <a href={hashscan("account", account!)} target="_blank" rel="noopener">
                  {account}
                </a>{" "}
                <CopyButton value={account!} label="wallet account" />
              </dd>
            </div>
            <div>
              <dt>Your agent</dt>
              <dd>
                {agent ? (
                  <>
                    <a href={hashscan("account", agent.id)} target="_blank" rel="noopener">
                      {agent.id}
                    </a>{" "}
                    <CopyButton value={agent.id} label="agent account" />
                  </>
                ) : (
                  "not created yet"
                )}
              </dd>
            </div>
            {agent?.arkivKey && (
              <div>
                <dt>Public record</dt>
                <dd>
                  <code>{agent.arkivKey.slice(0, 18)}…</code> on Arkiv
                </dd>
              </div>
            )}
          </dl>
          <button type="button" className="btn btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </section>
        <section className="block" aria-labelledby="sec-h">
          <div className="block-head">
            <h2 id="sec-h">What stays private</h2>
          </div>
          <dl className="rules">
            <div>
              <dt>Keys</dt>
              <dd>Your wallet's keys never leave HashPack. Signing in only signs a message.</dd>
            </div>
            <div>
              <dt>Spending</dt>
              <dd>Your agent has its own Hedera account and spends only the budget you approve. Set it to 0 in Billing at any time.</dd>
            </div>
            <div>
              <dt>Content</dt>
              <dd>Instructions, material and results are yours alone. Only their fingerprints are public, so anyone can check nothing was altered.</dd>
            </div>
          </dl>
        </section>
      </div>
    </>
  );
}
