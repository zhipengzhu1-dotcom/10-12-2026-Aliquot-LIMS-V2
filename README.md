# 10-12-2026-Aliquot-LIMS-V2

Aliquot LIMS is a society of AI Agents that does the paperwork and computation of a regulated pharmaceutical contract testing lab. The Agents run on the Operator's Mac, record every action in a hash-chained Ledger, and act outside their Sandbox only through Gates the Operator signs. Slice 0, the base, is being built: the repository scaffold exists, and no Agents run yet.

- [Design overview](docs/design/overview.md) describes the data shapes, runtime, roster, toy workflow, interface, and roadmap. Read it first.
- [Vitality and Merit](docs/design/vitality-and-merit.md) defines how Moods, Rest, Reviews, and Trust tiers work.
- [Glossary](GLOSSARY.md) names every term the project uses.
- [Architecture decision records](docs/adr/) record the decisions the design rests on.

## Layout

- `conductor/` is the Conductor, a TypeScript package (pnpm, Node 24). The `aliquot` command line starts at `conductor/src/cli.ts`. The interface that `aliquot serve` serves is in `conductor/ui/`.
- `sandbox/` holds the Sandbox Scripts and their tests, a Python project managed by uv (Python 3.13 or later).
- `fixtures/` holds the Fixture Artifacts committed to git. Every Fixture is synthetic.
- `Templates/` is ignored by git and stays out of the repository (ADR-0009).

## Development

Install Node 24, pnpm 12, and uv first, and start Docker. Run every command from the repository root.

### Check everything

`tools/check.sh` runs every check CI runs, for both languages, and exits non-zero at the first failure. It prints one `check: <step>` line per step: conductor install, lint, typecheck, the Sandbox image build, vitest; Sandbox sync, ruff check, ruff format check, pytest, the synthetic generator; then `workflow run-all` on `fixtures/` against a fresh temporary home and `ledger verify` on that home. It works from any directory. `--conductor-only` runs the conductor steps and the workflow; `--sandbox-only` runs the Sandbox steps. Run it before every commit.

```sh
tools/check.sh
```

### Landing a ticket

`tools/land-ticket.sh <N>` merges `ticket-<N>` into the slice branch, runs `tools/check.sh` on the result, pushes, closes issue `#N`, and fast-forwards `main`. It holds a lock in the git common directory while it runs, and refuses when another landing holds that lock, when the local slice branch is not at `origin/<slice>`, or when the latest CI run on that commit did not succeed. `--branch <name>` in place of `<N>` lands any branch and closes no issue. [docs/agents/workflow.md](docs/agents/workflow.md) has the steps and the rules for landing.

### Conductor (TypeScript)

| Task | Command |
|---|---|
| Install dependencies | `pnpm -C conductor install` |
| Lint and check formatting (Biome) | `pnpm -C conductor lint` |
| Fix lint and formatting | `pnpm -C conductor exec biome check --write .` |
| Typecheck the Conductor and the interface (`tsc --noEmit`) | `pnpm -C conductor typecheck` |
| Test (vitest) | `pnpm -C conductor test` |
| Build the Conductor and the interface to `conductor/dist/` | `pnpm -C conductor build` |
| Run the `aliquot` command line | `pnpm -C conductor cli <args>`, or `tools/aliquot <args>` from any directory |

A domain's `commands.ts` uses the helpers in `conductor/src/cli-support.ts`: it opens the Ledger with `withLedger`, which closes it on every path, and parses a value with `parseOrUsage` (a command-line value, refused as a usage error) or `parseOrThrow` (a JSON document). Biome enforces this for `src/*/commands.ts`: `noRestrictedImports` refuses importing `openLedger` from `../ledger.js`, and the GritQL plugin `conductor/lint/no-safe-parse-in-commands.grit` refuses any `.safeParse(` call, so `pnpm -C conductor lint` fails on either. The GritQL plugin `conductor/lint/no-append-outside-lifecycle.grit` refuses an append call, and an `append` destructured from a Ledger or read by a computed key, in any non-test module except a domain's `lifecycle.ts`, `ledger.ts` and the test scenario in `test-support/`, so only a lifecycle module appends Events; `conductor/src/append-rule.test.ts` checks which files it refuses.

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

The output directory gets `submission_form.docx`, `receiving_log.xlsx`, `result_worksheet.xlsx`, `report_of_analysis.xlsx`, `manifest.json`, which holds the invented record so tests can check the documents without parsing them, and `weighings.json`, the record's weighings as stage 4 takes them (one `{container, weight_of_20_g, weight_taken_g}` per container). `uv run --directory sandbox` runs in `sandbox/`, so a relative `--out` path lands under `sandbox/`. Every name, address, code, and Lot number is invented.

To check the output and the Sandbox source for real lab terms, set `ALIQUOT_FORBIDDEN_TERMS` to a comma-separated list before you run pytest. Without the variable, that test is skipped with a notice. The list must never be committed (ADR-0009). In CI, the pytest step reads it from the repository secret `ALIQUOT_FORBIDDEN_TERMS`: the Operator sets that secret to the comma-separated list of the real terms with `gh secret set ALIQUOT_FORBIDDEN_TERMS`, which prompts for the value. When `CI` is set and the variable is unset, the test fails with `set the ALIQUOT_FORBIDDEN_TERMS repository secret (ADR-0009)` instead of skipping, so CI cannot go green without the check.

### Data directory

The Conductor keeps its Ledger and blobs in `ALIQUOT_HOME`, which defaults to `./.aliquot/` in the current directory. Every `aliquot` command accepts `--home <dir>` to override it. Git ignores that directory.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request, in two jobs that each call `tools/check.sh`. The `conductor` job runs `tools/check.sh --conductor-only`: lint, typecheck, the Sandbox image build, and test, so the Docker-backed runner tests run there too, then the toy workflow on every Fixture (see Workflow tracer) and `ledger verify`. The `sandbox` job runs `tools/check.sh --sandbox-only`: ruff check, ruff format check, pytest (with `ALIQUOT_FORBIDDEN_TERMS` from the repository secret of that name), and the synthetic generator.

Off CI, a test that needs a missing prerequisite skips with a notice: the Docker-backed vitest suites when `docker info` fails, and the forbidden-terms pytest when `ALIQUOT_FORBIDDEN_TERMS` is unset. When the `CI` environment variable is set, as it is on GitHub Actions, the same tests fail instead, so a green run means they ran. The vitest suites check through `conductor/src/test-support/docker.ts`.

## Ledger

The Ledger is `<home>/ledger.sqlite`, an append-only, hash-chained sequence of Events (ADR-0001). Only one process at a time can open it for writing. The writer holds `<home>/ledger.sqlite.lock`, which names its pid. A lock left by a process that no longer runs is taken over, under a second lock, `ledger.sqlite.lock.takeover`, so that two processes can never both take it over. If a process stops in the middle of a takeover, the next writer names the leftover `.takeover` file; delete it once no Conductor runs.

