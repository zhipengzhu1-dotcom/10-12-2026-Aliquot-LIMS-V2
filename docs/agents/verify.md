# The verify skill

`.claude/skills/verify/` is the project's skill for proving behaviour on the running app, invoked as `/verify`. It launches the Conductor on a fresh home, drives the interface that `aliquot serve` serves the way the Operator does, and writes a `proof.md` with the intent, the commands, a screenshot per browser step, the API bodies, the Ledger rows the drive appended, and a one-line verdict. Its feature map, `.claude/skills/verify/features/`, holds a drive for each interface feature.

## When the implementer of a ticket runs it

No proof, no merge. Before the final push of a ticket that changes behaviour the Operator sees, in the interface or the command line, the implementer runs `/verify` on that feature and quotes the `proof.md` path and its verdict line in the report:

```sh
.claude/skills/verify/scripts/prove.sh <feature> --intent '<the acceptance box, quoted>'
```

A ticket that changes a view also changes that feature's file in the map, and a ticket that adds a view adds a feature file and its drive. Any failure met while proving goes into the feature's `Gotchas` in the same branch.

`tools/check.sh` stays the gate for every commit; `/verify` proves the behaviour on the running app, which the check does not.
