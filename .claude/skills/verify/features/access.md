# Access landing

A fresh browser session opens on the Access landing, a full-screen frame outside the shell: the ALIQUOT wordmark, a live clock and date, the ghost word ACCESS behind a Session panel that names the Operator, the laboratory (the Lab Room every Agent belongs to), the terminal (the host) and the time the landing opened, and one ENTER button that opens the shell; there is no password, and the session remembers ENTER, so every later route in that session opens the shell directly.

## Sub-features

- `access-frame` is `section#access`, shown while `body[data-access="locked"]`; the shell is `.shell`, hidden until ENTER.
- `access-session` fills `#access-operator` with the person's email from `GET /api/operator` (`verify@lab.test` in a verify run, which serves for the person `ALIQUOT_OPERATOR` names; `Operator (unnamed)` only if the answer has no email), `#access-laboratory` (`Lab Room · RM-lab` from `/api/rooms`, or `No Lab Room open`), `#access-terminal` (`location.host`) and `#access-time`.
- `access-clock` ticks `#access-clock`, `#access-seconds` and `#access-date` once a second in the browser's local time.
- `access-enter` is `#access-enter`; a click, or Enter anywhere on the page, sets `sessionStorage["aliquot.access.entered"]` and shows the shell. Storage that throws still shows the landing, and ENTER still opens the shell.

## How to get to it (user POV)

- Open the interface in a new tab or window: the landing shows on any route.
- Press ENTER. Reloading or moving between routes in the same tab keeps the shell.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md).

- **Whole drive.** Run `scripts/drive.sh "$RUN" access`.
- **The landing.** `scripts/browser.mjs "$RUN" access/landing goto '#/org' landing text '#access-laboratory' 'Lab Room · RM-lab' scheme dark landing scheme light viewport 390 landing no-hscroll viewport 1280 enter wait '[data-agent="A-rin"]' goto '#/gates' shell`. The step `landing` in the list makes the run start a fresh session.
- **Proof.** The screenshots show the landing in light, in dark and at 390 px, then the Org view after ENTER, then Gates with no landing in between; the drive appends no Event.

## Gotchas

- Every other drive starts past the landing: `browser.mjs` sets the session key before the page loads unless the step list contains `landing`. A drive that should see the landing must say `landing`.
- The landing has no `nav` and no `main` of its own: `main.ts` finds the shell's `nav` and `main` by tag, so a `nav` or `main` added to the landing would capture the shell's rendering.
