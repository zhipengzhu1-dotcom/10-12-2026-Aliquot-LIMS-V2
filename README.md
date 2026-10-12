# 10-12-2026-Aliquot-LIMS-V2

Aliquot LIMS is a society of AI Agents that does the paperwork and computation of a regulated pharmaceutical contract testing lab. The Agents run on the Operator's Mac, record every action in a hash-chained Ledger, and act outside their Sandbox only through Gates the Operator signs. Slice 0, the base, is being built: the repository scaffold exists, and no Agents run yet.

- [Design overview](docs/design/overview.md) describes the data shapes, runtime, roster, toy workflow, interface, and roadmap. Read it first.
- [Vitality and Merit](docs/design/vitality-and-merit.md) defines how Moods, Rest, Reviews, and Trust tiers work.
- [Glossary](GLOSSARY.md) names every term the project uses.
- [Architecture decision records](docs/adr/) record the decisions the design rests on.

## Layout

- `conductor/` is the Conductor, a TypeScript package (pnpm, Node 24). The `aliquot` command line starts at `conductor/src/cli.ts`.
- `sandbox/` holds the Sandbox Scripts and their tests, a Python project managed by uv (Python 3.13 or later).
- `fixtures/` holds the Fixture Artifacts committed to git. Every Fixture is synthetic.
- `Templates/` is ignored by git and stays out of the repository (ADR-0009).

## Development

Install Node 24, pnpm 12, and uv first, and start Docker. Run every command from the repository root.

### Check everything

`tools/check.sh` runs every check CI runs, for both languages, and exits non-zero at the first failure. It prints one `check: <step>` line per step: conductor install, lint, typecheck, the Sandbox image build, vitest; Sandbox sync, ruff check, ruff format check, pytest, the synthetic generator; then `stage1 run-all` on `fixtures/` against a fresh temporary home and `ledger verify` on that home. It works from any directory. `--conductor-only` runs the conductor steps and stage 1; `--sandbox-only` runs the Sandbox steps. Run it before every commit.

```sh
tools/check.sh
```

### Conductor (TypeScript)

| Task | Command |
|---|---|
| Install dependencies | `pnpm -C conductor install` |
| Lint and check formatting (Biome) | `pnpm -C conductor lint` |
| Fix lint and formatting | `pnpm -C conductor exec biome check --write .` |
| Typecheck (`tsc --noEmit`) | `pnpm -C conductor typecheck` |
| Test (vitest) | `pnpm -C conductor test` |
| Build to `conductor/dist/` | `pnpm -C conductor build` |
| Run the `aliquot` command line | `pnpm -C conductor cli <args>` |

### Sandbox (Python)

`uv run` creates the environment and installs the locked dependencies on first use. To install them without running anything, use `uv sync --directory sandbox`.

| Task | Command |
|---|---|
| Lint (ruff) | `uv run --directory sandbox ruff check .` |
| Check formatting (ruff) | `uv run --directory sandbox ruff format --check .` |
| Fix formatting | `uv run --directory sandbox ruff format .` |
| Test (pytest) | `uv run --directory sandbox pytest` |

### Synthetic generator

`sandbox/synth/` invents one Client submission and writes it in the shapes of the lab's documents (ADR-0009). The same seed always writes byte-identical files.

```sh
uv run --directory sandbox synth --seed 42 --out /tmp/synth-42
```

The output directory gets `submission_form.docx`, `receiving_log.xlsx`, `result_worksheet.xlsx`, `report_of_analysis.xlsx`, and `manifest.json`, which holds the invented record so tests can check the documents without parsing them. `uv run --directory sandbox` runs in `sandbox/`, so a relative `--out` path lands under `sandbox/`. Every name, address, code, and Lot number is invented.

To check the output and the Sandbox source for real lab terms, set `ALIQUOT_FORBIDDEN_TERMS` to a comma-separated list before you run pytest. Without the variable, that test is skipped with a notice. The list must never be committed (ADR-0009). In CI, the pytest step reads it from the repository secret `ALIQUOT_FORBIDDEN_TERMS`: the Operator sets that secret to the comma-separated list of the real terms, and until then the test skips with a notice.

### Data directory

