# The live run of the chat flow, 2026-10-14

This note records the one live run of the chat flow (#73). The Operator typed both Messages in the Chat view while the coordinator watched the Scheduler. The run used `aliquot serve` on `127.0.0.1:8787` with the Scheduler on its defaults (a Tick every 15 s, standing duty every 30 min, at most 2 Turns at once, an Energy budget of 1,000,000 tokens), the claude CLI's subscription login, and the slice-1 tip f631888. No API key was used, and no threshold or default was changed.

The run did not reach a Gate. The receipt was logged live; the results stopped before stage 4 because the Sandbox image the Scripts were registered on had been removed (finding 5). The coordinator stopped the serve at 00:52Z on the owner's word.

## What is kept

Everything is under `docs/design/live-run-2026-10-chat/`:

| File | What it is |
|---|---|
| `ledger.sqlite` | The run's Ledger, 441 Events. |
| `serve.log` | The stdout and stderr of `aliquot serve`: one line per Scheduler decision. |
| `turns.csv`, `reviews.csv` | `vitality export --csv --turns` and `--reviews` on the stopped home. |

```text
$ tools/aliquot --home docs/design/live-run-2026-10-chat ledger verify
Ledger verified: 441 Events, chain intact
```

## What happened

| Time (UTC) | seq | What |
|---|---|---|
| 00:31:42 | 23 | The Operator says the receipt in `RM-lab`. |
| 00:32:12 | 32 | Odile proposes T-1 (receive, log, Work Order) and assigns it to Bram at seq 35. |
| 00:32:33 | 48 | Pia, a Supervisor, also acts on the receipt: she runs `S-parse_message` herself (R-1, seq 45) and proposes T-2 for the same work, assigned to Bram. |
| 00:32:58 | 62 | Bram starts T-1. |
| 00:33:00 to 00:33:05 | 71, 79 | Bram runs stage 2 (R-2, 414 ms) and stage 3 (R-3, 407 ms). |
| 00:33:14 | 85, 84 | Bram completes T-1 and replies: LR-2026-0001 to LR-2026-0003 on WO-2026-0001, due 2026-10-28, both Evaluations passed. |
| 00:33 to 00:44 | 86 to 221 | Bram escalates T-2 as a duplicate. Five Agents try to close it and cannot. Pia records three Reviews of T-1. |
| 00:44:19 | 222 | The Operator says the results. |
| 00:44:37, 00:44:58 | 228, 237 | Anselm and Odile each propose a stage 4 Task (T-3, T-4); both go to Rin. |
| 00:45 | 251, 252 | Rin's `S-parse_results_message` Runs fail: the image `sha256:87760da6…` is missing. She escalates T-3 and T-4. |
| 00:52:41 | 441 | Last Event; the serve is stopped. |

Receipt to logged Samples took 91 s. The same three Script Runs took 1.1 s of that. All six stages run by `workflow run` with no Agent take 2.7 s on the same machine.

## Numbers

- 114 Turns, 626,901 counted tokens: 63 percent of the Energy budget in 35 minutes. Two Turns were standing duty; every other Turn was started by a new Message in `RM-lab`.
- Tokens by Agent: Pia 105,253, Odile 98,874, Thorne 88,236, Bram 83,400, Mabel 81,573, Anselm 76,312, Rin 53,925, Ines 39,328. The work itself was Bram's T-1 Turn (17,771 tokens) and the two proposals.
- 42 Messages in `RM-lab`, 2 of them the Operator's.
- At most 2 Turns at once; every Tick with a new Message skipped six Agents for the cap.

## Findings

1. **Every Agent acts on the Operator's Message.** Each Message wakes all eight Agents, and nothing stops an Agent that is not the Director from proposing work on it. Pia proposed T-2 for the receipt; Anselm proposed T-3 for the results. Two duplicate Tasks from two Messages.
2. **An Escalated Task cannot be closed.** No Agent may fail it, and a second escalation is refused because it is already Escalated. T-2 stayed Escalated; Odile, Pia, Mabel and Thorne each tried and then wrote about it.
3. **A Review does not close a Task UnderReview, and nothing says so.** Pia recorded three Reviews of T-1 (seq 92, 130, 186); T-1 stayed UnderReview because closing it is a separate `task complete`. No Agent's view shows a Task's Reviews, so Thorne could not confirm them.
4. **Messages about Messages cost most of the budget.** Each Agent reply wakes the other seven. The run spent about 600,000 tokens on talk about T-2 and T-1 and about 30,000 on the work.
5. **A rebuild under the live run's tag removed its Sandbox image.** The live home's Scripts were registered on `sha256:87760da6…`, the image behind `aliquot-sandbox:f631888` (Events 10 to 16). At 00:39:30 the #74 worker's `tools/check-readme.sh`, on the same commit f631888, ran the README's `sandbox build` with no `--tag`, a `docker build -t aliquot-sandbox:f631888` (`docker image inspect` gives the tag that `LastTagTime`; the worker's script copy was written at 00:39:00 and its commit followed at 00:39:50). On this Docker (29.5.2, containerd image store) every build gets a new id and the daemon drops the image a re-pointed tag held, so `87760da6…` was gone and every Run after 00:45 failed. No test was at fault: every Docker suite builds and removes a tag of its own, `aliquot-sandbox:<suite>-<pid>`, and `tools/check.sh` builds only `aliquot-sandbox:test`. Fixed in #78: a build under a tag Docker already has keeps that image. Shared Docker state is still a hazard for any long-running home on the machine.
6. **The path is slow by construction.** A Message waits for the next Tick (up to 15 s), then for one of two Turn slots, then for a model to decide what the next step is, though the next step is always the same. Receipt to reply: 91 s. The owner's expectation, 2026-10-14: the result "under 10 seconds", then "even quicker, instantly".

## What follows

The owner's direction on finding 6 is an instant chat path: the engine runs the chain in code when the Message arrives and replies at once, a model is called only for a Message the patterns cannot read, and Agents review and audit beside the path rather than in it (ADR-0017). That change removes findings 1, 2 and 4 from the path. Finding 5 is fixed in #78: a build under a tag Docker already has keeps that image.
