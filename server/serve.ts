import type { Server } from 'bun';
import type { Hono } from 'hono';
import { LIVE_SOCKET_PATH, type Live } from './live';
import { handleClientMessage, type LiveSink } from './live-hub';

type SocketData = { sink: LiveSink };

/**
 * A WebSocket upgrade is only taken from a page this server served: a browser always sends
 * `Origin`, and it must name this server's own host, so another site cannot read the dashboard
 * through a visitor's browser. A client that sends no Origin (a script, a test) is not a browser.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

/**
 * Local-only request gate: the dashboard has no
 * auth, so it answers only requests addressed to a loopback name on its own port (this defeats
 * DNS rebinding, where a hostile page's own hostname resolves to 127.0.0.1), and refuses
 * state-changing requests that a browser marks as coming from another origin (e.g. a cross-site
 * POST to the Manager, which would spend the operator's Claude subscription). Requests with no
 * Origin (curl, scripts, tests) still pass.
 */
export function localRequestRefusal(request: Request, port: number): string | null {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = (request.headers.get('host') ?? '').toLowerCase();
  if (!allowed.has(host)) return 'host not allowed';
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin !== null) {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        return 'origin not allowed';
      }
      if (!allowed.has(originHost)) return 'origin not allowed';
    }
  }
  return null;
}

/** Serves the app and, at LIVE_SOCKET_PATH, the live socket, on `hostname:port`. */
export function serve({
  app,
  live,
  hostname,
  port,
}: {
  app: Hono;
  live: Live | undefined;
  hostname: string;
  port: number;
}): Server<SocketData> {
  return Bun.serve<SocketData>({
    hostname,
    port,
    fetch(request, server) {
      const refusal = localRequestRefusal(request, server.port ?? port);
      if (refusal !== null) return Response.json({ error: refusal }, { status: 403 });
      if (new URL(request.url).pathname === LIVE_SOCKET_PATH) {
        if (!live)
          return Response.json({ error: 'live queries are not configured' }, { status: 503 });
        if (!sameOrigin(request))
          return Response.json({ error: 'cross-origin socket' }, { status: 403 });
        // The sink is bound to its socket once the socket opens (`open` below).
        const sink: LiveSink = { send: () => {} };
        if (server.upgrade(request, { data: { sink } })) return undefined;
        return Response.json({ error: 'expected a WebSocket upgrade' }, { status: 426 });
      }
      return app.fetch(request);
    },
    websocket: {
      open(ws) {
        // The sink sends through the socket it was made for.
        ws.data.sink.send = (message) => void ws.send(message);
        ws.send(JSON.stringify({ type: 'ready' }));
      },
      message(ws, message) {
        if (live) handleClientMessage(live.hub, ws.data.sink, message);
      },
      close(ws) {
        live?.hub.drop(ws.data.sink);
      },
    },
  });
}
