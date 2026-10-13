# Coding standards

Judgement calls the reviewer checks on a diff. Mechanical rules live in Biome, `tsc`, ruff and the test suite, so they are not repeated here.

- **One module per domain.** A Conductor domain is a folder under `conductor/src/` with `projection.ts`, `guards.ts` and `commands.ts`, plus `seed.ts` when it has a starting state, wired into `projections.ts`, `guards.ts` and `cli.ts` at the root. A new Event kind is a new line in `events.ts`; an existing line never changes.
- **The Ledger keeps the Projections.** Guards, follow-ons and commands read `ledger.projections`; no module outside the Ledger folds Events. A Projection that needs another reads it from the Projections it is handed, as they stood before the Event.
- **Guards return a reason, and the Ledger refuses.** A Projection is pure (no clock, no randomness, no I/O) and returns a `Refusal` for an Event it cannot apply, never skipping it. An `AppendGuard` returns the reason a rule refuses an Event, or undefined. The Ledger throws `AppendRefused` for either, and reports a stored Event a Projection refuses as `LedgerCorrupt`. One predicate decides a rule for both reading and writing, as `isMember` does in `room/projection.ts`.
- **Refusal text is `<Kind> refused: <reason>`**, naming the ids involved, so a CLI user and a test read the same sentence. A guard or a Projection writes only the reason; the Ledger adds the Event's kind.
- **Rule tests run on an in-memory Ledger.** Only a test of SQLite itself (persistence, the writer lock, the chain on disk), of the blob store, or of the command line opens a data directory.
- **Glossary vocabulary everywhere.** Identifiers, strings, tests and docs use the term `GLOSSARY.md` defines and avoid the words it lists under `_Avoid_`.
- **Comments only for a why the code cannot show.** A test's assertion message documents the step. Phase narration and restated signatures are deleted.
- **Tests assert the observable result**, the refusal message or the returned value, and each covers one acceptance criterion from the ticket. A test that would still pass with the rule removed is not a test.
- **Docs move with the code.** A change to a data shape, an Event kind or a CLI command updates `docs/design/overview.md` and the README section in the same commit.