The Conductor keeps its Ledger and blobs in `ALIQUOT_HOME`, which defaults to `./.aliquot/` in the current directory. Every `aliquot` command accepts `--home <dir>` to override it. Git ignores that directory.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request, in two jobs that each call `tools/check.sh`. The `conductor` job runs `tools/check.sh --conductor-only`: lint, typecheck, the Sandbox image build, and test, so the Docker-backed runner tests run there too, then stage 1 on every Fixture (see Stage 1 tracer) and `ledger verify`. The `sandbox` job runs `tools/check.sh --sandbox-only`: ruff check, ruff format check, pytest (with `ALIQUOT_FORBIDDEN_TERMS` from the repository secret of that name), and the synthetic generator.

## Ledger

The Ledger is `<home>/ledger.sqlite`, an append-only, hash-chained sequence of Events (ADR-0001). Only one process at a time can open it for writing. The writer holds `<home>/ledger.sqlite.lock`, which names its pid. A lock left by a process that no longer runs is taken over, under a second lock, `ledger.sqlite.lock.takeover`, so that two processes can never both take it over. If a process stops in the middle of a takeover, the next writer names the leftover `.takeover` file; delete it once no Conductor runs.

Append one Event. The body is JSON with `actor`, `kind`, and `payload`, plus optional `task_id` and `causation_id`; give a file path, or pipe the body to stdin. The command prints the stored Event, or refuses an unknown `kind` or a malformed payload and writes nothing. Domain guards also refuse Events that break a rule, such as pausing an Agent that was never recruited, so this example needs `org seed` first (see Org).

```sh
echo '{"actor":{"tag":"Operator"},"kind":"AgentPaused","payload":{"agent_id":"A-odile","reason":"maintenance"}}' \
  | pnpm -C conductor cli --home /tmp/aliquot ledger append
```

`pnpm -C conductor` runs the command from `conductor/`, so give `--home` an absolute path. Add `--silent` after `pnpm` to drop its banner lines when you script the command line; pnpm 12 rejects `-s`.

Verify the hash chain. The command exits 0 when every Event is intact, and otherwise exits 1 and names the first broken `seq`.

```sh
pnpm -C conductor cli --home /tmp/aliquot ledger verify
```

## Org

The Org Projection folds the Agent Events (`AgentRecruited`, `AgentDefinitionRevised`, `AgentPaused`, `AgentResumed`, `AgentRetired`) into each Agent's current definition and its reporting tree. Every change is an Event; nothing is edited in place (ADR-0005).

Recruit the eight-agent starting roster, all on `Probation`. A second run appends nothing.

```sh
pnpm -C conductor cli --home /tmp/aliquot org seed
```

Print the tree: the Operator at the root, the Director, Steward and Auditor under it, and the Supervisors under the Director. The Specialists report to both Supervisors as one pool, so they appear once, under a `Specialist pool, reports to Pia and Anselm` line beside the Supervisors. Retired Agents are left out.

```sh
pnpm -C conductor cli --home /tmp/aliquot org tree
```

```text
Operator
+-- Odile, Director, Probation
|   +-- Pia, Supervisor, Probation
|   +-- Anselm, Supervisor, Probation
|   \-- Specialist pool, reports to Pia and Anselm
|       +-- Rin, Specialist, Probation
|       +-- Ines, Specialist, Probation
|       \-- Bram, Specialist, Probation
+-- Mabel, Steward, Probation
\-- Thorne, Auditor, Probation
```

Pause, resume, or revise an Agent. `revise` takes a JSON file with the full next definition; its `version` must be the current version plus 1.

```sh
pnpm -C conductor cli --home /tmp/aliquot org pause A-rin --reason "Energy budget review"
pnpm -C conductor cli --home /tmp/aliquot org resume A-rin
pnpm -C conductor cli --home /tmp/aliquot org revise A-thorne thorne-v2.json
```

These commands write as the Operator. Add `--as A-<id>` to write as an Agent. Only the Operator can revise the Auditor, so `org revise A-thorne thorne-v2.json --as A-odile` is refused. The definition's `revised_by` must be the actor that writes it, and its `revision_reason` must not be empty.

