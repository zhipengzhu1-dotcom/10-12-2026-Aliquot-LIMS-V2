---
name: verify
description: Launch the Aliquot LIMS Conductor on a fresh home and drive its web interface (`aliquot serve`, hash routes such as `#/org`, `#/flow`, `#/gates`) and its `/api` like the Operator, then leave a proof.md with screenshots, API bodies and Ledger rows. Use to prove a ticket's interface or CLI behaviour before its final push, to reproduce a bug on the real surface, or when asked to run, check or screenshot the app.
---

# Verify Aliquot

Every helper below is a script in `scripts/`, run from this skill's directory (`.claude/skills/verify/`). The checks this skill states live in those scripts, so run them; reading them is not a substitute. The feature map in [features/README.md](features/README.md) is the recipe book: read its index, then the file of the feature you are proving.

The Operator's three maxims: "No proof, no merge. Every failure becomes a skill. A rule the model can forget is not a rule."

## The whole loop

```sh
cd "$(git rev-parse --show-toplevel)/.claude/skills/verify"
scripts/prove.sh org --intent 'Pause and resume from the Org view, and Rest from the Action bar'
```

`prove.sh <feature> [--intent '<text>']` runs Launch, Doctor, Drive and Cleanup below in order, and exits 0 only when the proof's verdict is PASS and the proof outlived the cleanup. Its last line is `proof: <run>/proof/proof.md`. Features with a drive: `org`, `flow`, `agent`, `gates`, `ledger`, `chat`. Run the parts by hand when you drive something the recipes do not cover.

## Launch

```sh
scripts/launch.sh            # or --port <n>; the default 0 lets the system choose
# Serving <run>/home at http://127.0.0.1:<port> (pid <n>)
# RUN=<run>
RUN=<the path after RUN=>
```

It needs Docker up. It runs `pnpm -C conductor install --frozen-lockfile` and `pnpm -C conductor build`, makes a run directory under `$ALIQUOT_VERIFY_ROOT` (default `${TMPDIR:-/tmp}/aliquot-verify`), and seeds `home/` with `org seed`, `workflow run fixtures/submission-form-seed1.docx` (stages 1 to 6 in the Sandbox, Tasks T-1 to T-6) and `intake fixtures/submission-form-seed2.docx`. Then it starts `tools/aliquot --home <run>/home serve --port <port> --no-schedule` and waits for the `Serving` line. It records the launcher pid and the pid that holds the Ledger's writer lock in `<run>/run.env`. Every command it ran is in `proof/launch.log`; serve's output is `proof/serve.log`.

Isolation is one run directory, one home and one port per launch, so two runs never share state. The helpers refuse a directory without `run.env`: drive only homes you launched.

Seed extra data before `serve` starts: `serve` holds the writer lock, and a writing command exits 1 with `LedgerLocked` while it runs. Once it runs, write through an action (`scripts/api.sh act`) or the interface.

## Doctor

```sh
scripts/doctor.sh "$RUN"     # doctor: ok for <run>, or doctor: <n> check(s) failed
```

Read-only. Run it first, and again whenever anything looks off. It checks that the recorded serve pid is alive and holds the writer lock, `/api/org` answers eight Agents, `/api/scheduler` answers 404 (the Scheduler is off), `ledger verify` and `/api/ledger/verify` say the chain is intact, `GET /` serves the built interface, and `conductor/dist/ui` is newer than `conductor/src` and `conductor/ui`. A stale build means launch a new run: `launch.sh` rebuilds.

## Drive

```sh
scripts/drive.sh "$RUN" org [--intent '<the acceptance box, quoted>']
```

`drive.sh` runs the feature's `drive_<feature>` function, checks its end state, and appends the feature's section to `proof/proof.md`. The functions use two helpers you also call directly:

- `scripts/browser.mjs "$RUN" <name> <step>...` drives headless system Chrome over CDP and saves a screenshot after every step to `proof/<name>/NN-<step>.png`, with `steps.tsv`. The steps are `goto <hash>`, `click <selector>`, `fill <selector> <text>` (typed as key input), `choose <selector> <value>`, `wait <selector>`, `gone <selector>`, `count <selector> <n>`, `text <selector> <text>`, `mark` and `same-page` (no reload between them), `outside <verb> <json>` (an action from a second client, for redraws over the Event stream), and `save <selector> <file>`. It exits 1 at the first failing step, after a `FAILED` screenshot. Set `CHROME` to use another Chrome binary.
- `scripts/api.sh "$RUN" get <route>` reads `/api/<route>`; `scripts/api.sh "$RUN" act <verb> '<json>' [--expect <code>]` posts `/api/actions/<verb>`, the route every view form and the Action bar post to. It exits 0 only on the expected status (200 by default), so `--expect 409` proves a refusal.

