import { createRoot } from 'react-dom/client';
import { FakeLiveSocket } from '../../live/fixtures/fake-socket';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Shell } from '../../Shell';
import type { HomeMapRow } from '../../map/live';
import Home from '../../routes/f.$factory.map';

const VERSION_ROW: HomeMapRow = {
  kind: 'version',
  run_id: null,
  workflow: null,
  steps: null,
  number: null,
  title: null,
  url: null,
  at: null,
  prs: null,
  stop_line: null,
  asks: null,
};

/** A live socket that answers `home-map` with its one version row, and every other query no rows. */
export const socket = () =>
  new FakeLiveSocket((query) => (query === 'home-map' ? [VERSION_ROW] : undefined));

let current: { unmount: () => void } | undefined;

/** Mounts the real shell and home over a fake server at `url`. */
export function mount(url: string) {
  current?.unmount();
  window.__MC_LIVE__ = { factories: ['x'], socket: socket() };
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/f/:factory/map', element: <Home /> },
          { path: '/f/:factory/board', element: <p>Board</p> },
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

const TOGGLE = 'main button[aria-label="Flow animation"]';

export const shown = () => ({
  toggle: document.querySelector(TOGGLE) !== null,
  flow: document.querySelector<HTMLElement>('[data-map-stage]')?.dataset.flow ?? null,
});

export const clickToggle = () => document.querySelector<HTMLButtonElement>(TOGGLE)?.click();

export const goBoard = () => {
  document.querySelector<HTMLAnchorElement>('nav a[href$="/board"]')?.click();
};
