// The change feed behind the live hub: one dedicated connection that LISTENs on the channel the
// dashboard tables' statement triggers NOTIFY (mc_meta.notify_live, installed by `bun run migrate`).
// A dropped connection is reopened with a doubling wait, and every subscription is refreshed once
// it is back, since notifications sent while it was down are lost. The hub's poll covers the gap.

import pg from 'pg';

/** The channel `mc_meta.notify_live()` notifies on; the payload is the table that changed. */
export const LIVE_CHANNEL = 'mc_live';

export interface ListenHandle {
  stop(): Promise<void>;
  /** True while the LISTEN connection is open. */
  connected(): boolean;
}

export function listenForChanges(
  databaseUrl: string,
  onChange: (table: string) => void,
  log: (line: string) => void = (line) => console.error(line),
): ListenHandle {
  let client: pg.Client | undefined;
  let stopped = false;
  let open = false;
  let wait = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reconnectLater = () => {
    open = false;
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, wait);
    wait = Math.min(30_000, wait * 2);
  };

  const connect = async () => {
    const next = new pg.Client({
      connectionString: databaseUrl,
      application_name: 'mission-control-listen',
    });
    client = next;
    // Only the current client may schedule a reconnect: a late event from a replaced one is ignored.
    next.on('error', (error) => {
      if (client !== next) return;
      log(`live LISTEN connection failed: ${error.message}`);
      next.end().catch(() => {});
      reconnectLater();
    });
    next.on('end', () => {
      if (client === next) reconnectLater();
    });
    next.on('notification', (message) => {
      if (message.channel === LIVE_CHANNEL) onChange(message.payload ?? '');
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${LIVE_CHANNEL}`);
      open = true;
      wait = 1_000;
      // Anything that changed while no one listened is picked up now.
      onChange('');
    } catch (error) {
      if (client !== next) return;
      log(`live LISTEN could not connect: ${error instanceof Error ? error.message : error}`);
      next.end().catch(() => {});
      reconnectLater();
    }
  };

  void connect();
  return {
    connected: () => open,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await client?.end().catch(() => {});
    },
  };
}
