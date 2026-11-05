import { createServer, type IncomingHttpHeaders } from "node:http";

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export type Req = { body: any; headers: IncomingHttpHeaders; params: Record<string, string> };
export type Res = { status?: number; body: unknown; headers?: Record<string, string> };
export type Handler = (req: Req) => Promise<Res>;

const MAX_BODY = 64 * 1024;

/** Tiny JSON router. Route keys look like "POST /offers/:serial/swap". */
export function serve(port: number, routes: Record<string, Handler>) {
  const table = Object.entries(routes).map(([key, fn]) => {
    const [method, path] = key.split(" ");
    return { method, parts: path.split("/"), fn };
  });

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const segs = url.pathname.split("/");
      let params: Record<string, string> = {};
      const route = table.find((r) => {
        if (r.method !== req.method || r.parts.length !== segs.length) return false;
        params = {};
        return r.parts.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = segs[i]), true) : p === segs[i]));
      });
      if (!route) return send(404, { error: "not found" });

      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) throw new HttpError(413, "body too large");
      }
      let body: unknown = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        throw new HttpError(400, "invalid JSON");
      }
      const out = await route.fn({ body, headers: req.headers, params });
      send(out.status ?? 200, out.body, out.headers);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, (e as Error).message);
      if (err.status >= 500) console.error(e);
      send(err.status, { error: err.message, ...err.extra });
    }
  });
  return new Promise<typeof server>((ok) => server.listen(port, () => ok(server)));
}
