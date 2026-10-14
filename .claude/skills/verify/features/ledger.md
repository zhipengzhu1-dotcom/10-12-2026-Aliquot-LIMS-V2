# Ledger view

The Ledger view at `#/ledger` shows the Events newest first, 50 a page, each with seq, time, actor, kind, Task and cause, a payload that opens on click, and a status line with the chain verdict of `/api/ledger/verify` and when it was read; Verify reads the verdict again, a cause links to the page it heads, `#/ledger?before=<seq>` pages back, and every page reloads on each new Event: the newest page takes it at its top, an older page keeps its rows and refreshes its verdict and span. A broken chain shows `Ledger broken at seq <s>: <reason>` in `p.verdict.broken`.

## Sub-features

- `ledger-verdict` reads `Ledger verified: <n> Events, chain intact. Checked at <time> UTC.` in `p.verdict[role=status]`.
- `ledger-rows` draws `tr#event-<seq>` newest first, 50 a page. The third cell is the actor: an Agent id, `Conductor`, the email of the person who acted as the Operator (`verify@lab.test` in a verify run), or `Operator (unnamed)` for an Event written before #74.
- `ledger-payload` opens `details#payload-<seq>` on click; a redraw keeps it open.
- `ledger-live` puts a new Event at the top of the newest page with no page load; the verdict and `Checked at` refresh with it.
- `ledger-verify` re-reads the verdict from the `[data-reload]` Verify button; it does the same read the live refresh does, so prove it only with no Event in flight.
- `ledger-cause` links `td.cause a` to `#/ledger?before=<cause+1>`, the page the cause heads.
- `ledger-pages` pages with `nav.pages` (Newest, Newer, Older) and `#/ledger?before=<seq>`.

## How to get to it (user POV)

- Choose `Ledger` in the navigation, or go to `#/ledger`.
- Choose a cause number in an Event's row, or `Older` under the table.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md). The drive pauses Thorne when he runs and resumes him when an earlier drive left him paused, so its live Event is `AgentPaused` on a fresh run and `AgentResumed` on a second.

- **Whole drive.** Run `scripts/drive.sh "$RUN" ledger`.
- **Verdict and newest row.** `scripts/api.sh "$RUN" get ledger/verify` gives `count`, the head seq h. `scripts/browser.mjs "$RUN" ledger/ui goto '#/ledger' text '.verdict' 'Ledger verified: <h> Events, chain intact' wait '#event-<h>' click '#payload-<h> > summary' wait '#payload-<h>[open]'`.
- **Live Event.** `outside pause '{"agent_id":"A-thorne","reason":"verify: a live Event on the Ledger view"}' wait '#event-<h+1>' wait '#payload-<h>[open]'`. The new row is on top and the open payload stays open.
- **Verify.** `click '[data-reload]' text '.verdict' 'Ledger verified: <h+1> Events, chain intact'`. The live Event already refreshed the verdict, so this step proves the button does not break the view, not that it reads again; the read itself is `/api/ledger/verify`, which `scripts/api.sh "$RUN" get ledger/verify` proves.
- **Cause link.** `click '#event-<h+1> td.cause a' wait '#event-<c>'`, where c is Thorne's latest earlier Org Event (`max(seq)` of the `Agent*` rows naming him in `sqlite3 "$RUN/home/ledger.sqlite"`): his `AgentRecruited` on a fresh baseline, the earlier `AgentPaused` on a second drive.
- **Proof.** The screenshot sequence, the `AgentPaused` (or `AgentResumed`) row with `causation_id` c, and `ledger verify` intact.

## Gotchas

- The view has no filter by kind, actor or Task. Its only query is `before`. Filter by Task on the Flow board (`#/flow?task=T-1`) or open a Task's Event panel (`#/flow?open=T-1`), or use `sqlite3` on `home/ledger.sqlite`.
- The Checked-at time is the browser's clock at one-second resolution, and it moves on every live Event as well as on Verify. Two reads inside a second show the same time; assert the Event count in the verdict instead.
- `/api/ledger` takes `from` (default 1) and `limit` (default 100, at most 1000) and answers 400 for a value that is not a whole number or a `limit` over 1000; it is dispatched in `conductor/src/serve/http.ts` and paged by `ledgerPage` in `routes.ts`. It ignores `before`.
- `before` is the view's hash parameter (`#/ledger?before=<seq>`), not the API's. `before=1`, `before=<head+1>` and a bad `before` all give the newest page.
- `/api/ledger` pages oldest first from `from`; the view reads the verdict first to find the head, so a broken chain costs a walk of every page.
