// Who's signed in, and the API client that carries their session. Sign-in: with email (Magic holds the
// key) or HashPack; the host issues a one-time message, the key signs it, the host returns a session token.
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
// The wallet SDKs are large: load them only when someone signs in or out.
const loaders = { email: () => import("./magic"), hashpack: () => import("./wallet") };
type Via = keyof typeof loaders;
/** The module that signs for the current user: Magic for email sign-ins, HashPack otherwise. */
export const signer = () => loaders[(store.get("qy-via") as Via) === "email" ? "email" : "hashpack"]();

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Session = {
  account: string | null;
  /** With `email`, sign in through Magic; without, through HashPack. */
  signIn: (onStep?: (step: string) => void, email?: string) => Promise<void>;
  signOut: () => void;
  api: <T = any>(path: string, body?: unknown) => Promise<T>;
};
const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => store.get("qy-token"));
  const [account, setAccount] = useState(() => store.get("qy-account"));

  const signOut = useCallback(() => {
    store.set("qy-token", null);
    store.set("qy-account", null);
    setToken(null);
    setAccount(null);
    signer().then((w) => w.disconnect());
    store.set("qy-via", null);
  }, []);

  const api = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && token) signOut();
      if (!res.ok) throw new ApiError(res.status, data.error ?? `request failed (${res.status})`);
      return data as T;
    },
    [token, signOut],
  );

  const signIn = useCallback(
    async (onStep: (step: string) => void = () => {}, email?: string) => {
      let acct: string;
      let signMessage: (account: string, message: string) => Promise<string>;
      if (email) {
        onStep("Enter the code Magic emails you…");
        const m = await loaders.email();
        const publicKey = await m.login(email);
        onStep("Setting up your Hedera account…");
        const proof = await api<{ message: string }>("/auth/key-challenge", { publicKey });
        acct = (await api<{ account: string }>("/auth/key-account", { publicKey, message: proof.message, signatureMap: await m.signMessage("", proof.message) })).account;
        signMessage = m.signMessage;
      } else {
        onStep("Approve the connection in HashPack…");
        const w = await loaders.hashpack();
        acct = await w.connect();
        signMessage = w.signMessage;
        onStep("Sign the sign-in message in HashPack (it costs nothing)…");
      }
      const { message } = await api<{ message: string }>("/auth/challenge", { account: acct });
      const signatureMap = await signMessage(acct, message);
      const r = await api<{ token: string; account: string }>("/auth/verify", { account: acct, message, signatureMap });
      store.set("qy-via", email ? "email" : "hashpack");
      store.set("qy-token", r.token);
      store.set("qy-account", r.account);
      setToken(r.token);
      setAccount(r.account);
    },
    [api],
  );

  const value = useMemo(() => ({ account: token ? account : null, signIn, signOut, api }), [token, account, signIn, signOut, api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
