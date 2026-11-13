import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Shell } from '../../Shell';
import Attention from '../../routes/f.$factory';
import Board from '../../routes/f.$factory.board';
import Runs from '../../routes/f.$factory.runs';
import { FakeLiveSocket } from '../../live/fixtures/fake-socket';

let current: { unmount: () => void } | undefined;

/** Mounts the real shell with the real Attention, Board and Runs routes over a server with no rows. */
export function mount(url: string) {
  current?.unmount();
  window.__MC_LIVE__ = { factories: ['x'], socket: new FakeLiveSocket(() => undefined) };
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/f/:factory', element: <Attention /> },
          { path: '/f/:factory/board', element: <Board /> },
          { path: '/f/:factory/runs', element: <Runs /> },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  current = {
    unmount() {
      root.unmount();
      container.remove();
      delete window.__MC_LIVE__;
    },
  };
}

/** The gaps either side of the page's column in its pane, and whether the pane scrolls sideways. */
export function gaps() {
  const column = document.querySelector('main');
  const pane = column?.parentElement;
  if (!column || !pane) return null;
  const c = column.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  return {
    left: Math.round(c.left - p.left),
    right: Math.round(p.left + pane.clientWidth - c.right),
    sideways: pane.scrollWidth > pane.clientWidth,
  };
}

/** Opens or closes the docked Manager from the nav, whatever state the browser remembered. */
export const setManager = (open: boolean) => {
  const button = document.querySelector<HTMLButtonElement>('nav button[aria-pressed]');
  if ((button?.getAttribute('aria-pressed') === 'true') !== open) button?.click();
};
