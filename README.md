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

### Data directory

The Conductor keeps its Ledger and blobs in `ALIQUOT_HOME`, which defaults to `./.aliquot/` in the current directory. Every `aliquot` command accepts `--home <dir>` to override it. Git ignores that directory.

## Ledger

The Ledger is `<home>/ledger.sqlite`, an append-only, hash-chained sequence of Events (ADR-0001). Only one process at a time can open it for writing.

Append one Event. The body is JSON with `actor`, `kind`, and `payload`, plus optional `task_id` and `causation_id`; give a file path, or pipe the body to stdin. The command prints the stored Event, or refuses an unknown `kind` or a malformed payload and writes nothing.

```sh
echo '{"actor":{"tag":"Operator"},"kind":"AgentPaused","payload":{"agent_id":"A-odile","reason":"maintenance"}}' \
  | pnpm -C conductor cli --home /tmp/aliquot ledger append
```

`pnpm -C conductor` runs the command from `conductor/`, so give `--home` an absolute path.

Verify the hash chain. The command exits 0 when every Event is intact, and otherwise exits 1 and names the first broken `seq`.

```sh
pnpm -C conductor cli --home /tmp/aliquot ledger verify
```

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. The `conductor` job runs lint, typecheck, and test. The `sandbox` job runs ruff check, ruff format check, and pytest.
