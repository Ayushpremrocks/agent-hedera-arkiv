export const hbar = (tiny: string | number | bigint | null | undefined) => (tiny === null || tiny === undefined ? "–" : `${+(Number(tiny) / 1e8).toFixed(4)} HBAR`);
export const toTinybars = (hbarText: string) => String(Math.round(Number(hbarText) * 1e8));
export const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export const shortClock = (unix: number) => clock(unix).slice(0, 5);
export function inHuman(secs: number) {
  const s = Math.round(Math.abs(secs));
  const t = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  return secs >= 0 ? `in ${t}` : `${t} ago`;
}
export const hashscan = (kind: "account" | "token" | "topic" | "transaction", id: string) => `https://hashscan.io/testnet/${kind}/${encodeURIComponent(id)}`;
