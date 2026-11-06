import { CopyButton } from "../components/motion";
import { Card, Notice, PageHeader } from "../components/ui";
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
      <div className="two-col">
        <Card title="Your account">
          <dl className="facts">
            <dt>Wallet</dt>
            <dd>
              <a href={hashscan("account", account!)} target="_blank" rel="noopener">
                {account}
              </a>{" "}
              <CopyButton value={account!} label="wallet account" />
            </dd>
            <dt>Agent</dt>
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
            {agent?.arkivKey && (
              <>
                <dt>Public record</dt>
                <dd>
                  <code>{agent.arkivKey.slice(0, 18)}…</code> on Arkiv
                </dd>
              </>
            )}
          </dl>
          <button type="button" className="ghost press" onClick={signOut}>
            Sign out
          </button>
        </Card>
        <Card title="Security">
          <ul className="plain">
            <li>Your wallet's keys never leave HashPack. Signing in only signs a message.</li>
            <li>Your agent has its own Hedera account. It can spend only the budget you approve, and you can set that to 0 at any time in Billing.</li>
            <li>Your instructions, material and results are private to you. Only fingerprints of them are public, so anyone can check results weren't altered.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
