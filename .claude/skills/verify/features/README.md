# Aliquot interface feature map

This directory is the maintained source for proving what the Operator sees and does in the Aliquot interface that `aliquot serve` serves. Read this index before driving, then follow the matching feature file. Each feature with a file here has a `drive_<feature>` function in `scripts/drive.sh` that runs its `Driving it` section and appends its proof to `proof.md`.

## Baseline preconditions

- `scripts/launch.sh` made the run: a fresh home under `$ALIQUOT_VERIFY_ROOT` (default `${TMPDIR:-/tmp}/aliquot-verify`), seeded with `org seed` (eight Agents on `Probation`), `workflow run fixtures/submission-form-seed1.docx` (Tasks T-1 to T-5, all `Done`, one Lot), `intake fixtures/submission-form-seed2.docx` (one Submission Form with no Task), and `room seed` with one Message by Odile in `RM-lab`.
- `serve` runs with `--no-schedule` on a port the system chose. `scripts/doctor.sh "$RUN"` prints `doctor: ok`.
- No Gate is open, no Agent is paused, resting or retired, and every Agent is at definition version 1.
- Never drive a home that `launch.sh` did not create. The helpers refuse a directory without `run.env`.

## Driving conventions

- Every feature drive starts from the baseline. The drives touch different Agents (Org: Rin and Ines; Agent: Rin's Coaching and Revision; Gates: Bram and Mabel; Ledger: Thorne; Chat: two Operator Messages in RM-lab), so they run in any order on one run.
- Drive each feature once per run. A second Org drive on the same run fails at Rest, because Ines is already resting; launch a fresh run to drive a feature again. The Ledger drive alone resumes Thorne when an earlier drive left him paused.
- Address elements by the handles the views draw: `id`, `data-agent`, `data-task`, `data-lane`, `data-gate`, `data-action`, `data-route`, and the hash route. Never by position or coordinates.
- Run an Operator action the way the Operator does: through the view's form (`form[data-action]`) or the Action bar above every page (`#action`). `scripts/api.sh act` posts to the same endpoint, `POST /api/actions/<verb>`; use it for a second client or a refusal check, not as the proof of a view's form.
- `serve` holds the Ledger's writer lock. A CLI command that writes exits 1 with `LedgerLocked` while it runs. Put data in before `launch.sh` starts `serve`, or through an action.

## Proof and skip reporting

- A proof is `proof/proof.md` in the run directory, with a section per driven feature: the intent quoted, the commands with exit codes, the evidence (a screenshot per browser step, API bodies, the Ledger rows the drive appended, `ledger verify`), and a one-line verdict.
- Capture the action and the resulting state: the screenshot sequence shows the form before, the status line after, and the redrawn view.
- A mutation is proved by a second, read-only view: `/api/*` and the `events` rows in `home/ledger.sqlite`, not only the status line.
- A feature whose path cannot be reached is reported with the command tried and the precondition that failed. Do not report it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the behaviour the Operator sees. `drive.sh` quotes that title and paragraph as the default intent. It then has exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.sh and browser.mjs`, and `Gotchas`.

## Features

- [Org tree and its Actions](./org.md) covers the reporting tree, Mood and load badges, pause and resume, Rest through the Action bar, reassign and the redraw over the Event stream.
- [Flow board and the Task Event panel](./flow.md) covers the stage swimlanes, the Task and Lot filters, and the panel of a Task's Events with cause arrows.
- [Agent page](./agent.md) covers Charter, Persona, Vitality, Merit after each Review, Coaching and authoring a Revision.
- [Gates](./gates.md) covers the open Gates waiting on the Operator, the proposed-change table, and approve and reject with a reason.
- [Ledger view](./ledger.md) covers the newest-first Event table, the chain verdict and Verify, paging with `before`, cause links, and live Events.
- [Chat view](./chat.md) covers the Lab Room's Messages newest last with the sayer's name, the box that says the Operator's text through `room-say`, and the redraw on another client's Message.

## Further surfaces, no feature file yet

- The command line. `tools/aliquot --home <abs path> <command>` drives every domain (`org`, `task`, `gate`, `vitality`, `training`, `room`, `sandbox`, `workflow`, `intake`, `turn`, `ledger`). Drive it by command and exit code. It writes only while `serve` is stopped. README.md has a section per domain.
- The Sandbox. `workflow run <fixture>` runs Python Scripts in Docker, stages 1 to 5. `launch.sh` runs it once, and `launch.log` holds its output. `sandbox runs` and `sandbox lineage <artifact id>` read what it did.
- The Scheduler. `serve` without `--no-schedule` runs a Tick every `--tick` and starts Turns; `/api/scheduler` reports the last Tick. A verify run never starts it on the real model: that starts live Turns on the Operator's subscription (gate G3). A proof of a scheduled Turn needs `ALIQUOT_SCRIPTED_MODEL=<json file>` (README "Turns") and a drive that does not exist yet.
- The Rooms, Scripts and Performance views (`#/rooms`, `#/scripts`, `#/performance`). Rooms and Scripts show their JSON as it came; Performance draws Merit, the rubric means, the Energy budget and `reviews.csv`.
