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

`.github/workflows/ci.yml` runs on every push and pull request. The `conductor` job runs lint, typecheck, and test. The `sandbox` job runs ruff check, ruff format check, pytest, and the synthetic generator.

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