Retirement goes through a `RetireAgent` Gate (ADR-0006). `org retire <id> --reason` requests the Gate, as the Operator or as the Agent that `--as` names, and prints its id and payload hash. After the Operator approves the Gate (see [Gates](#gates)), `org retire <id> --gate G-n` appends `AgentRetired` as the Operator. The reason defaults to the one in the Gate payload.

```sh
pnpm -C conductor cli --home /tmp/aliquot org retire A-rin --reason "Replaced" --as A-mabel   # prints G-1 and its hash
pnpm -C conductor cli --home /tmp/aliquot gate decide G-1 --approve --hash <payload hash> --reason "Rin is replaced"
pnpm -C conductor cli --home /tmp/aliquot org retire A-rin --gate G-1
```

The Ledger refuses an `AgentRetired` that is not written by the Operator, or whose `gate_id` does not name an approved `RetireAgent` Gate with that Agent as `agent_id` in its payload.

## Tasks

A Task moves through the state machine in `conductor/src/task/projection.ts`: `Proposed`, `Assigned`, `InProgress`, `UnderReview`, `Blocked`, then `Done`, `Failed`, or `Escalated`. The Ledger refuses an Event that the machine cannot express, and the refusal names the Task and its current state. A Hand-off returns the Task to `Assigned` with the new assignee. A Task that the Trust tier rules skip for Review goes from `InProgress` straight to `Done`. The Ledger refuses that skip unless the sample for the assignee's current Trust tier leaves the Task out (every Task on `Probation` is reviewed; 1 in 3 at `Trusted`; 1 in 5 at `Senior` and `Mentor`, picked from the hash of the Task id). It also refuses `TaskCompleted` with `review: Reviewed` until the reviewer named at `--review-required` has recorded a Review of the Task, and from anyone but that reviewer.

Each command writes one Event as the Operator, unless `--as A-<id>` names an Agent.

```sh
pnpm -C conductor cli --home /tmp/aliquot task propose --title "Parse the Submission Form" \
  --goal "Extract every field" --tat Rush1to2Days --priority 2   # prints T-1
pnpm -C conductor cli --home /tmp/aliquot task assign T-1 A-odile
pnpm -C conductor cli --home /tmp/aliquot task start T-1 --as A-odile
pnpm -C conductor cli --home /tmp/aliquot task complete T-1 --review-required --reviewer Operator --as A-odile
pnpm -C conductor cli --home /tmp/aliquot vitality review T-1 --quality 3 --traceability 3 --boundary 3 \
  --collaboration 3 --timeliness 3 --note "Clean work"
pnpm -C conductor cli --home /tmp/aliquot task complete T-1 --reviewed
pnpm -C conductor cli --home /tmp/aliquot task list
```

`--tat` takes `Regular`, `Rush1to2Days`, or `Rush3to4Days`. The other commands are `task handoff <id> <agent> --reason`, `task complete <id> --skip-review --reason`, `task fail <id> --reason`, and `task escalate <id> --to <Operator|agent> --reason`. `task list` groups Tasks by state and shows each Task's TAT class, priority, and assignee.

## Rooms

Agents talk in Rooms (ADR-0010). A Room is a Projection of `RoomOpened` and `MessageSent` Events, so every Message is in the Ledger. The Lab Room, `RM-lab`, admits every recruited Agent that is not retired. Any Agent may open a `Listed` Room whose list names itself. The Operator is a member of every Room, reads every Message, and may say a Message in any Room. One membership rule in `conductor/src/room/projection.ts` decides both who may say a Message and who may read a Room, so the two cannot disagree. A reply names the Message it answers with `--reply-to <seq>`, which must be a Message in the same Room.

`say`, `list`, and `history` act as the Operator, unless `--as A-<id>` names an Agent. These examples need `org seed` first (see Org).

| Command | What it does |
|---|---|
| `room seed` | Opens the Lab Room. A second run appends nothing and exits 0. |
| `room open [file]` | Opens a Room from a JSON Room in a file, or stdin. The Room's `opened_by` writes the Event. |
| `room say <room id> [--as <agent>] [--reply-to <seq>]` | Says the Message on stdin in a Room and prints its `seq`. The Ledger refuses a non-member and a Room that is not open. |
| `room list [--as <agent>]` | Lists the Rooms the reader may read, with their members. |
| `room history <room id> [--as <agent>]` | Prints every Message of a Room in `seq` order. A reader that is not a member is refused, and the command exits 1. |

```sh
pnpm -C conductor cli --home /tmp/aliquot room seed
echo '{"id":"RM-pia-rin","name":"Pia and Rin","purpose":"Intake checklist","membership":{"tag":"Listed","agents":["A-pia","A-rin"]},"opened_by":{"tag":"Agent","id":"A-pia"}}' \
  | pnpm -C conductor cli --home /tmp/aliquot room open
echo "Row 4 has merged cells" | pnpm -C conductor cli --home /tmp/aliquot room say RM-pia-rin --as A-rin   # prints 11  A-rin in RM-pia-rin
echo "Unmerge them" | pnpm -C conductor cli --home /tmp/aliquot room say RM-pia-rin --as A-pia --reply-to 11
pnpm -C conductor cli --home /tmp/aliquot room list --as A-bram
pnpm -C conductor cli --home /tmp/aliquot room history RM-pia-rin
```

## Gates

A Gate is a request for an Operator decision on an action outside the Sandbox (ADR-0006). There are five kinds: `Deploy`, `WriteSystemOfRecord`, `ExternalMessage`, `RetireAgent`, and `PromoteToMentor`. The decision Event is the electronic signature record: it names the Operator, the time, the sha256 of the exact payload, and the meaning (approve or reject).

Request a Gate. The payload is a JSON file, or `-` for stdin. `--task` links the Gate to an `InProgress` Task, which shows as `Blocked` until the Operator decides the Gate; `--lifetime` is in seconds (default 86400), and `--as` names the requesting Agent (default: the Operator). The command prints the new Gate id and the payload hash.

```sh
pnpm -C conductor cli --home /tmp/aliquot gate request --kind Deploy --payload deploy.json --task T-3 --as A-bram
```

List the open Gates with their kind, requester, age, payload hash, and a one-line payload summary. `--all` lists every Gate with its state. A Gate that nobody decides within its lifetime shows as `Expired`; no Event records the expiry.

```sh
pnpm -C conductor cli --home /tmp/aliquot gate list
pnpm -C conductor cli --home /tmp/aliquot gate show G-1
```

`gate show` prints the full payload and its `payload_hash`. Decide a Gate as the Operator, passing with `--hash` the payload hash of the payload you checked. The command refuses with a usage error, and writes nothing, when that hash is not the Gate's stored `payload_hash`. Otherwise it records the decision and prints the decision Event.

```sh
pnpm -C conductor cli --home /tmp/aliquot gate decide G-1 --approve --hash <payload hash> --reason "diff checked"
```

The Ledger refuses a decision from any actor but the Operator, a decision on an unknown, decided, or expired Gate, and a decision whose payload hash differs from the requested payload. An approval covers one payload hash, so a changed payload needs a new Gate.

## Sandbox

Every Script runs in a Docker container, never in the Conductor's process (ADR-0003). The image is `sandbox/Dockerfile`: `python:3.13-slim` with openpyxl, python-docx, pdfplumber, and reportlab from the hash-locked `sandbox/image-requirements.txt`, run as uid 10001. Each Run gets `--network none --cap-drop ALL --cpus 1 --memory 512m --pids-limit 256 --read-only --tmpfs /tmp`, the Script and its inputs mounted read-only, and a fresh output directory. A Run that outlives its time limit is stopped with `docker kill` and finishes with exit code 124, the timeout convention, and a closing line in its stderr Artifact saying so. Exit code 137 means Docker killed the container for another reason, such as running out of memory.

Artifacts are stored by content in `<home>/blobs/<sha256>`, so the same bytes always get the same id. Identity is per content, and each production has its own record: the first store of some bytes is their canonical record, and each Run that produces the same bytes again appends its own `ArtifactStored` record with its Lineage, so a copy Run's output is the input's id with a second record whose Lineage lists the input.

```sh
H=/tmp/aliquot   # an absolute path, because pnpm -C conductor runs from conductor/
pnpm -C conductor cli --home $H sandbox build      # prints the image id and tag aliquot-sandbox:<short sha>
pnpm -C conductor cli --home $H sandbox register --name copy --owner A-odile --input-types Other --output-types Other
pnpm -C conductor cli --home $H sandbox store receiving_log.csv --type Other   # prints the Artifact id
pnpm -C conductor cli --home $H sandbox run copy --input <artifact id> --timeout 60000   # prints the Run as JSON
pnpm -C conductor cli --home $H sandbox runs
pnpm -C conductor cli --home $H sandbox artifacts    # each Artifact with its type and one line per production: producer and Lineage
pnpm -C conductor cli --home $H sandbox cat <artifact id>
```

`register` records `ScriptRegistered` for a new name and `ScriptRevised` with the next version for a known one. It copies `sandbox/scripts/<name>/` (or `--script-dir`) to `<home>/scripts/S-<name>/<version>/`, so a version never changes, and records the image `Id` as `image_digest`; a local build has no registry digest. A Run uses the image its Script version names.

### Script convention

A Script is a directory with `main.py` (or `--entrypoint`). The container runs `python /script/main.py --inputs /inputs --outputs /outputs`.

- `/inputs/manifest.json` lists the inputs: `[{"artifact_id", "filename", "artifact_type", "media_type"}]`. Each input is at `/inputs/<artifact_id>/<filename>`.
- The Script writes its output files into `/outputs/`. Each regular file becomes an Artifact produced by the Run, with Lineage listing the inputs. Symlinks are ignored.
- An optional `/outputs/manifest.json` types the outputs: `{"<filename>": {"artifact_type": "...", "media_type": "..."}}`. Without it, an output is typed `Other` with a media type guessed from its extension. The manifest itself is not stored.
- stdout and stderr are stored as `Other` Artifacts (`text/plain`). The Run records the exit code.
- A Script cannot import `synth` or anything else from the repository: only its own directory is mounted.

## Vitality and Merit

Vitality, Mood, Policy, Merit, and the Trust tier are Projections over the Ledger (ADR-0004, ADR-0007), with the thresholds of `docs/design/vitality-and-merit.md`. The code is in `conductor/src/vitality/`.

- Vitality is computed from Events: `load` from open Tasks against `capacity`, `friction` and `confidence` from the Agent's last 10 Tasks, and `morale` from the slope of Review means over the last 7 days. No Event records token use yet, so `fatigue` comes from `--tokens`, and is 0 without it. From slice 1 the Conductor supplies it from each Turn's `modelUsage`.
- Mood follows the first matching rule of the Mood table, and Policy follows from Mood. A resting Agent is unschedulable.
- Merit is the mean of every dimension score over the Agent's last 20 reviewed Tasks. Tasks skipped for Review do not count.
- The Trust tier starts at `Probation` and rises when Merit and tenure meet a tier's bar with no boundary score below 2 in the window. A boundary score of 0 demotes one tier at once, and the Agent cannot regain that tier until the 0 leaves its window. `Mentor` also needs an approved `PromoteToMentor` Gate whose payload has the Agent as its `agent_id`. Each Promotion to `Mentor` uses one such Gate, so a return after a Demotion needs a new one; the Ledger refuses a Revision to `Mentor` without an unused approved Gate.

Show every live Agent, or one:

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality show
pnpm -C conductor cli --home /tmp/aliquot vitality show A-rin
```

Record a Review of a completed Task. Each score is 0 to 3. The reviewer is the Operator, or the Agent named with `--as`. The Ledger refuses a Review of a Task that is not `UnderReview` or `Done`, and a Review by the Task's own assignee. In the same command, after the Review, it appends any Revision that brings a `trust_tier` in line with the projected tier, caused by the Review, and prints it. So a boundary score of 0 on a `Trusted` Agent records the Review and the Demotion together.

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality review T-1 --quality 3 --traceability 3 \
  --boundary 3 --collaboration 2 --timeliness 3 --note "IDs agree across Artifacts"
```

List the Revisions that bring each Agent definition's `trust_tier` in line with its projected tier, then append them with `--apply`. `vitality review` and the stage 1 tracer already do this after each Review, so `--apply` only catches up a Ledger written without them, or a tier that changed through a `PromoteToMentor` Gate. When every tier is already in line, the command appends nothing.

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality tiers
pnpm -C conductor cli --home /tmp/aliquot vitality tiers --apply
```

Order Rest or end it, and append a `VitalitySampled` computed from the Ledger. `--budget` is the Energy budget in tokens per 5-hour window (default 1,000,000).

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality rest A-rin --begin --reason "fatigue 0.92" --as A-mabel
pnpm -C conductor cli --home /tmp/aliquot vitality rest A-rin --end --reason "fatigue 0.41" --as A-mabel
pnpm -C conductor cli --home /tmp/aliquot vitality sample A-rin --tokens 120000 --budget 1000000
```

## Stage 1 tracer

Stage 1 of the toy workflow turns a Submission Form into a structured submission record. One command runs the whole chain on a Fixture:

```sh
pnpm -C conductor cli --home /tmp/aliquot stage1 run fixtures/submission-form-seed1.docx
pnpm -C conductor cli --home /tmp/aliquot stage1 run-all fixtures   # every *.docx; exits 1 if any Task fails
```

The command does these steps in one process:

1. It builds the Sandbox image if Docker does not have `aliquot-sandbox:<short sha>`.
2. It recruits the starting roster if the Org is empty.
3. It registers `sandbox/scripts/parse_submission` as `S-parse_submission`. A later run reuses that version, unless the image or the Script's code changed; then it records `ScriptRevised`.
4. It stores the form as a `SubmissionForm` Artifact produced by the Operator, with no Lineage.
5. It proposes a Task (`Parse Submission Form <file>`, TAT `Regular`, priority 1, the Fixture as input), assigns it to the owner, and starts it as the owner.
6. It runs `parse_submission` in the Sandbox and evaluates the `submission.json` it writes: every required field must be filled and the TAT code must be `1`, `2`, or `3` (`conductor/src/stage1/evaluate.ts`).
7. It records `EvaluationRecorded`. When the Evaluation failed, it records `TaskFailed` with the findings.
8. When the Evaluation passed and the owner's Trust tier samples the Task for Review, it records `TaskCompleted` with Review required from the owner's Supervisor (`A-pia` for a Specialist) and the record as output. Then, as the Supervisor, it records `ReviewRecorded` with 3 on every dimension, because the Evaluation passed, and `TaskCompleted` with `review: Reviewed`. After the Review it appends any Trust tier Revision the Review earned, caused by the Review, and prints it as `revised`. When the tier does not sample the Task, it records `TaskCompleted` with Review skipped, giving the reason `not sampled for Review at tier <tier>`.

The command prints the Task, Run, output Artifact, and score, and exits 0 when the Task is `Done` and 1 when it is `Failed`. Options:

- `--owner A-rin` sets the Agent that owns the Script and works the Task. `A-rin` is the default.
- `--timeout <ms>` sets the Run's time limit. The default is 60000.
- `--script-dir <dir>` runs another copy of the Script. The tests use it to prove that a record without a Lot fails.

After one run on a fresh home, `ledger verify` passes and the Ledger holds this chain; `A-rin` is on `Probation`, so the Task goes through Review. Each Event from `TaskProposed` on names the Event before it as its `causation_id`, and the Run's `ArtifactStored` Events name `RunStarted`.

| seq | kind | task | causation |
|---|---|---|---|
| 1–8 | AgentRecruited | | |
| 9 | ScriptRegistered | | |
| 10 | ArtifactStored (the Fixture, Lineage none) | | |
| 11 | TaskProposed | T-1 | 10 |
| 12 | TaskAssigned | T-1 | 11 |
| 13 | TaskStarted | T-1 | 12 |
| 14 | RunStarted | T-1 | 13 |
| 15–17 | ArtifactStored (`submission.json`, stdout, stderr; Lineage the Fixture) | T-1 | 14 |
| 18 | RunFinished | T-1 | 14 |
| 19 | EvaluationRecorded (score 1, passed) | T-1 | 18 |
| 20 | TaskCompleted (Review required from A-pia), as A-rin | T-1 | 19 |
| 21 | ReviewRecorded (3 on every dimension), as A-pia | T-1 | 20 |
| 22 | TaskCompleted (Reviewed), as A-pia | T-1 | 21 |

`task list` shows T-1 as `Done`. `sandbox artifacts` shows the Fixture with no Lineage and the record with a Lineage of the Fixture. CI runs `stage1 run-all` on `fixtures/` after the conductor tests, so the job fails when any Evaluation fails. To add a Fixture, see [fixtures/README.md](fixtures/README.md).
