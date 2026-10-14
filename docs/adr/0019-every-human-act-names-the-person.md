---
status: accepted
---

# Every human act names the person

In a regulated lab a named person signs each accountable act. Until #74 the Ledger recorded every human act as the actor `Operator`, with no person. A Gate decision, the electronic signature record of ADR-0006, could not say who signed it. ADR-0017 makes this engine the automation behind the human LIMS, which keeps people and roles, and says that every human act the engine records names the person.

The Operator stays the actor kind and gains the person: `{tag: "Operator", email}`, the person's email in lower case. The email is the shape the seam to the human LIMS will use. That seam is not built here. Every person who acts as the Operator plays the one role. A rule that names the Operator, such as who reviews the Director or who decides a Gate, holds for each of them. A Task that waits on the Operator's Review takes the Review of any of them.

The command line takes the person from `--operator <email>`, given anywhere on the line, or else from `ALIQUOT_OPERATOR`. A command that acts as the Operator and has neither is refused before it opens the Ledger, in one line that names both. A command that acts `--as` an Agent, and a command that only reads, needs no person. `aliquot serve` behind Cloudflare Access admits each email that a repeated `--operator-email` lists, and each action names the person whom Access vouched for. Without Access it serves `127.0.0.1` only and acts for the person named at start, and it refuses to start without one. People still sign in through Cloudflare Access. The login mechanism is chosen last, before deployment.

An Event written before this decision has no email. Such an Event still opens, as ADR-0012 requires. It reads as `Operator (unnamed)` wherever an actor is shown: in the Ledger view, the Gates view, the Flow view, `gate show`, `room history` and the Chat view. No old Event is rewritten or superseded, and the hash chain keeps the bytes of the old Events.

## Considered Options

- A `Person` actor beside the Operator. Rejected because every rule that names the Operator would then need a second case, and old Events would have two kinds of human actor.
- Supersede each old Operator Event with one that names a person. Rejected because no one knows who each old act was. A guessed name in an audit trail is worse than an honest "unnamed".
- Refuse an Operator Event without an email in the Ledger itself, as a guard. Deferred, not chosen. Every Event by the Operator now enters through the command line or `aliquot serve`, which both require the person. A guard would also refuse the in-process tests that act as the role, and those tests would need a person on every call.

## Consequences

- A payload that only refers to the Operator, such as a reviewer to be (`--reviewer Operator`), an escalation `--to Operator` or a Room's membership, names no person. The person is named on the Event that acts.
- `revised_by` and `decided_by` name the person who acted. An Agent definition that a file or the roster gives as the Operator's names the person who records it.
- A stored Message keeps `"said_by":"Operator"`, so a Message's Artifact id is unchanged (ADR-0015). Who said it is on its `MessageSent`.
- `tools/check-readme.sh`, the README's examples, CI and the verify skill set `ALIQUOT_OPERATOR` once, so each example runs as written.
