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

Install Node 24, pnpm 12, and uv first. Run every command from the repository root.

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

To check the output and the Sandbox source for real lab terms, set `ALIQUOT_FORBIDDEN_TERMS` to a comma-separated list before you run pytest. Keep the list out of the repository. Without the variable, that test is skipped.

### Data directory

The Conductor keeps its Ledger and blobs in `ALIQUOT_HOME`, which defaults to `./.aliquot/` in the current directory. Every `aliquot` command accepts `--home <dir>` to override it. Git ignores that directory.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. The `conductor` job runs lint, typecheck, and test; it builds the Sandbox image first, so the Docker-backed runner tests run there too. The `sandbox` job runs ruff check, ruff format check, pytest, the synthetic generator, and `docker build` of the Sandbox image.

## Ledger

The Ledger is `<home>/ledger.sqlite`, an append-only, hash-chained sequence of Events (ADR-0001). Only one process at a time can open it for writing.

Append one Event. The body is JSON with `actor`, `kind`, and `payload`, plus optional `task_id` and `causation_id`; give a file path, or pipe the body to stdin. The command prints the stored Event, or refuses an unknown `kind` or a malformed payload and writes nothing. Domain guards also refuse Events that break a rule, such as pausing an Agent that was never recruited, so this example needs `org seed` first (see Org).

```sh
echo '{"actor":{"tag":"Operator"},"kind":"AgentPaused","payload":{"agent_id":"A-odile","reason":"maintenance"}}' \
  | pnpm -C conductor cli --home /tmp/aliquot ledger append
```

`pnpm -C conductor` runs the command from `conductor/`, so give `--home` an absolute path.

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

Print the tree: the Operator at the root, the Director, Steward and Auditor under it, the Supervisors under the Director, and the Specialist pool under both Supervisors. Retired Agents are left out.

```sh
pnpm -C conductor cli --home /tmp/aliquot org tree
```

Pause, resume, retire, or revise an Agent. `revise` takes a JSON file with the full next definition; its `version` must be the current version plus 1.

```sh
pnpm -C conductor cli --home /tmp/aliquot org pause A-rin --reason "Energy budget review"
pnpm -C conductor cli --home /tmp/aliquot org resume A-rin
pnpm -C conductor cli --home /tmp/aliquot org retire A-rin --reason "Replaced"
pnpm -C conductor cli --home /tmp/aliquot org revise A-thorne thorne-v2.json
```

These commands write as the Operator. Add `--as A-<id>` to write as an Agent. Only the Operator can revise the Auditor, so `org revise A-thorne thorne-v2.json --as A-odile` is refused.

## Tasks

A Task moves through the state machine in `conductor/src/task/projection.ts`: `Proposed`, `Assigned`, `InProgress`, `UnderReview`, `Blocked`, then `Done`, `Failed`, or `Escalated`. The Ledger refuses an Event that the machine cannot express, and the refusal names the Task and its current state. A Hand-off returns the Task to `Assigned` with the new assignee. A Task that the Trust tier rules skip for Review goes from `InProgress` straight to `Done`.

Each command writes one Event as the Operator, unless `--as A-<id>` names an Agent.

```sh
pnpm -C conductor cli --home /tmp/aliquot task propose --title "Parse the Submission Form" \
  --goal "Extract every field" --tat Rush1to2Days --priority 2   # prints T-1
pnpm -C conductor cli --home /tmp/aliquot task assign T-1 A-odile
pnpm -C conductor cli --home /tmp/aliquot task start T-1 --as A-odile
pnpm -C conductor cli --home /tmp/aliquot task complete T-1 --review-required --reviewer Operator --as A-odile
pnpm -C conductor cli --home /tmp/aliquot task complete T-1 --reviewed
pnpm -C conductor cli --home /tmp/aliquot task list
```

