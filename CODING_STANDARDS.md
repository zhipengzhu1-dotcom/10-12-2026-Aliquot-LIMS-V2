# Coding standards

Judgement calls the reviewer checks on a diff. Mechanical rules live in Biome, `tsc`, ruff and the test suite, so they are not repeated here.

- **One module per domain.** A Conductor domain is a folder under `conductor/src/` with `projection.ts`, `guards.ts` and `commands.ts`, plus `seed.ts` when it has a starting state, wired into `guards.ts` and `cli.ts` at the root. A new Event kind is a new line in `events.ts`; an existing line never changes.
- **Projections return, guards throw.** A Projection is pure (no clock, no randomness, no I/O) and answers a bad request with a refusal value such as `TransitionError` or `RoomRefused`. An `AppendGuard` turns that value into `AppendRefused`. One predicate decides a rule for both reading and writing, as `isMember` does in `room/projection.ts`.
- **Refusal text is `<Kind> refused: <reason>`**, naming the ids involved, so a CLI user and a test read the same sentence.
- **Glossary vocabulary everywhere.** Identifiers, strings, tests and docs use the term `GLOSSARY.md` defines and avoid the words it lists under `_Avoid_`.
- **Comments only for a why the code cannot show.** A test's assertion message documents the step. Phase narration and restated signatures are deleted.
- **Tests assert the observable result**, the refusal message or the returned value, and each covers one acceptance criterion from the ticket. A test that would still pass with the rule removed is not a test.
- **Docs move with the code.** A change to a data shape, an Event kind or a CLI command updates `docs/design/overview.md` and the README section in the same commit.