Address elements by the handles the views draw (`id`, `data-agent`, `data-task`, `data-lane`, `data-gate`, `data-action`, `data-route`) and by hash route. Each feature file lists its handles.

For the command line, drive by command and exit code: `tools/aliquot --home "$RUN/home" <command>`, with `--home` absolute. A writing command works only after `cleanup.sh` has stopped `serve`.

Turns stay off. `serve` runs only with `--no-schedule`, and no helper sets `ALIQUOT_LIVE_TURN` or an API key: both start live model Turns on the Operator's subscription, which only the Operator may start (gate G3). A proof that needs a Turn runs `turn run` with `ALIQUOT_SCRIPTED_MODEL=<json file>` (README "Turns") while `serve` is stopped.

## Evidence

No proof, no merge. Every run writes one `proof.md` at `<run>/proof/proof.md`, outside the repository. `launch.sh` starts it with the run, commit, home and URL; each `drive.sh` appends a section with this fixed shape:

1. **Intent.** The ticket's acceptance box, quoted, from `--intent`; by default the feature file's title and paragraph.
2. **Commands.** Every command, as you would rerun it from this directory, with its exit code and output file.
3. **Evidence.** One PASS or FAIL line per check; for the interface, the screenshot sequence of every step inline, from the form before the action through the status line to the redrawn view; the API bodies; the Ledger rows the drive appended, read from `home/ledger.sqlite` with `sqlite3`; `ledger verify`.
4. **Verdict.** One line: `PASS. <n> of <n> checks held.` or `FAIL. <k> of <n> checks failed.`

`cleanup.sh` appends the Cleanup lines. The standard a check meets:

- Drive the Operator's path: a view's form or the Action bar for the action under test. `api.sh act` is the second client and the refusal probe, never the proof of a form.
- Prove a mutation twice: on screen, and in a read-only second view (`/api/*` and the `events` rows).
- Prove absence where the contract needs it, such as a read-only view appending no Event.
- The implementer of a ticket quotes the `proof.md` path in the report, with the verdict line.

When `drive.sh` has no drive for what you prove, keep the same shape: run `browser.mjs` and `api.sh` by hand and write their outputs into a section of the same `proof.md`. Then add the drive (next section).

## Every failure becomes a skill

Any failure you meet while verifying is a lesson for the next agent, written in the same branch as your ticket:

- A trap in a mapped feature goes into that feature file's `Gotchas`, with the text or screenshot that showed it.
- A feature with no file gets one: copy the four H2s from [features/README.md](features/README.md), index it there, and add a `drive_<feature>` function to `scripts/drive.sh` that you have run to PASS.
- A check you found yourself doing by hand becomes a check in a script, not a sentence here.

## Cleanup

```sh
scripts/cleanup.sh "$RUN"    # stopped; evidence kept at <run>/proof/proof.md
```

It sends SIGTERM to the serve pid in `run.env` (only while it still holds the writer lock), then to the launcher pid, then to any Chrome pid `browser.mjs` recorded, and removes the Chrome profiles. It never kills by process name. It fails unless no process names the run's home or a Chrome profile of the run, the writer lock is released, and the port no longer answers. `home/` (the Ledger) and `proof/` stay. Run it after every attempt, failed ones included.

## Helpers

| Script | Run as | Does |
|---|---|---|
| `scripts/prove.sh` | `scripts/prove.sh <feature> [--intent '<text>']` | Launch, doctor, drive, cleanup, and check the proof survived |
| `scripts/launch.sh` | `scripts/launch.sh [--port <n>]` | Build, seed a fresh home, start `serve --no-schedule`, print `RUN=` |
| `scripts/doctor.sh` | `scripts/doctor.sh "$RUN"` | Read-only checks that the run is worth driving |
| `scripts/drive.sh` | `scripts/drive.sh "$RUN" <feature> [--intent '<text>']` | Drive a mapped feature, append its proof section |
| `scripts/browser.mjs` | `scripts/browser.mjs "$RUN" <name> <step>...` | Headless Chrome over CDP, a screenshot per step |
| `scripts/api.sh` | `scripts/api.sh "$RUN" get <route>` or `act <verb> '<json>' [--expect <code>]` | `/api` reads and actions with a status check |
| `scripts/cleanup.sh` | `scripts/cleanup.sh "$RUN"` | Stop what the run started; keep `home/` and `proof/` |

`scripts/lib.sh` is sourced by the others. The helpers need bash, curl, jq, sqlite3, Node 24 (for `browser.mjs`, with no package), Docker and Google Chrome. Keep the map honest as the app changes with `/maintain-verification-skill`.
