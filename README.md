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

The Conductor will keep its Ledger and blobs in `ALIQUOT_HOME`, which defaults to `./.aliquot/`. Git ignores that directory.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. The `conductor` job runs lint, typecheck, and test. The `sandbox` job runs ruff check, ruff format check, pytest, and the synthetic generator.
