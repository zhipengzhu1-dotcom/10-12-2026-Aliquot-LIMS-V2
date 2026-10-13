# Flow board and the Task Event panel

The Flow view at `#/flow` draws one swimlane per stage of the toy workflow and one for Tasks in no stage, a card per Task with its id, title, state, assignee and TAT class, filters by Task id or Lot that live in the hash, and a panel that lists an open Task's Events in seq order with an arrow from each Event to its cause.

## Sub-features

- `flow-lanes` draws one `[data-lane]` per row of `/api/stages` plus `No stage`; a Task sits in the lane of the stage whose Script its latest Run ran.
- `flow-cards` draws each Task as `a.card[data-task]` with its state in `[data-state]`.
- `flow-filter-lot` filters by Lot from the `form.filter[data-route="#/flow"]` select; the hash becomes `#/flow?lot=<lot>`.
- `flow-filter-task` filters by Task id, as in `#/flow?task=T-2`.
- `flow-panel` opens a Task (`?open=T-1`): `aside.panel` lists its Events as `li[data-seq]`, the first one's outside cause marked `outside`, and `svg.arrows path[data-from][data-to]` draws each cause arrow.
- `flow-live` moves a card when a Run of its Task starts. No action runs the workflow, so this is seen only across a `serve` restart.

## How to get to it (user POV)

- Choose `Flow` in the navigation, or go to `#/flow`.
- Choose a Lot in the filter and `Filter`, or type a Task id.
- Choose a card to open its Event panel; `Close` in the panel heading closes it.

## Driving it with drive.sh and browser.mjs

Preconditions:

- The baseline of [README.md](./README.md): T-1 to T-5 `Done`, one Lot from seed 1.

- **Whole drive.** Run `scripts/drive.sh "$RUN" flow`.
- **Lanes.** `scripts/api.sh "$RUN" get stages` gives the stage count n. `scripts/browser.mjs "$RUN" flow/ui goto '#/flow' count '[data-lane]' <n+1> wait '[data-task="T-1"]'`.
- **Lot filter.** `scripts/api.sh "$RUN" get lots` names the Lot, such as `LT-268123`. `choose 'form.filter select[name=lot]' LT-268123 click 'form.filter button' wait 'form.filter option[selected][value="LT-268123"]' wait '[data-task="T-5"]'`. Every stage's Task carries the Lot, so all five cards stay.
- **Event panel.** `click '[data-task="T-1"]' wait 'aside.panel li[data-seq]' wait 'svg.arrows path' save 'aside.panel' panel.txt`. The panel lists `TaskProposed` through `TaskCompleted` for T-1 with `cause <seq>` on each.
- **Task filter.** `goto '#/flow?task=T-2' wait '[data-task="T-2"]' gone '[data-task="T-1"]'`.
- **Proof.** The screenshot sequence, `panel.txt`, and no Ledger row appended (the view only reads): `sqlite3 "$RUN/home/ledger.sqlite" 'select max(seq) from events'` is unchanged.

## Gotchas

- A filter is a hash change, not a request. Wait for the redrawn `option[selected]`, not for the click.
- The panel reads only the Ledger's first 1,000 Events; past that it says so in `p.note`.
- No view action runs the workflow, so a card crossing lanes live needs a `serve` restart around a `workflow run`. `launch.sh` runs the workflow before `serve` for this reason.