`--tat` takes `Regular`, `Rush1to2Days`, or `Rush3to4Days`. The other commands are `task handoff <id> <agent> --reason`, `task complete <id> --skip-review --reason`, `task fail <id> --reason`, and `task escalate <id> --to <Operator|agent> --reason`. `task list` groups Tasks by state and shows each Task's TAT class, priority, and assignee.

## Gates

A Gate is a request for an Operator decision on an action outside the Sandbox (ADR-0006). There are five kinds: `Deploy`, `WriteSystemOfRecord`, `ExternalMessage`, `RetireAgent`, and `PromoteToMentor`. The decision Event is the electronic signature record: it names the Operator, the time, the sha256 of the exact payload, and the meaning (approve or reject).

Request a Gate. The payload is a JSON file, or `-` for stdin. `--task` links the Gate to an `InProgress` Task, which shows as `Blocked` until the Operator decides the Gate; `--lifetime` is in seconds (default 86400), and `--as` names the requesting Agent (default: the Operator). The command prints the new Gate id and the payload hash.

```sh
pnpm -C conductor cli --home /tmp/aliquot gate request --kind Deploy --payload deploy.json --task T-3 --as A-bram
```

List the open Gates with their kind, requester, age, and a one-line payload summary. `--all` lists every Gate with its state. A Gate that nobody decides within its lifetime shows as `Expired`; no Event records the expiry.

```sh
pnpm -C conductor cli --home /tmp/aliquot gate list
pnpm -C conductor cli --home /tmp/aliquot gate show G-1
```

Decide a Gate as the Operator. The command hashes the payload stored in the Ledger and prints the decision Event.

```sh
pnpm -C conductor cli --home /tmp/aliquot gate decide G-1 --approve --reason "diff checked"
```

The Ledger refuses a decision from any actor but the Operator, a decision on an unknown, decided, or expired Gate, and a decision whose payload hash differs from the requested payload. An approval covers one payload hash, so a changed payload needs a new Gate.

## Sandbox

Every Script runs in a Docker container, never in the Conductor's process (ADR-0003). The image is `sandbox/Dockerfile`: `python:3.13-slim` with openpyxl, python-docx, pdfplumber, and reportlab from the hash-locked `sandbox/image-requirements.txt`, run as uid 10001. Each Run gets `--network none --cap-drop ALL --cpus 1 --memory 512m --pids-limit 256 --read-only --tmpfs /tmp`, the Script and its inputs mounted read-only, and a fresh output directory. A Run that outlives its time limit is stopped with `docker kill` and finishes with exit code 137.

Artifacts are stored by content in `<home>/blobs/<sha256>`, so the same bytes always get the same id. Identity is per content and provenance is per production: the first store of some bytes is their canonical record, and each Run that produces the same bytes again appends its own `ArtifactStored` record with its Lineage, so a copy Run's output is the input's id with a second record whose Lineage lists the input.

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
- The Trust tier starts at `Probation` and rises when Merit and tenure meet a tier's bar with no boundary score below 2 in the window. A boundary score of 0 demotes one tier at once, and the Agent cannot regain that tier until the 0 leaves its window. `Mentor` also needs an approved `PromoteToMentor` Gate whose payload has the Agent as its `agent_id`.

Show every live Agent, or one:

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality show
pnpm -C conductor cli --home /tmp/aliquot vitality show A-rin
```

Record a Review of a completed Task. Each score is 0 to 3. The reviewer is the Operator, or the Agent named with `--as`. The Ledger refuses a Review of a Task that is not `UnderReview` or `Done`, and a Review by the Task's own assignee.

```sh
pnpm -C conductor cli --home /tmp/aliquot vitality review T-1 --quality 3 --traceability 3 \
  --boundary 3 --collaboration 2 --timeliness 3 --note "IDs agree across Artifacts"
```

List the Revisions that bring each Agent definition's `trust_tier` in line with its projected tier, then append them with `--apply`. When every tier is already in line, the command appends nothing.

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
