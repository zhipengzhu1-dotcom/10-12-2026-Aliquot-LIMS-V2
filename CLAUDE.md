## Agent skills

### Issue tracker

Issues live in GitHub Issues on `zhipengzhu1-dotcom/10-12-2026-Aliquot-LIMS-V2` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Ticket workflow

Branches `ticket-<N>` off the slice branch, landed by `tools/land-ticket.sh`. See `docs/agents/workflow.md`.

### Verify skill

`/verify` drives the running app and writes a proof before a ticket's final push. See `docs/agents/verify.md`.

### Coding standards

`CODING_STANDARDS.md` holds the judgement calls the reviewer checks.

### Commands

- `tools/check.sh` is the check: it runs everything CI runs, for both languages, and exits non-zero on any failure. Run it before every commit.
- `tools/aliquot <args>` runs the `aliquot` command line from any directory, as in `tools/aliquot --home /tmp/aliquot org tree`; give `--home` an absolute path. The Bash tool here runs zsh: quote command strings, and never use an unquoted `$VAR` as a command.