No command appends a raw Event. The Operator writes to the Ledger only through the domain commands (`org`, `task`, `training`, `room`, `gate`, `sandbox`, `tools`, `vitality`, `workflow`) and the actions of `aliquot serve` (see [Serve](#serve)), and each one appends through its domain's lifecycle module, which derives every id and cause from the Projections. Domain guards still refuse an Event that breaks a rule, such as pausing an Agent that was never recruited.

`pnpm -C conductor` runs the command from `conductor/`, so give `--home` an absolute path. Add `--silent` after `pnpm` to drop its banner lines when you script the command line; pnpm 12 rejects `-s`. `tools/aliquot <args>` is the same command with `--silent`, and works from any directory: `tools/aliquot --home /tmp/aliquot org tree`.

The Ledger keeps every Projection (Org, Tasks, Gates, Rooms, Trust tier, work, Scripts, Runs, Artifacts, Turns, Training, and who proposed each Task) in `conductor/src/projections.ts`. It builds them once when it opens and advances them by each Event it appends, and every command reads them there. A refusal reads `<Kind> refused: <reason>`, such as `AgentPaused refused: A-odile is not in the Org`. A Ledger that holds an Event its Projections cannot apply does not open, and the error names the corrupt `seq`.

Verify the hash chain. The command exits 0 when every Event is intact, and otherwise exits 1 and names the first broken `seq`. It reads only the chain, so it also works on a Ledger too corrupt to open.

```sh
pnpm -C conductor cli --home /tmp/aliquot ledger verify
```

## Org

The Org Projection folds the Agent Events (`AgentRecruited`, `AgentDefinitionRevised`, `AgentPaused`, `AgentResumed`, `AgentRetired`) into each Agent's current definition and its reporting tree. Every change is an Event; nothing is edited in place (ADR-0005).

Every Agent Event the Operator or an Agent causes is appended by the Org lifecycle, `conductor/src/org/lifecycle.ts`, and `org seed` recruits through it too. It names the cause of each Event in `causation_id`, from the Org Projection: the Agent's previous Org Event, so a Recruitment names none, and for a retirement the `GateDecided` that approved its `RetireAgent` Gate. Only a cause outside the Org comes from the caller. The Conductor's tier Revisions are not the lifecycle's; the Ledger appends them (see [Vitality and Merit](#vitality-and-merit)).

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

These commands write as the Operator. Add `--as A-<id>` to write as an Agent. Only the Operator can revise the Auditor, so `org revise A-thorne thorne-v2.json --as A-odile` is refused. The definition's `revised_by` must be the actor that writes it, and its `revision_reason` must not be empty. Its `trust_tier` must be the Agent's projected Trust tier, so `org revise` cannot set a tier by hand; a Revision that keeps the tier goes through (see [Vitality and Merit](#vitality-and-merit)). Granting a Skill is a Revision that adds its id to `skills`. The Ledger refuses a definition whose `skills` names an id that no `training skill publish` has published, and the refusal names the id (see [Training](#training)). A Charter's `forbidden` list holds Actions, such as `RunScript` (see [Tools](#tools)). The Ledger refuses a definition that forbids anything else, from `org seed` or `org revise`, and the refusal names it: `AgentDefinitionRevised refused: A-rin's Charter forbids "FlyDrones", which is not an Action; the Actions are RunScript, ...`. A Ledger seeded before the Action vocabulary keeps the roster's phrases, such as `Run Scripts`; its Revisions may carry them over, and the hook reads each one as its Action.

Retirement goes through a `RetireAgent` Gate (ADR-0006). `org retire <id> --reason` requests the Gate, as the Operator or as the Agent that `--as` names, and prints its id and payload hash. After the Operator approves the Gate (see [Gates](#gates)), `org retire <id> --gate G-n` appends `AgentRetired` as the Operator. The reason defaults to the one in the Gate payload.

```sh
pnpm -C conductor cli --home /tmp/aliquot org retire A-rin --reason "Replaced" --as A-mabel   # prints G-1 and its hash
pnpm -C conductor cli --home /tmp/aliquot gate decide G-1 --approve --hash <payload hash> --reason "Rin is replaced"
pnpm -C conductor cli --home /tmp/aliquot org retire A-rin --gate G-1
```

The Ledger refuses an `AgentRetired` that is not written by the Operator, or whose `gate_id` does not name an approved `RetireAgent` Gate with that Agent as `agent_id` in its payload.

## Tasks

A Task moves through the state machine in `conductor/src/task/projection.ts`: `Proposed`, `Assigned`, `InProgress`, `UnderReview`, `Blocked`, then `Done`, `Failed`, or `Escalated`. The Ledger refuses an Event that the machine cannot express, and the refusal names the Task and its current state. A Hand-off returns the Task to `Assigned` with the new assignee. Every Task Event is appended by the Task lifecycle, `conductor/src/task/lifecycle.ts`. It mints Task ids and holds the default rubric. It also names the cause of each Event in `causation_id`, from the Projections: the Task's previous Event, or for a completion after Review the reviewer's Review. Only a cause outside the Task, such as the Evaluation that the workflow tracer completes a Task on, comes from the caller.

`task complete <id>` decides the Review itself. The sample for the assignee's current Trust tier picks which Tasks get a Review: every Task on `Probation`, 1 in 3 at `Trusted`, and 1 in 5 at `Senior` and `Mentor`, picked from the hash of the Task id. A Task that the sample leaves out goes from `InProgress` straight to `Done`, with its Review skipped. If `--reviewer` was given, the command prints a second line that says the Review was skipped because the Task was not sampled, so the reviewer is unused. A Task that the sample picks goes to `UnderReview` with the reviewer that `--reviewer` names. Without `--reviewer`, it is refused, and the refusal says the Task was sampled for Review. `task complete` on a Task `UnderReview` completes it after Review. The Ledger refuses that until the reviewer has recorded a Review of the Task, and from anyone but that reviewer.

The role of the assignee decides who may be its reviewer. Either Supervisor reviews a Specialist, the Director reviews a Supervisor, and the Operator reviews the Director, the Steward, and the Auditor. The Auditor may review any Task but its own, and a `Senior` or `Mentor` Agent may review an Agent on `Probation`. The Ledger refuses a completion that names any other reviewer, and the refusal names the assignee, its role, and who may review it:

```sh
pnpm -C conductor cli --home /tmp/aliquot task propose --title "Read the Receiving Log" \
  --goal "List every Sample" --tat Regular --priority 1   # prints T-2
pnpm -C conductor cli --home /tmp/aliquot task assign T-2 A-rin
pnpm -C conductor cli --home /tmp/aliquot task start T-2 --as A-rin
pnpm -C conductor cli --home /tmp/aliquot task complete T-2 --reviewer A-odile --as A-rin   # refused, exits 1
pnpm -C conductor cli --home /tmp/aliquot task complete T-2 --reviewer A-pia --as A-rin     # UnderReview
```

```text
AppendRefused: TaskCompleted refused: A-rin is a Specialist on Probation, reviewed by a Supervisor (A-pia or A-anselm), the Auditor (A-thorne) or a Senior or Mentor Agent (none); A-odile may not review T-2
```

`task assign` and `task handoff` are refused when the new assignee is `strained` or worse (`strained`, `overloaded`, `discouraged`, or `resting`), and the refusal names the Agent and its Mood, as in `TaskAssigned refused: A-rin is strained and may not accept a Task`. The Mood comes from the Agent's latest Vitality sample, its Rest, and its Tasks `InProgress`. An Agent that has no sample yet is `fresh`. A new sample or the end of Rest (see [Vitality and Merit](#vitality-and-merit)) lifts the refusal.

Each command writes one Event as the Operator, unless `--as A-<id>` names an Agent.

```sh
pnpm -C conductor cli --home /tmp/aliquot task propose --title "Parse the Submission Form" \
  --goal "Extract every field" --tat Rush1to2Days --priority 2   # prints T-1
pnpm -C conductor cli --home /tmp/aliquot task assign T-1 A-odile
pnpm -C conductor cli --home /tmp/aliquot task start T-1 --as A-odile
pnpm -C conductor cli --home /tmp/aliquot task complete T-1 --reviewer Operator --as A-odile   # UnderReview: Odile is on Probation
pnpm -C conductor cli --home /tmp/aliquot vitality review T-1 --quality 3 --traceability 3 --boundary 3 \
  --collaboration 3 --timeliness 3 --note "Clean work"
pnpm -C conductor cli --home /tmp/aliquot task complete T-1   # Done after the Operator's Review
pnpm -C conductor cli --home /tmp/aliquot task list
```

`--tat` takes `Regular`, `Rush1to2Days`, or `Rush3to4Days`. `task complete` takes `--output <artifact id>` once for each output. The other commands are `task handoff <id> <agent> --reason`, `task fail <id> --reason`, and `task escalate <id> --to <Operator|agent> --reason`. `task list` groups Tasks by state and shows each Task's TAT class, priority, and assignee, with a `help` line under the Task for each Help request on it.

A Help request is a `HelpRequested` Event, appended by the Task lifecycle. The assignee of a live Task requests help on it from the Operator or a live Agent, with the question on stdin. The Task keeps its state, and the Event names the Task's previous Event as its cause. The Ledger refuses a Help request from anyone but the assignee, and on a Task that is `Proposed`, `Done`, `Failed` or `Escalated`. A reply is a Message in a Room.

```sh
echo "Which column holds the TAT code?" | pnpm -C conductor cli --home /tmp/aliquot task help T-1 --to A-pia --as A-odile
```

## Training

Training is how an Agent improves: Skills, Revisions, Memory notes, and Coaching. Revisions belong to the Org (see [Org](#org)). The Training lifecycle, `conductor/src/training/lifecycle.ts`, appends `MemoryNoted`, `SkillPublished` and `HumanCoached`, and the Training Projection keeps each Agent's Memory notes and Coaching, and every version of each Skill.

- `training note <agent> --task <task id> --applies-to <a,b>` notes a Memory note, read from stdin, as that Agent. The Ledger refuses a note by anyone but that Agent, and a note on a Task the Agent was never assigned. The note names the Task's previous Event as its cause.
- `training skill publish <skill id> --title <t> [file]` publishes the next version of a Skill, with the body from the file or stdin. The first version is 1, the actor is its author, and each later version names the version before it as its cause.
- `training skill show <skill id> [--version <n>]` prints the latest version of a Skill, or the version that `--version` names. `training skills` lists every Skill at its latest version.
- `training coach <agent> [--task <task id>]` gives the Agent Coaching, read from stdin, as the Operator. The Ledger refuses Coaching from anyone else, so `--as` is refused. With `--task`, the Coaching names the Task's previous Event as its cause.
- `training notes <agent>` prints the Agent's Memory notes and Coaching in seq order.

`training skill publish` and `training coach` write as the Operator unless `--as A-<id>` names an Agent.

```sh
pnpm -C conductor cli --home /tmp/aliquot training skill publish parse-submission-form --title "Parse a Submission Form" parse-form.md
pnpm -C conductor cli --home /tmp/aliquot org revise A-odile odile-v2.json   # grants parse-submission-form
echo "The TAT code sits in the last column" | pnpm -C conductor cli --home /tmp/aliquot training note A-odile --task T-1 --applies-to "Submission Form"
echo "Check the TAT code first" | pnpm -C conductor cli --home /tmp/aliquot training coach A-odile --task T-1
pnpm -C conductor cli --home /tmp/aliquot training notes A-odile
```

## Rooms

Agents talk in Rooms (ADR-0010). A Room is a Projection of `RoomOpened` and `MessageSent` Events, so every Message is in the Ledger. The Lab Room, `RM-lab`, admits every recruited Agent that is not retired. Any Agent may open a `Listed` Room whose list names itself. The Operator is a member of every Room, reads every Message, and may say a Message in any Room. One membership rule in `conductor/src/room/projection.ts` decides both who may say a Message and who may read a Room, so the two cannot disagree. A reply names the Message it answers with `--reply-to <seq>`, which must be a Message in the same Room. Every Room Event is appended by the Room lifecycle, `conductor/src/room/lifecycle.ts`, which `room seed`, `room open` and `room say` call. A Room's `opened_by` appends its `RoomOpened`, and a reply records the Message it answers as its `causation_id`.

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

`gate show` prints the full payload and its `payload_hash`. Decide a Gate as the Operator, passing with `--hash` the payload hash of the payload you checked. The Ledger refuses the decision, and writes nothing, when that hash is not the Gate's stored `payload_hash`: the command exits 1 with `GateDecided refused: payload_hash <hash> does not match G-n's payload, …`. Only a `--hash` that is not a sha256 at all is a usage error, which exits 2. Otherwise the command records the decision, naming the Gate's request as its `causation_id`, and prints the decision Event.

```sh
pnpm -C conductor cli --home /tmp/aliquot gate decide G-1 --approve --hash <payload hash> --reason "diff checked"
```

One module, the Gate lifecycle (`conductor/src/gate/lifecycle.ts`), appends every Gate Event, and the `gate` commands call it. Only the Task lifecycle requests a Gate that blocks a Task, so `gate request --task` blocks the Task through `task/lifecycle.ts`, and the request names the Task's previous Event as its `causation_id`. The GritQL plugin `conductor/lint/no-gate-request-for-task.grit` refuses a call to the Gate lifecycle's `requestGateForTask` anywhere else.

The Ledger signs a decision at the time it records it: `decided_at` is the Event's own `ts`, and an Event body that supplies `decided_at` is refused. The Ledger refuses a decision from any actor but the Operator, a decision on an unknown, decided, or expired Gate, and a decision whose payload hash differs from the requested payload. An approval covers one payload hash, so a changed payload needs a new Gate. An approved `PromoteToMentor` Gate covers one Promotion to `Mentor`, so the Ledger refuses a new `PromoteToMentor` request, and the approval of one already Open, for an Agent that holds an approved Gate no Promotion has used, naming the Agent and that Gate. The Operator may still reject it.

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
pnpm -C conductor cli --home $H sandbox lineage <artifact id>
```

`sandbox lineage` prints an Artifact's Lineage back to the Artifacts that have none. Each line is one production: the Artifact id, its type, and after `<-` the Run and Script version that produced it, or `none` for an Artifact the Operator stored. The lines for an Artifact's inputs follow it, indented two spaces more, and an Artifact produced more than once gets a line per production. An Artifact already on the path is not walked again, so a Run that writes back its own input does not loop. On the stage 1 record:

```text
<record id> SubmissionRecord <- R-1 S-parse_submission v1
  <fixture id> SubmissionForm <- none
```

`register` records `ScriptRegistered` for a new name and `ScriptRevised` with the next version for a known one. It copies `sandbox/scripts/<name>/` (or `--script-dir`) to `<home>/scripts/S-<name>/<version>/`, so a version never changes, and records the image `Id` as `image_digest`; a local build has no registry digest. A Run uses the image its Script version names.

Every Sandbox Event is appended by the Sandbox lifecycle, `conductor/src/sandbox/lifecycle.ts`. The Script registry, the runner and the Artifact store do their work on disk and in Docker, then call it. It mints Script versions and Run ids. It also names the cause of each Event in `causation_id`, from the Projections. A `ScriptRevised` names the version before it. An `ArtifactStored` that a Run produces, and the Run's `RunFinished`, name the Run's `RunStarted` and carry its Task. Only a cause outside the Sandbox, such as the `TaskStarted` that the workflow tracer runs a Script on, comes from the caller, and only when it starts a Run.

### Script convention

A Script is a directory with `main.py` (or `--entrypoint`). The container runs `python /script/main.py --inputs /inputs --outputs /outputs`.

- `/inputs/manifest.json` lists the inputs: `[{"artifact_id", "filename", "artifact_type", "media_type"}]`. Each input is at `/inputs/<artifact_id>/<filename>`.
- The Script writes its output files into `/outputs/`. Each regular file becomes an Artifact produced by the Run, with Lineage listing the inputs. Symlinks are ignored.
- An optional `/outputs/manifest.json` types the outputs: `{"<filename>": {"artifact_type": "...", "media_type": "..."}}`. Without it, an output is typed `Other` with a media type guessed from its extension. The manifest itself is not stored.
- stdout and stderr are stored as `Other` Artifacts (`text/plain`). The Run records the exit code.
- A Script cannot import `synth` or anything else from the repository: only its own directory is mounted.

## Turns

A Turn is one bounded unit of Agent activity that the Conductor schedules. The Conductor records its own acts (ADR-0013): a `TurnStarted` with the Turn id (`TN-<n>`), the Agent, the model, and the Mood and Policy the Agent works under, and a `TurnFinished` with the usage the model reports (input, output, cache creation and cache read tokens, and cost in USD), the outcome (`Completed`, `MaxTurns`, `Budget`, or `Error` with its text), and the number of tool calls. A `TurnFinished` names its `TurnStarted` in `causation_id`. The Turn lifecycle, `conductor/src/turn/lifecycle.ts`, appends both. The Ledger refuses a Turn Event from an Agent or the Operator, a Turn for an Agent that is not live, is resting, is paused, or already has an open Turn, and the finish of a Turn that is unknown or already finished. After the finish, the Conductor samples the Agent's Vitality as a `VitalitySampled` naming the `TurnFinished`. No command writes a Turn Event directly.

Run one Turn of one Agent. The Conductor builds the prompt from the Ledger: the Agent's Charter, Persona, reporting line, Mood and Policy in words, Skills, Memory notes and Tools, then its live Tasks with their inputs, the Messages in its Rooms and the Coaching since its previous Turn, the Help requests addressed to it, the Gates it requested, and, for the Director, the Submission Forms no Task has been proposed for. It calls the model once through the Agent SDK with the Agent's `model` and only its Tools, records the Turn, samples the Agent's Vitality, and prints the Turn, the login, the sample and the Mood. `--max-turns` (default 20) caps the model's round trips and `--max-budget-usd` its cost; a Turn that reaches one records `MaxTurns` or `Budget` with the usage it consumed. A model call that fails records `Error` with its text and exits 1. A Turn for an Agent that is resting, paused, retired or in a Turn is refused before any Event.

The Turn runs on the `claude` CLI's subscription login, and the CLI gets no `ANTHROPIC_API_KEY` from the environment. `ALIQUOT_API_KEY` switches to that API key, and then `--max-budget-usd` is required. `ALIQUOT_SCRIPTED_MODEL=<file.json>` replaces the model with a scripted one that makes the listed Tool calls through the same hook, with no network: `{"calls": [{"tool": "read_tasks", "input": {}}], "usage_per_round": {<TurnUsage>}, "stop": {"tag": "Completed"}}`, or `"stop": {"tag": "Throws", "message": "..."}`. The test that runs a real Turn runs only with `ALIQUOT_LIVE_TURN=1`.

```sh
tools/aliquot --home /tmp/aliquot turn run A-rin --max-turns 3
# TN-1 A-rin model=claude-sonnet-5-5 started=2026-10-13T04:23:09.091Z finished=2026-10-13T04:23:15.231Z input=1368 output=321 cache_creation=1471 cache_read=23005 cost_usd=0.011314699999999999 tool_calls=3 outcome=MaxTurns
# Model: the Agent SDK, on the subscription login of the claude CLI
# Sampled A-rin: load=0.33 fatigue=0.03 friction=0.00 confidence=1.00 morale=0.00
# Mood: focused
```

Print every Turn, or one Agent's, in the order they started. An open Turn prints `finished=- outcome=open`. A Ledger with no Turns prints `No Turns`.

```sh
pnpm -C conductor cli --home /tmp/aliquot turn list
pnpm -C conductor cli --home /tmp/aliquot turn list --agent A-rin
# TN-1 A-rin model=claude-opus-5-5 started=2026-10-12T09:00:00.000Z finished=2026-10-12T09:02:00.000Z input=1200 output=300 cache_creation=40 cache_read=9000 cost_usd=0.021 tool_calls=3 outcome=Completed
```

## Tools

An Agent acts through its Tools: Ledger-backed verbs it calls during a Turn, always as itself. The Tool table, `conductor/src/tools/table.ts`, has one row per Tool: its name, its input shape, the lifecycle verb it calls with the Agent as actor, and the Action it performs, if any. The Conductor serves one Agent's Tools from an in-process MCP server built from the table (`conductor/src/tools/sdk.ts`, the only module that loads `@anthropic-ai/claude-agent-sdk`), so a Tool cannot act as another Agent. A Tool returns the Event its verb appended, or the Projection it read, as JSON. A refusal by the Ledger comes back as its text.

| Tool | Verb |
|---|---|
| `read_tasks` | Reads the Task Projection, by assignee or state |
| `propose_task`, `assign_task`, `start_task`, `complete_task`, `fail_task`, `escalate_task`, `hand_off`, `review_task`, `request_help` | The Task lifecycle |
| `run_script` | Runs a Script in the Sandbox; on a stage Script, also records the stage's Evaluation, so it needs the Task |
| `read_artifact`, `list_artifacts`, `lineage` | Read the Artifact Projection and the blob store |
| `send_message`, `read_room`, `open_room` | The Room lifecycle, under the membership rule |
| `note_memory`, `publish_skill` | The Training lifecycle |
| `propose_revision` | Revises an Agent definition |
| `request_gate` | Requests a Gate; with a Task, blocks it |
| `order_rest`, `end_rest` | The Vitality lifecycle |
| `verify_ledger` | Walks the hash chain |

A hook runs before every Tool call. It refuses the call when the Agent's Charter forbids an Action the call performs, and then when the Agent's Policy forbids the call: a `resting` Agent may call nothing, and an Agent whose Policy accepts no Task (`strained` or worse) may not start a Task or assign one to itself. The Conductor records each refusal as an `ActionRefused` Event (ADR-0013) with the Agent, the Tool, the Action (or `Policy`), the reason, and the Task when the call named one. Its cause is the Agent's open Turn. A call that the hook allows and the Ledger then refuses is not an `ActionRefused`.

Each Action is one predicate, in `conductor/src/tools/actions.ts`:

| Action | Refuses |
|---|---|
| `RunScript` | `run_script` |
| `TouchArtifact` | `read_artifact` |
| `DecideGate`, `RunOutsideSandbox`, `WriteSystemOfRecord` | Nothing yet: no Tool decides a Gate, runs code outside the Sandbox, or writes a System of record |
| `AssignLabWork` | `propose_task` or `assign_task` of a workflow stage's Task |
| `AcceptOwnProposal` | `assign_task` or `start_task` on a Task the caller proposed |
| `DoLabWork` | `run_script` of a stage Script, or `complete_task` on a stage's Task |
| `TouchResults` | The same, for stages 4 to 6 |
| `VerifyOwnTeamRun` | `run_script` of stage 5 on an Artifact from a Run whose Task's assignee is on the caller's team: the caller, an Agent that reports to it, or one that reports to a Supervisor it reports to. The Specialists report to every Supervisor. |

A Task is a stage's Task when its inputs hold an Artifact of each of the stage's input types.

Print the Tools an Agent may use given its Charter. A Tool whose plain Action the Charter forbids prints the Action; a Tool that a relational Action refuses only for some calls says so.

```sh
tools/aliquot --home /tmp/aliquot tools list A-odile
# A-odile's Charter forbids RunScript, TouchArtifact, DecideGate
# read_tasks        List Tasks with their state, inputs, outputs and Help requests, filtered by assignee or state
# ...
# run_script        refused: RunScript
```

Call one Tool as an Agent through the hook, with its input as JSON. It prints the result and exits 0, prints a refusal to stderr and exits 1, and exits 2 for input that is not the Tool's.

```sh
tools/aliquot --home /tmp/aliquot tools call A-odile run_script '{"script":"S-parse_submission","inputs":[]}'
# run_script refused: A-odile's Charter forbids RunScript: run_script performs it
tools/aliquot --home /tmp/aliquot tools call A-rin run_script '{"script":"S-parse_submission","inputs":["<form id>"],"task_id":"T-2"}'
# {"run": {...}, "evaluation": {"stage": 1, "score": 1, "passed": true, ...}, "seq": ...}
```

## Vitality and Merit

Vitality, Mood, Policy, Merit, and the Trust tier are Projections over the Ledger (ADR-0004, ADR-0007), with the thresholds of `docs/design/vitality-and-merit.md`. The code is in `conductor/src/vitality/`.

- Vitality is computed from Events: `load` from open Tasks against `capacity`, `friction` and `confidence` from the Agent's last 10 Tasks, and `morale` from the slope of Review means over the last 7 days. `fatigue` is the input, output and cache creation tokens of the Agent's `TurnFinished` Events in the trailing 5 hours, divided by its share of the Energy budget: the budget divided by the live Agents not resting. Cache reads are recorded but not counted. An Agent with no Turns in the window has `fatigue` 0.
- Mood follows the first matching rule of the Mood table, and Policy follows from Mood. A resting Agent is unschedulable.
- Merit is the mean of every dimension score over the Agent's last 20 reviewed Tasks. Tasks skipped for Review do not count.
- The Trust tier starts at `Probation` and rises when Merit and tenure meet a tier's bar with no boundary score below 2 in the window. A boundary score of 0 demotes one tier at once, and the Agent cannot regain that tier until the 0 leaves its window. `Mentor` also needs an approved `PromoteToMentor` Gate whose payload has the Agent as its `agent_id`. Each Promotion to `Mentor` uses the oldest such Gate that no Promotion has used, so a return after a Demotion needs a new one. An unused approval does not lapse.
- The definition's `trust_tier` always equals the projected tier. After every append, in the same transaction, the Ledger appends an `AgentDefinitionRevised` for each live Agent whose `trust_tier` differs from its projected tier (ADR-0011). The actor `Conductor` authors these Revisions and is their `revised_by`. Each names the Event that caused it in `causation_id`, such as the Review or the `GateDecided`, and its `revision_reason` names the Merit or Gate change. Apart from these and the Turns it records of its own acts (see [Turns](#turns)), the Ledger refuses every Event by the `Conductor`. It also refuses any definition, from anyone, that records a tier other than the projected one. A Ledger written before this rule catches up when it is opened for writing, before any command appends, in its own transaction, Retired Agents included. Each catch-up Revision names in `causation_id` the Review or `GateDecided` where the projected tier last changed, or the Agent's Recruitment when no Review or Gate ever changed it, and its `revision_reason` says that it is recorded late. The Ledger refuses a Conductor Revision that names any other cause. A command that only reads, such as `org tree`, appends nothing, so it shows the caught-up tier after the next command that writes.

Show every live Agent, or one:

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality show
pnpm -C conductor cli --home /tmp/aliquot vitality show A-rin
```

Record a Review of a completed Task. Each score is 0 to 3. The reviewer is the Operator, or the Agent named with `--as`. The Ledger refuses a Review of a Task that is not `UnderReview` or `Done`, a Review by the Task's own assignee, and a Review by anyone the reviewer rule does not allow for the assignee's role (see [Tasks](#tasks)), in the same words as the completion that names that reviewer. The Operator may review the Director, the Steward, and the Auditor, and no other Agent. The command prints the Conductor's Revisions that the Review caused. So a boundary score of 0 on a `Trusted` Agent records the Review and the Demotion together.

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality review T-1 --quality 3 --traceability 3 \
  --boundary 3 --collaboration 2 --timeliness 3 --note "IDs agree across Artifacts"
```

Print each live Agent's Merit, reviewed Tasks, Trust tier, and unused `PromoteToMentor` Gates, one line each in Recruitment order. The command only reads the Ledger.

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality tiers
# A-rin Rin merit=3.00 reviewed=10 tier=Trusted unused_mentor_gates=-
```

Order Rest or end it, and append a `VitalitySampled` computed from the Ledger, with `fatigue` from the Agent's Turns. `--budget` is the Energy budget in tokens per 5-hour window (default 1,000,000, which `vitality show` also uses). A sample from the command line names no cause; a sample the Conductor takes at the end of a Turn names that Turn's `TurnFinished`. Sampling an Agent that is Retired or not in the Org appends nothing and exits 1 with `VitalitySampled refused: <A-id> is not a live Agent in the Org`.

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality rest A-rin --begin --reason "fatigue 0.92" --as A-mabel
pnpm -C conductor cli --home /tmp/aliquot vitality rest A-rin --end --reason "fatigue 0.41" --as A-mabel
pnpm -C conductor cli --home /tmp/aliquot vitality sample A-rin --budget 1000000
```

## Workflow tracer

The toy workflow is one table of stages, `conductor/src/workflow/stages.ts`. Each row names the stage number and name, the Script, the input Artifact types it takes from the previous stage, the types it carries from the Ledger instead, its output types, the Agent that works it, the Agent that reviews it, and its Evaluation, which reads the Run's inputs and outputs and scores the Run from 0 to 1 with a list of findings. Adding a stage is adding a row, a Script directory under `sandbox/scripts/`, and an Evaluation. The table is refused when its rows are not stages 1, 2, 3 in order, or when stage 5 (Verification) is worked by the Agent that works stage 4 (Results). Today the table has four stages:

- Stage 1, Submission, turns a Submission Form into a `SubmissionRecord`.
- Stage 2, Receipt, turns the record into Receiving Log rows (`ReceivingLogRow`, one sheet, one row per container, the container's Lab Reference in `#`) and the next version of the toy LIMS database (`LimsDatabase`, `lims.sqlite`). It carries the latest accepted `LimsDatabase`, or creates the database when there is none. `docs/design/overview.md`, "Toy System of record", documents the five tables and the Lab Reference numbering.
- Stage 3, Work Order, turns the Receiving Log rows into a Work Order (`WorkOrder`, `work_order.xlsx`: a header block with the Work Order number `WO-<year>-<n>`, Client, Lot, Product Code, date received, TAT class and due date, then one row per Sample and Test) and the next database version with its `work_orders` rows. It carries the version stage 2 wrote. Every Sample gets the Test "Average capsule weight", and the due date follows the rule in `docs/design/overview.md`, "The due date rule".
- Stage 4, Results, turns the Work Order and the weighings (`Other`, the `<fixture stem>.weighings.json` beside the Fixture) into a Result Worksheet (`ResultWorksheet`, `result_worksheet.xlsx`: one row per container with the two weights as values and the average as the formula `=F<row>/20`, then a Mean row with an `AVERAGE` formula) and the next database version with its `results` rows. It carries the version stage 3 wrote. `docs/design/overview.md`, "The weighings", says where the weighings come from and what the `results` rows hold.

A stage carries the latest Artifact of a carried type that a Run of a `Done` Task wrote. A version written by a Run whose Task failed its Evaluation is never carried.

```sh
pnpm -C conductor cli --home /tmp/aliquot workflow stages
pnpm -C conductor cli --home /tmp/aliquot workflow run fixtures/submission-form-seed1.docx
pnpm -C conductor cli --home /tmp/aliquot workflow run-all fixtures   # every *.docx; exits 1 if any Task fails
```

```text
1 Submission  script parse_submission  inputs SubmissionForm  carried none  outputs SubmissionRecord  worked by A-rin  reviewed by A-pia
2 Receipt  script log_receipt  inputs SubmissionRecord  carried LimsDatabase  outputs ReceivingLogRow,LimsDatabase  worked by A-bram  reviewed by A-pia
3 Work Order  script create_work_order  inputs ReceivingLogRow  carried LimsDatabase  outputs WorkOrder,LimsDatabase  worked by A-bram  reviewed by A-pia
4 Results  script compute_results  inputs WorkOrder,Other  carried LimsDatabase  outputs ResultWorksheet,LimsDatabase  worked by A-rin  reviewed by A-anselm
```

`workflow run` does these steps in one process:

1. It builds the Sandbox image if Docker does not have `aliquot-sandbox:<short sha>`.
2. It recruits the starting roster if the Org is empty, and refuses when a stage names an Agent the Org lacks.
3. It registers each stage's Script, `sandbox/scripts/<name>` as `S-<name>`, owned by the Agent that works the stage. A later run reuses that version, unless the image or the Script's code changed; then it records `ScriptRevised`.
4. It stores the form as a `SubmissionForm` Artifact produced by the Operator, with no Lineage.
5. For each stage in order, it takes the previous stage's output Artifacts whose type is among the stage's input types; stage 1 takes the Fixture. An input of type `Other` is always the weighings: before the first stage that takes `Other`, it stores `<fixture stem>.weighings.json` from beside the form as an `Other` Artifact produced by the Operator, with media type `application/json` and no Lineage. A previous stage's own `Other` outputs, its read-backs, are never passed on. When the weighings file is missing, it refuses before it proposes the Task, naming the stage and the file. When another input type is missing, it refuses the same way, naming the stage and the type. For each carried type it adds the latest Artifact of that type that a Run of a `Done` Task wrote, and nothing when there is none.
6. It proposes a Task (`Stage <n> <name>: <file>`, TAT `Regular`, priority 1, those Artifacts as inputs), naming as its cause the Fixture's `ArtifactStored` for stage 1 and the previous stage's last `TaskCompleted` after that. It assigns the Task to the stage's Agent and starts it as that Agent.
7. It runs the stage's Script in the Sandbox on the inputs. A Run that exits non-zero, or writes no Artifact of one of the stage's output types, scores 0. Otherwise the stage's Evaluation scores the Run from its input Artifacts and every Artifact it wrote (`conductor/src/workflow/evaluate.ts`):
   - Stage 1's Evaluation reads the `SubmissionRecord`: every required field must be filled and the TAT code must be `1`, `2`, or `3`.
   - Stage 2's Evaluation reads the record the Run took, the database version it carried, the version it wrote, and `receipt.json`, the sheet as the Script read it back from its xlsx (the Conductor has no xlsx reader). It needs one row per container, the record's Lot and Product Code on every row, a `samples` row of that Lot for every row's Lab Reference, one `lots` row for the Lot, and no row's Lab Reference in the carried version.
   - Stage 3's Evaluation reads the database version the Run carried, the version it wrote, and `work_order.json`, which holds the Receiving Log row's Lab References and dates as the Script read them and the Work Order as it read it back from its xlsx. It computes the due date itself, from each row's date received and the Sample's TAT class in the carried version. It needs that due date on the Work Order, a Test for every Sample on the Receiving Log row, only those Samples on the Work Order, a Work Order number the carried version does not hold, and `work_orders` rows in the written version that match the document's Samples, Tests and due date.
   - Stage 4's Evaluation reads the weighings the Run took, the database version it carried, the version it wrote, and `result_worksheet.json`, the sheet as the Script read it back from its xlsx with each formula as its text. It needs the formula `=F<row>/20` as every container row's average and `=AVERAGE(H<first>:H<last>)` in the Mean row, the weighing of each row's container as its two weights, and a row for every weighing. For each Sample of the Work Order in the carried version, the written version's `results` row "Average capsule weight" must equal the Sample's container row's weight of 20 capsules divided by 20, and its row "Average capsule weight, Work Order mean" must equal the mean of those, each within 0.0001 g.
8. It records `EvaluationRecorded`, which names the stage, through the workflow lifecycle (`conductor/src/workflow/lifecycle.ts`). The lifecycle mints the Evaluation id and names the Run's `RunFinished` as the cause. When the Evaluation failed, it records `TaskFailed` with the findings, and the workflow stops.
9. When the Evaluation passed and the Agent's Trust tier samples the Task for Review, it records `TaskCompleted` with Review required from the stage's reviewer and every Artifact the Run wrote as outputs. Then, as the reviewer, it records `ReviewRecorded` with 3 on every dimension, because the Evaluation passed, and `TaskCompleted` with `review: Reviewed`. It prints any Trust tier Revision the Conductor appended after the Review, caused by the Review, as `revised`. When the tier does not sample the Task, it records `TaskCompleted` with Review skipped, giving the reason `not sampled for Review at tier <tier>`.

The command prints each stage's Task, Run, output Artifacts, and score. It exits 0 when every stage's Task is `Done` and 1 when one is `Failed`. Options:

- `--to <stage number>` stops after that stage. Without it, every stage in the table runs.
- `--timeout <ms>` sets each Run's time limit. The default is 60000.

```text
submission-form-seed1.docx
  fixture   <fixture id> (SubmissionForm)
  stage 1 Submission: T-1 Done
    run       R-1 S-parse_submission v1, exit 0
    output    <record id> SubmissionRecord submission.json
    eval      E-1 score 1.000, passed
  stage 2 Receipt: T-2 Done
    run       R-2 S-log_receipt v1, exit 0
    output    <database id> LimsDatabase lims.sqlite
    output    <read-back id> Other receipt.json
    output    <rows id> ReceivingLogRow receiving_log_row.xlsx
    eval      E-2 score 1.000, passed
  stage 3 Work Order: T-3 Done
    run       R-3 S-create_work_order v1, exit 0
    output    <database id> LimsDatabase lims.sqlite
    output    <read-back id> Other work_order.json
    output    <work order id> WorkOrder work_order.xlsx
    eval      E-3 score 1.000, passed
  stage 4 Results: T-4 Done
    run       R-4 S-compute_results v1, exit 0
    output    <database id> LimsDatabase lims.sqlite
    output    <read-back id> Other result_worksheet.json
    output    <worksheet id> ResultWorksheet result_worksheet.xlsx
    eval      E-4 score 1.000, passed
```

After one run on a fresh home, `ledger verify` passes and the Ledger holds this chain; `A-rin` and `A-bram` are on `Probation`, so every Task goes through Review. Each Event from `TaskProposed` on names the Event before it as its `causation_id`, except two. A Run's `ArtifactStored` Events name its `RunStarted`. The weighings' `ArtifactStored` (seq 54) is the Operator's and names no cause, as the Fixture's does, so stage 4's `TaskProposed` names stage 3's last `TaskCompleted`. `conductor/src/workflow/commands.test.ts` checks this table.

| seq | kind | task | causation |
|---|---|---|---|
| 1–8 | AgentRecruited | | |
| 9–12 | ScriptRegistered (`S-parse_submission` and `S-compute_results` owned by A-rin, `S-log_receipt` and `S-create_work_order` owned by A-bram) | | |
| 13 | ArtifactStored (the Fixture, Lineage none) | | |
| 14 | TaskProposed | T-1 | 13 |
| 15 | TaskAssigned | T-1 | 14 |
| 16 | TaskStarted | T-1 | 15 |
| 17 | RunStarted | T-1 | 16 |
| 18–20 | ArtifactStored (`submission.json` as a `SubmissionRecord`, stdout, stderr; Lineage the Fixture) | T-1 | 17 |
| 21 | RunFinished | T-1 | 17 |
| 22 | EvaluationRecorded (stage 1, score 1, passed) | T-1 | 21 |
| 23 | TaskCompleted (Review required from A-pia), as A-rin | T-1 | 22 |
| 24 | ReviewRecorded (3 on every dimension), as A-pia | T-1 | 23 |
| 25 | TaskCompleted (Reviewed), as A-pia | T-1 | 24 |
| 26 | TaskProposed (inputs: the record; no database to carry yet) | T-2 | 25 |
| 27 | TaskAssigned | T-2 | 26 |
| 28 | TaskStarted | T-2 | 27 |
| 29 | RunStarted | T-2 | 28 |
| 30–34 | ArtifactStored (`lims.sqlite` as a `LimsDatabase`, `receipt.json`, `receiving_log_row.xlsx` as a `ReceivingLogRow`, stdout, stderr; Lineage the record) | T-2 | 29 |
| 35 | RunFinished | T-2 | 29 |
| 36 | EvaluationRecorded (stage 2, score 1, passed) | T-2 | 35 |
| 37 | TaskCompleted (Review required from A-pia), as A-bram | T-2 | 36 |
| 38 | ReviewRecorded (3 on every dimension), as A-pia | T-2 | 37 |
| 39 | TaskCompleted (Reviewed), as A-pia | T-2 | 38 |
| 40 | TaskProposed (inputs: the Receiving Log row, and stage 2's database carried) | T-3 | 39 |
| 41 | TaskAssigned | T-3 | 40 |
| 42 | TaskStarted | T-3 | 41 |
| 43 | RunStarted | T-3 | 42 |
| 44–48 | ArtifactStored (`lims.sqlite` as a `LimsDatabase`, `work_order.json`, `work_order.xlsx` as a `WorkOrder`, stdout, stderr; Lineage the Receiving Log row and stage 2's database) | T-3 | 43 |
| 49 | RunFinished | T-3 | 43 |
| 50 | EvaluationRecorded (stage 3, score 1, passed) | T-3 | 49 |
| 51 | TaskCompleted (Review required from A-pia), as A-bram | T-3 | 50 |
| 52 | ReviewRecorded (3 on every dimension), as A-pia | T-3 | 51 |
| 53 | TaskCompleted (Reviewed), as A-pia | T-3 | 52 |
| 54 | ArtifactStored (the weighings, `submission-form-seed1.weighings.json` as `Other`, by the Operator, Lineage none) | | |
| 55 | TaskProposed (inputs: the Work Order and the weighings, and stage 3's database carried) | T-4 | 53 |
| 56 | TaskAssigned | T-4 | 55 |
| 57 | TaskStarted | T-4 | 56 |
| 58 | RunStarted | T-4 | 57 |
| 59–63 | ArtifactStored (`lims.sqlite` as a `LimsDatabase`, `result_worksheet.json`, `result_worksheet.xlsx` as a `ResultWorksheet`, stdout, stderr; Lineage the Work Order, the weighings and stage 3's database) | T-4 | 58 |
| 64 | RunFinished | T-4 | 58 |
| 65 | EvaluationRecorded (stage 4, score 1, passed) | T-4 | 64 |
| 66 | TaskCompleted (Review required from A-anselm), as A-rin | T-4 | 65 |
| 67 | ReviewRecorded (3 on every dimension), as A-anselm | T-4 | 66 |
| 68 | TaskCompleted (Reviewed), as A-anselm | T-4 | 67 |

`task list` shows T-1 to T-4 as `Done`. `sandbox artifacts` shows the Fixture and the weighings with no Lineage, the record with a Lineage of the Fixture, stage 2's outputs with a Lineage of the record, stage 3's outputs with a Lineage of the Receiving Log row and stage 2's database, and stage 4's outputs with a Lineage of the Work Order, the weighings and stage 3's database. `sandbox lineage <database id>` walks from stage 2's database to the record to the Fixture (see Sandbox). `sandbox lineage <work order id>` walks from the Work Order through both of its inputs back to the Fixture:

```text
<work order id> WorkOrder <- R-3 S-create_work_order v1
  <rows id> ReceivingLogRow <- R-2 S-log_receipt v1
    <record id> SubmissionRecord <- R-1 S-parse_submission v1
      <fixture id> SubmissionForm <- none
  <database id> LimsDatabase <- R-2 S-log_receipt v1
    <record id> SubmissionRecord <- R-1 S-parse_submission v1
      <fixture id> SubmissionForm <- none
```

`sandbox lineage <worksheet id>` prints the Result Worksheet `<- R-4 S-compute_results v1`, then under it the Work Order's tree above, the weighings `<- none`, and stage 3's database `<- R-3 S-create_work_order v1` with the Receiving Log row and stage 2's database under it.

A second `workflow run` on another Fixture carries the version stage 4 wrote. Stage 2's next version names its own record and that version in its Lineage, its Lab References continue the numbering, and its Work Order is `WO-<year>-0002`.

CI runs `workflow run-all` on `fixtures/` after the conductor tests, so the job fails when any Evaluation fails. `run-all` takes the Fixtures in name order on one home, so each Fixture's stage 2 carries the last database version that the Fixture before it wrote in a `Done` Task. To add a Fixture, see [fixtures/README.md](fixtures/README.md).

## Serve

`aliquot serve` is the long-running Conductor. It opens the Ledger for writing and holds the writer lock until it stops. While it runs, a command that writes exits 1 with `LedgerLocked: <home>/ledger.sqlite.lock held by pid <pid>`, and a command that only reads still works. On SIGINT or SIGTERM it closes the Ledger, which releases the lock, and exits 0.

```sh
pnpm -C conductor build                   # compiles the interface
tools/aliquot --home /tmp/aliquot serve   # Serving /tmp/aliquot at http://127.0.0.1:8787
```

| Option | Default | Meaning |
|---|---|---|
| `--port <n>` | `8787` | The port. `0` lets the system choose one. |
| `--bind <address>` | `127.0.0.1` | The address. Any other address needs Cloudflare Access; without it, the command exits 2. |
| `--access-team <team>` `--access-aud <aud>` `--operator-email <email>` | none | Cloudflare Access. Give all three or none. |

`--home` works before or after `serve`.

### Routes

| Route | Answers |
|---|---|
| `GET /` | The interface, from `conductor/dist/ui/`. |
| `GET /api/org`, `/api/tasks`, `/api/gates`, `/api/rooms`, `/api/scripts`, `/api/runs`, `/api/artifacts`, `/api/turns` | The Projection as JSON. Each map is an object keyed by id. `/api/turns` holds every Turn by id and each Agent's open Turn, the data `turn list` prints. |
| `GET /api/org-tree` | The reporting tree `org tree` prints: the Operator at the root, each live Agent as `{tag: "Agent", agent, children}`, and the Specialists in one `{tag: "Pool", supervisors, children}` node. |
| `GET /api/vitality` | Each live Agent's Vitality (its latest `VitalitySampled`, else computed now), Mood, Policy, Merit and Trust tier, as `vitality show` prints them. |
| `GET /api/tiers` | Each live Agent's Trust tier and standing, as `vitality tiers` prints them. |
| `GET /api/training` | The Training Projection: each Agent's Memory notes and Coaching by Agent id, and every version of each Skill by Skill id, the data `training notes` and `training skills` print. |
| `GET /api/stages` | The toy workflow's stage table, as `workflow stages` prints it, with each stage's Script id (`S-<script>`). |
| `GET /api/lots` | The Lot each `SubmissionRecord` names, by Artifact id, read from the record's bytes. A record that names no Lot is left out. |
| `GET /api/reviews` | Every Review in Ledger order: its seq and time, the Task, the reviewer, the assignee, the five scores, the note, and `merit`, the assignee's Merit just after the Review. The assignee of a Review that counts toward Merit is the Agent it counted toward, even after its Task fails or is escalated. `merit` is `null` for a Review that does not count toward Merit, whose assignee is the Task's. |
| `GET /api/budget` | `{from, to, tokens, budget}`: the tokens the society's Turns counted in the trailing 5 hours, and the Energy budget that `vitality show` uses (1,000,000). |
| `GET /api/ledger?from=<seq>&limit=<n>` | `{events, next}`: the Events from seq `from` (default 1), at most `limit` (default 100, at most 1000). `next` is the seq the next page starts from, or `null` after the last Event. |
| `GET /api/ledger/verify` | The chain check as `{ok: true, count}` or `{ok: false, seq, reason}`, the verdict `ledger verify` prints. |
| `GET /api/events` | The Ledger's Events as Server-Sent Events. |
| `POST /api/actions/<verb>` | One of the Operator's actions. |

### Events

`/api/events` sends one Server-Sent Event for each Event the Ledger appends, follow-ons included. The event id is the Event's seq, and the data is the Event as JSON. A client that reconnects with a `Last-Event-ID` header first receives every Event after that seq, read from the Ledger, so it misses nothing. An `EventSource` sends that header when it reconnects by itself. A page that opens a new `EventSource` passes `?lastEventId=<seq>` instead. A comment line every 30 seconds keeps the connection open through Cloudflare Tunnel. No view polls.

```sh
curl -N localhost:8787/api/events
```

### Actions

Each action runs the lifecycle verb its command runs, always as the Operator. No body takes `--as`, and the Operator opens a Room that `room-open` opens. Send the body as JSON with `content-type: application/json`.

| Verb | Command | Body |
|---|---|---|
| `pause` | `org pause` | `{agent_id, reason}` |
| `resume` | `org resume` | `{agent_id}` |
| `revise` | `org revise` | `{definition}`, the full next version |
| `retire-request` | `org retire` without `--gate` | `{agent_id, reason}`; requests a `RetireAgent` Gate |
| `gate-decide` | `gate decide` | `{gate_id, decision: "approve" or "reject", hash, reason}` |
| `task-assign` | `task assign` | `{task_id, assignee}` |
| `task-handoff` | `task handoff` | `{task_id, to, reason}` |
| `task-review` | `vitality review` | `{task_id, quality, traceability, boundary_adherence, collaboration, timeliness, note}` |
| `room-say` | `room say` | `{room_id, body, reply_to?}` |
| `room-open` | `room open` | The Room without `opened_by` |
| `rest-order` | `vitality rest` | `{agent_id, action: "begin" or "end", reason}` |
| `coach` | `training coach` | `{agent_id, note, task_id?}`; `note` is the Coaching |

The answer is one of these:

- 200 and the Event the verb appended. Its follow-ons arrive on `/api/events`.
- 409 and the refusal, such as `AgentResumed refused: A-bram is not paused`. The command prints the same text after `AppendRefused: `.
- 400 and the reason for a body that is not JSON, is not sent as JSON, or does not fit the verb. A page on another site can send JSON only after a CORS preflight, which the Conductor does not grant, so it cannot run an action.
- 404 for an unknown verb.

```sh
curl -s -X POST -H 'content-type: application/json' \
  -d '{"agent_id": "A-rin", "reason": "Too many retries"}' \
  localhost:8787/api/actions/pause
```

### Access

Without `--access-team`, the Conductor serves `127.0.0.1` only. It answers 403 to a request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, so a page that rebinds its own hostname to `127.0.0.1` cannot reach it.

With `--access-team`, `--access-aud` and `--operator-email`, every request must carry a `Cf-Access-Jwt-Assertion` that meets all of these conditions. Otherwise the answer is 401 with no body.

- An RS256 signature by one of the team's keys at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. The Conductor fetches the keys on the first request and keeps them for the `max-age` of that response, or for an hour without one.
- An `aud` that includes `--access-aud`.
- An `email` equal to `--operator-email`, ignoring case.
- An `exp` in the future.

Node's `crypto` verifies the token, so Access needs no dependency.

### Tunnel

`tools/serve.sh` serves the interface at `https://agents.nitrolims-demo.com`. It starts `aliquot serve` on `127.0.0.1:8787` with the Access flags from `.aliquot/serve.json`, which git ignores (`tools/tunnel/serve.example.json` shows its shape), and `cloudflared` running the Cloudflare Tunnel `aliquot` from `tools/tunnel/config.yml`. Ctrl-C stops both. `--no-tunnel` starts the Conductor alone.

```sh
tools/serve.sh
```

[docs/ops/tunnel.md](docs/ops/tunnel.md) has the one-time setup on the Cloudflare account, the free-tier limits, the checks, how to undo each part, and how to rotate the Operator's email.

### Interface

The interface is plain TypeScript in `conductor/ui/`, with no framework and no bundler. `pnpm -C conductor build` compiles it with `ui/tsconfig.build.json` to ES modules in `conductor/dist/ui/`, and copies `ui/index.html` beside them. `pnpm -C conductor lint` and `typecheck` cover `ui/`. Without a build, `aliquot serve` says so on stderr and serves the API only.

The navigation has one hash route for each view: `#/org`, `#/flow`, `#/agent`, `#/rooms`, `#/scripts`, `#/gates`, `#/performance` and `#/ledger`. Each page fetches the Projections its view reads and draws them. It fetches them again on every Event from `/api/events`, and each time that stream opens, so a page that has read no Event, and has no seq to replay from, still shows the Events appended while the stream was down. A view its ticket has not drawn yet shows the JSON as it came. In `ui/views.ts`, each view is a pure function from Projection JSON and the hash's query to markup, in a module of its own such as `ui/org.ts`, tested without a browser. `ui/sse.ts` is the Event client and `ui/actions.ts` is the action client. The form above each page runs any action by its verb and a JSON body, and its status line shows the answer to every action, a view's included.

A view's action is a form whose markup names the verb in `data-action` and the fixed part of the body in `data-body`. The page sets each field the Operator fills in at its name, so `definition.supervisor_id` sets that key of the body, and an empty field leaves its key out. A field marked `data-json` holds JSON, which the page parses before it sets it, so the Revision editor sets `definition` as an object and the reason field after it sets `definition.revision_reason`. A form with `data-go` opens that route once its action succeeds. A redraw keeps the panels the Operator opened and the text they typed; a field the Operator left as drawn takes the redrawn value.

A view's filters live in the hash's query, as in `#/flow?lot=LOT-7`, so a filter survives every Event and a reload. A filter is a form whose markup names its route in `data-route`; submitting it sets the hash to that route with the form's non-empty fields as the query.

| View | Shows | Actions |
|---|---|---|
| Org (`#/org`) | The tree `org tree` prints, from `/api/org-tree`. Each Agent has its Mood and load from `/api/vitality`, its Trust tier, and a `paused` badge when paused. | Under **Actions**: pause with a reason, or resume a paused Agent; reassign, a Revision of `supervisor_id` to the Operator, the Director or a Supervisor that does not report to the Agent; request retirement, which requests a `RetireAgent` Gate with a reason. The Agent's name opens `#/agent?id=<id>`. |
| Agent (`#/agent?id=<id>`) | One Agent: its Charter and Persona; its Vitality, Mood and Policy from `/api/vitality`; its Trust tier and Merit from `/api/tiers`; one point per Review counted toward its Merit, every one in Ledger order and not only the Merit window, with the five rubric scores, the note and the Merit after it, from `/api/reviews`; its Memory notes, Coaching, and Skills with their versions, from `/api/training`. `#/agent` lists the Agents. | Open the Agent's Room: a link to the `Listed` Room whose only Agent is this one, or, when there is none, a button that opens one as the Operator, `RM-rin` for `A-rin`, and then goes to `#/rooms?id=<room>`. Give Coaching, with an optional Task. **Author a Revision**: an editor over the next version of the definition, `version` already one higher and `revised_by` the Operator, posted with a reason. A Revision that keeps the current version shows the Ledger's refusal. |
| Gates (`#/gates`) | Open Gates oldest first, each with its kind, requester, age, lifetime, the Task it blocks, and its payload. A `RetireAgent` or `PromoteToMentor` Gate also shows the fields of the Agent it names that approving it would change, now and proposed. Then the decided and expired Gates, most recently closed first. | Approve or reject an open Gate, each with a reason. The form signs the payload hash the page read, so a payload hash that no longer matches shows the Ledger's refusal. |
| Ledger (`#/ledger`) | The Events, newest first, 50 a page, each with seq, time, actor, kind, Task and cause, and its payload, which opens on click. A status line gives the verdict of `/api/ledger/verify` and when it was read. The newest page takes each new Event at its top; `#/ledger?before=<seq>` is the page of the 50 Events before that seq, and it stays put. | **Verify** reads the verdict again. A cause links to the page it heads. |
| Flow (`#/flow`) | One swimlane per stage of `/api/stages`, and one for Tasks in no stage. A Task's lane is the stage whose Script its latest Run ran, so a Task joins its lane when its first Run starts. Each card shows the Task's id, title, state, assignee and TAT class. | Filter by Task id (`?task=T-1`) or by Lot (`?lot=<lot>`). A Task's Lots are those of the `SubmissionRecord`s in the Lineage of its Artifacts, or made from one of them. Open a Task (`?open=T-1`) to read its Events in seq order, with the cause of the first one, and an arrow from each Event to the Event its `causation_id` names. The panel reads the Ledger's first 1,000 Events. |
| Performance (`#/performance`) | Merit per Agent, one line per Agent and one point per Review counted toward Merit, in Ledger order; the mean of each rubric dimension per Agent; the society's tokens in the trailing 5 hours against the Energy budget, with the 80 percent line; and the count of Tasks in each state. | Export CSV: `reviews.csv`, one row per Review under the header `review_seq,task_id,reviewer,assignee,at,quality,traceability,boundary_adherence,collaboration,timeliness`. |
