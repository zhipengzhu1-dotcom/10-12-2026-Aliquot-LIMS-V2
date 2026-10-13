# Ledger view

The Ledger view at `#/ledger` shows the Events newest first, 50 a page, each with seq, time, actor, kind, Task and cause, a payload that opens on click, and a status line with the chain verdict of `/api/ledger/verify` and when it was read; Verify reads the verdict again, a cause links to the page it heads, `#/ledger?before=<seq>` pages back, and the newest page takes each new Event at its top.

## Sub-features

- `ledger-verdict` reads `Ledger verified: <n> Events, chain intact. Checked at <time> UTC.` in `p.verdict[role=status]`.
- `ledger-rows` draws `tr#event-<seq>` newest first, 50 a page.
- `ledger-payload` opens `details#payload-<seq>` on click; a redraw keeps it open.
- `ledger-live` puts a new Event at the top of the newest page with no reload.
- `ledger-verify` re-reads the verdict from the `[data-reload]` Verify button.
- `ledger-cause` links `td.cause a` to `#/ledger?before=<cause+1>`, the page the cause heads.
- `ledger-pages` pages with `nav.pages` (Newest, Newer, Older) and `#/ledger?before=<seq>`.

## How to get to it (user POV)

- Choose `Ledger` in the navigation, or go to `#/ledger`.
- Choose a cause number in an Event's row, or `Older` under the table.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md); Thorne running.

- **Whole drive.** Run `scripts/drive.sh "$RUN" ledger`.
- **Verdict and newest row.** `scripts/api.sh "$RUN" get ledger/verify` gives `count`, the head seq h. `scripts/browser.mjs "$RUN" ledger/ui goto '#/ledger' text '.verdict' 'Ledger verified: <h> Events, chain intact' wait '#event-<h>' click '#payload-<h> > summary' wait '#payload-<h>[open]'`.
- **Live Event.** `outside pause '{"agent_id":"A-thorne","reason":"verify: a live Event on the Ledger view"}' wait '#event-<h+1>' wait '#payload-<h>[open]'`. The new row is on top and the open payload stays open.
- **Verify.** `click '[data-reload]' text '.verdict' 'Ledger verified: <h+1> Events, chain intact'`.
- **Cause link.** `click '#event-<h+1> td.cause a' wait '#event-<c>'`, where c is Thorne's `AgentRecruited` seq from `sqlite3 "$RUN/home/ledger.sqlite"`.
- **Proof.** The screenshot sequence, the `AgentPaused` row with `causation_id` c, and `ledger verify` intact.

## Gotchas

- The view has no filter by kind, actor or Task. Its only query is `before`. Filter by Task in the Flow panel (`#/flow?open=T-1`), or with `sqlite3` on `home/ledger.sqlite`.
- The Checked-at time has one-second resolution. Two Verify clicks inside a second show the same time; assert the Event count in the verdict instead.
- `/api/ledger` pages oldest first from `from`; the view reads the verdict first to find the head, so a broken chain costs a walk of every page.
