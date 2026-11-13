import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { useLive } from './LiveProvider';

export type PanelState = 'loading' | 'ready' | 'error';

/**
 * How long a panel keeps showing its rows as `ready` after the socket dropped: a short blip (a
 * server restart) reconnects and resubscribes within it; past it the rows are no longer live and
 * the panel is in `error` until fresh rows arrive.
 */
export const LOST_GRACE_MS = 3_000;

type Render<Row> = (rows: readonly Row[] | undefined, state: PanelState) => ReactNode;

interface LivePanelProps<Row> {
  /** A file name in `db/queries/`, without `.sql`. */
  query: string;
  /**
   * Names this panel apart from the screen's own panel of the same query: it is the panel's
   * `data-live`, so a second reader of a query (the nav's badge) is never taken for the first by
   * anything that finds a panel by name.
   */
  name?: string;
  factory: string | undefined;
  /** The query's parameters after the factory (`$2` on), when it takes any. */
  args?: readonly string[];
  className?: string;
  children: Render<Row>;
}

/** Where one subscription stands: what it was asked for, and its rows or failure. */
interface Answer<Row> {
  asked: string;
  rows?: readonly Row[];
  failed?: boolean;
}

/**
 * The state a panel shows: `error` when the live layer or its query failed, `ready` once rows for
 * what it asked have arrived, `loading` until then.
 */
export function panelState<Row>(
  liveStatus: 'loading' | 'ready' | 'error',
  answer: Answer<Row> | undefined,
  asked: string,
): PanelState {
  if (liveStatus === 'error') return 'error';
  if (answer?.asked !== asked) return 'loading';
  if (answer.failed) return 'error';
  return answer.rows === undefined ? 'loading' : 'ready';
}

/**
 * The one way a panel goes live: subscribes to `query` for `factory` on the tab's live socket and
 * sets `data-state` on the panel. No panel talks to the socket directly.
 */
export function LivePanel<Row>({
  query,
  name = query,
  factory,
  args,
  className,
  children,
}: LivePanelProps<Row>): ReactElement {
  const live = useLive();
  const [answer, setAnswer] = useState<Answer<Row>>();
  const argsKey = JSON.stringify(args ?? []);
  const asked = `${query} ${factory ?? ''} ${argsKey}`;
  const client = live.status === 'ready' ? live.client : undefined;

  useEffect(() => {
    if (!client || factory === undefined) return;
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    const parsedArgs: string[] = JSON.parse(argsKey);
    // When the panel first asked for its rows: browser checks read it.
    if (performance.getEntriesByName(`live:${name}:requested`).length === 0) {
      performance.mark(`live:${name}:requested`);
    }
    const unsubscribe = client.subscribe<Row>(
      { query, factory, ...(parsedArgs.length > 0 && { args: parsedArgs }) },
      {
        rows(rows) {
          clearTimeout(lostTimer);
          lostTimer = undefined;
          setAnswer({ asked, rows });
        },
        error() {
          setAnswer((was) => ({
            asked,
            rows: was?.asked === asked ? was.rows : undefined,
            failed: true,
          }));
        },
        lost() {
          if (lostTimer !== undefined) return;
          lostTimer = setTimeout(() => {
            setAnswer((was) => ({
              asked,
              rows: was?.asked === asked ? was.rows : undefined,
              failed: true,
            }));
          }, LOST_GRACE_MS);
        },
      },
    );
    return () => {
      clearTimeout(lostTimer);
      unsubscribe();
    };
  }, [client, query, name, factory, argsKey, asked]);

  const state = panelState(live.status, answer, asked);
  const rows = answer?.asked === asked && state !== 'loading' ? answer.rows : undefined;
  return (
    <section data-live={name} data-state={state} className={className}>
      {children(rows, state)}
    </section>
  );
}
