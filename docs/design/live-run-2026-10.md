# The live run of 2026-10-13

This note records the one live run of the society that ends slice 1 (#41). The run used Fixture seed 1, `aliquot serve` with the Scheduler on, and the claude CLI's subscription login. No threshold, weight or budget was changed.

The owner's go, the reopen comment on #41 of 2026-10-13 (06:19:58Z): "Reopened and narrowed. Run the society live once on one Fixture through `aliquot serve` with the Scheduler on, as the ticket says, and keep the log. No tuning: the thresholds in vitality-and-merit.md stay as they are until the chat flow has produced data. Tuning is a later edition."

## What is kept

Everything is under `docs/design/live-run-2026-10/`:

| File | What it is |
|---|---|
| `ledger.sqlite` | The run's Ledger, 33 Events. There is no `ledger export` command, so the file is kept as is. |
| `serve.log` | The stdout and stderr of `aliquot serve`: one line per Scheduler decision. |
| `samples.csv`, `turns.csv`, `reviews.csv` | `vitality export --csv`, `--turns` and `--reviews` on the stopped home. |

The kept Ledger verifies:

```text
$ tools/aliquot --home docs/design/live-run-2026-10 ledger verify
Ledger verified: 33 Events, chain intact
```

## How it ran

The home was a fresh directory outside the repository. The Operator's setup appended Events 1 to 17:

1. `org seed` appended seqs 1 to 8, and `room seed` appended seq 9.
2. `sandbox build` built the image `aliquot-sandbox:464c737`.
3. `sandbox register` registered the six stage Scripts at seqs 10 to 15, each owned by its stage's worker, as `workflow run` registers them.
4. `intake fixtures/submission-form-seed1.docx` stored the form `c8ac9245…` at seq 16.
5. `sandbox store fixtures/submission-form-seed1.weighings.json --type Other` stored the weighings `71a51b19…`, which stage 4 needs, at seq 17.

Then `node conductor/dist/cli.js --home <home> serve --port 0 --tick 15s` ran with the landed defaults. Those are a 30-minute duty, at most 2 Turns at once, and an Energy budget of 1,000,000 tokens. `ALIQUOT_API_KEY`, `ANTHROPIC_API_KEY` and `ALIQUOT_SCRIPTED_MODEL` were unset.

The run started at 06:29:52Z. It ended at 06:50:03Z, a wall time of 20 minutes 11 seconds. The owner cut it short: the coordinator relayed the owner's word to stop the run without waiting for the 30-minute duty Turns. The server was stopped by its pid with SIGTERM, and it printed `Stopped on SIGTERM; the Ledger is closed`. No Turn was open at the stop, because the last Turn had finished at seq 32 (06:30:31Z).

## How far the chain got

The chain stopped at stage 1. T-1 was proposed, assigned and started, and was then escalated to A-pia. No Script ran, and nothing was stored after the setup.

| Step | Seq | Time (Z) | Event |
|---|---|---|---|
| The Director proposes stage 1's Task | 22 | 06:29:58.786 | `TaskProposed` T-1 by A-odile, input the form `c8ac9245…`, TAT `Regular` |
| The Conductor assigns it | 28 | 06:30:22.251 | `TaskAssigned` T-1 to A-ines (pick 109 of 300 over A-bram, A-ines, A-rin, 100 each) |
| The assignee starts it | 30 | 06:30:23.948 | `TaskStarted` T-1 by A-ines |
| The assignee escalates it | 31 | 06:30:28.567 | `TaskEscalated` T-1 to A-pia |
| The last Event | 33 | 06:30:31.572 | `VitalitySampled` A-ines |

Stage 1 took 30 seconds from proposal to escalation. From 06:30:37Z to the stop, 78 Ticks in a row printed `nobody idle no Agent has anything to do`. Ines gave this reason at seq 31:

> The input is a .docx. It is not a PDF and has no readable text through my Tools, so it falls outside my PDF extract/render Charter. I also have no known Script for intake or for creating the submission record, and those steps would need a Specialist with the right Skills or a Gate for the system of record. I found a related artifact, submission-form-seed1.weighings.json (71a51b19...), but I have not used it. Please reassign this to a suitable Agent, or tell me which Script to run.

## Turns

All four Turns ran on `claude-sonnet-5-5`, and each finished `Completed`. None was refused, either by the Ledger or by the subscription.

| Turn | Agent | Why it started | Started, finished (seq) | Counted tokens | Cache read | Tool calls | cost_usd as reported |
|---|---|---|---|---|---|---|---|
| TN-1 | A-mabel | standing duty, no Turn yet | 18, 20 | 7,972 | 0 | 0 | 0.0322 |
| TN-2 | A-odile | 1 Submission Form with no Task | 19, 23 | 10,235 | 7,834 | 1 | 0.0392 |
| TN-3 | A-thorne | standing duty, no Turn yet | 25, 26 | 3,651 | 13,744 | 1 | 0.0113 |
| TN-4 | A-ines | holds T-1 | 29, 32 | 6,282 | 31,895 | 4 | 0.0273 |
| Sum | | | | 28,140 | 53,473 | 6 | 0.1099 |

- **Turns started and ended.** 4 started and 4 ended. None was refused. One `skip` line was printed: A-thorne at 06:29:52.247Z, "2 Turns open, the most at once".
- **Turns open at once.** At most 2: TN-1 and TN-2 were both open from seq 19 to seq 20, for 6 seconds. That is the cap `--concurrency 2` sets. The subscription accepted both, but the run never asked for a third.
- **Tokens against the Energy budget.** 28,140 counted tokens is 2.8 percent of 1,000,000. A Turn averaged 7,035 counted tokens. The 80 percent rule never applied. `cost_usd` is the SDK's notional price. The subscription bills nothing per Turn.

## Vitality and Mood

Each Turn's end sample is in `samples.csv` (seqs 21, 24, 27 and 33). Load, friction and morale stayed at 0, and confidence stayed at 1. The largest fatigue was A-odile's: 0.0819 at seq 24. Every sample's Mood was `fresh`, so no Agent's Mood moved, and Mood played no part in the stall. No Review was recorded, so `reviews.csv` has only its header.

## Scheduler defects

These are the five defects that ticket-40's report recorded:

| # | Defect | Did it show? |
|---|---|---|
| 1 | A Turn left open by a killed Conductor blocks its Agent and a slot | No. The stop was a clean SIGTERM with no Turn open. |
| 2 | Reviewers get no Turn, and the prompt lists no Tasks to review | Not reached. No Task went `UnderReview`. |
| 3 | Over 80 percent, nobody can review or propose rush work | Not reached. The run used 2.8 percent, and the Task was `Regular`. |
| 4 | A refused assignee is still started with a "holds" reason | No. No assignment was refused. |
| 5 | The Director and holders get a Turn every Tick until they act | No. A-odile proposed in her first Turn, and A-ines acted in her first Turn. |

The run stalled on two defects outside that list. Under the brief, only a stall on one of the five was to be fixed, so the run was not fixed and rerun.

- **An escalated Task's target gets no Turn.** The plan wakes an Agent only for a Task it holds, a Message, a Help request or a decided Gate. A Task `Escalated` to an Agent is none of these, and the prompt lists no Tasks escalated to the Agent. Defect 2 has the same shape for reviewers. T-1 has waited on A-pia since seq 31.
- **The stage 1 Task reached an Agent who cannot work it, and nobody can find the Scripts.** For a stage's Task, the plan picks among every Agent of the stage worker's role, so a Specialist whose Charter is PDF work drew stage 1 instead of A-rin, who works stage 1. Both the README and the plan describe this rule. No Tool lists Scripts, and the prompt names neither the stages nor their Scripts, so the assignee "has no known Script" even though `S-parse_submission` was registered at seq 10.

Neither defect is in the Mood thresholds. Both decide whether a live society can get past stage 1. #60 is the next unit to run a live Turn on stage work, so it will meet the same two.
