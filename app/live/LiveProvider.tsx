import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  createLiveClient,
  httpSnapshot,
  type LiveClient,
  type SocketLike,
  socketUrl,
} from './client';

export type Live =
  | { status: 'loading' | 'error' }
  | {
      status: 'ready';
      factories: readonly string[];
      client: LiveClient;
      /** True once the live socket has stayed down `OFFLINE_AFTER_MS`; false once it opens again. */
      offline: boolean;
    };

/** Exported for tests, which render the shell over a given configuration. */
export const LiveContext = createContext<Live>({ status: 'loading' });

/**
 * What the server's inline script leaves on `window.__MC_LIVE__` (server/live.ts
 * `liveBootScript`), the answer of `GET /api/live`. A fixture may add `socket`, a fake socket the
 * client uses instead of opening one.
 */
export interface LiveBoot {
  factories: string[];
  socket?: string | SocketLike;
}

declare global {
  interface Window {
    __MC_LIVE__?: LiveBoot;
  }
}

const SOCKET_PATH = '/api/live/socket';

/**
 * How long the live socket may stay down, counted from when it was lost, before the pages say they
 * cannot connect: past the client's longest reconnect wait, so a server restart never reaches it.
 */
export const OFFLINE_AFTER_MS = 16_000;

export const OFFLINE_SENTENCE = 'Cannot connect to the live socket for live data; still retrying.';
export const UNAVAILABLE_SENTENCE = 'Live data is unavailable.';

function opener(boot: LiveBoot): () => SocketLike {
  let handed = typeof boot.socket === 'object' ? boot.socket : undefined;
  const path = typeof boot.socket === 'string' ? boot.socket : SOCKET_PATH;
  return () => {
    if (handed) {
      const socket = handed;
      handed = undefined;
      return socket;
    }
    return new WebSocket(socketUrl(path, window.location)) as unknown as SocketLike;
  };
}

/**
 * Opens the live socket the app shares; panels render `error` when the server has no live
 * configuration. When the server put the configuration in the page the client starts at once;
 * otherwise it asks `GET /api/live`.
 */
export function LiveProvider({ children }: { children: ReactNode }): ReactElement {
  const [live, setLive] = useState<Live>({ status: 'loading' });

  useEffect(() => shareLive(window.__MC_LIVE__, setLive), []);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}

/** What a panel in `error` says: that the connection is down when the socket is offline, else that its data is unavailable. */
export function useUnavailable(): string {
  const live = useLive();
  return live.status === 'ready' && live.offline ? OFFLINE_SENTENCE : UNAVAILABLE_SENTENCE;
}

/** Opens the client for `boot` (or `GET /api/live`), publishing each `Live` to `setLive`; returns the cleanup. Exported for tests. */
export function shareLive(
  boot: LiveBoot | undefined,
  setLive: (live: Live) => void,
  open: (boot: LiveBoot, connection: (event: 'up' | 'down') => void) => LiveClient = (
    b,
    connection,
  ) =>
    // A fixture's own socket answers everything itself: no HTTP snapshot then.
    createLiveClient(opener(b), {
      connection,
      ...(typeof b.socket === 'object' ? {} : { snapshot: httpSnapshot }),
    }),
  wait: (ms: number, then: () => void) => () => void = (ms, then) => {
    const timer = setTimeout(then, ms);
    return () => clearTimeout(timer);
  },
): () => void {
  let cancelled = false;
  let client: LiveClient | undefined;
  let factories: readonly string[] = [];
  let offline = false;
  let stopDown: (() => void) | undefined;
  const publish = () => {
    if (!cancelled && client) setLive({ status: 'ready', factories, client, offline });
  };
  const connection = (event: 'up' | 'down') => {
    if (cancelled) return;
    if (event === 'up') {
      stopDown?.();
      stopDown = undefined;
      if (offline) {
        offline = false;
        publish();
      }
    } else if (!stopDown && !offline) {
      stopDown = wait(OFFLINE_AFTER_MS, () => {
        stopDown = undefined;
        offline = true;
        publish();
      });
    }
  };
  const start = (config: LiveBoot) => {
    factories = config.factories;
    client = open(config, connection);
    publish();
  };
  if (boot) {
    start(boot);
  } else {
    fetch('/api/live')
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET /api/live answered ${res.status}`);
        const answered = (await res.json()) as LiveBoot;
        if (!cancelled) start(answered);
      })
      .catch(() => {
        if (!cancelled) setLive({ status: 'error' });
      });
  }
  return () => {
    cancelled = true;
    stopDown?.();
    client?.close();
  };
}
