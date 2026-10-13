# Every view in both themes and at phone width

Every view (Org, Flow, Agent, Chat, Rooms, Scripts, Gates, Performance, Ledger) draws in the shell, the black slab across the top with the navigation and the Action bar over bone content, in the light theme and in the dark theme, and at a 390 px phone width without the page scrolling sideways.

## Sub-features

- `views-light` and `views-dark` draw each route with `main h1` and no `main [role=alert]` under `prefers-color-scheme` light and dark. The tokens live on `:root` in `conductor/ui/index.html`; dark redefines them under the media query and again under `:root[data-theme="dark"]`.
- `views-phone` draws each route in a 390 px window with `document.documentElement.scrollWidth` no wider than the window. Wide tables scroll inside `main`, not the page.

## How to get to it (user POV)

- Choose each view in the navigation. Switch the system appearance to dark, or narrow the window to a phone's width.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md).

- **Whole drive.** Run `scripts/drive.sh "$RUN" views`. It runs two browser sessions: `views/wide` (light, then dark, at 1280 px) and `views/phone` (light at 390 px).
- **One view by hand.** `scripts/browser.mjs "$RUN" views/one scheme dark goto '#/performance' wait 'main h1' no-hscroll`.
- **Proof.** A screenshot per view per theme and per view at 390 px; the drive appends no Event.

## Gotchas

- The routes are listed once, in `VIEW_ROUTES` in `scripts/drive.sh`. A new view adds its route there.
- Rooms and Scripts still draw their JSON as it came; their `pre` blocks scroll inside themselves at phone width.
