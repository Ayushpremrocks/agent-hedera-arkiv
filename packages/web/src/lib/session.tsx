// Who's signed in, and the API client that carries their session. Sign-in: HashPack connects, the host
// issues a one-time message, the wallet signs it, the host returns a session token.
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { connect, disconnect, signMessage } from "./wallet";

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
  signIn: (onStep?: (step: string) => void) => Promise<void>;
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
    disconnect();
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
    async (onStep: (step: string) => void = () => {}) => {
      onStep("Approve the connection in HashPack…");
      const acct = await connect();
      onStep("Sign the sign-in message in HashPack (it costs nothing)…");
      const { message } = await api<{ message: string }>("/auth/challenge", { account: acct });
      const signatureMap = await signMessage(acct, message);
      const r = await api<{ token: string; account: string }>("/auth/verify", { account: acct, message, signatureMap });
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
