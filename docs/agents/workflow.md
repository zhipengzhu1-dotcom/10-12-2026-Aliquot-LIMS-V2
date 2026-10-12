# Ticket workflow

How a GitHub issue becomes code on the integration branch. There are no pull requests; a ticket lands by a merge commit.

## Branches

- `slice-0`, `slice-1`, and so on are the integration branches, one per slice of the roadmap in `docs/design/overview.md`. The current slice's branch is the base for every ticket and the one that `main` follows.
- `main` is fast-forwarded to the current slice branch at each slice boundary and after a landing when the slice is complete, so any tool that starts from `main` (a worktree, a checkout, a CI default) sees the real code.
- `ticket-<N>` is the branch for issue `#N`, cut from the current slice branch. A long-running ticket merges the slice branch into itself (`Merge slice-0 into ticket-N`) rather than rebasing, so `seq`-sensitive tests keep their history.
- `prototype/<name>` keeps a throwaway sketch out of the slice branch.

## Write the ticket

A ticket has three sections: **What to build**, **Acceptance criteria** as a checklist, and **Blocked by** naming issue numbers. It names behaviours and the data shape, in `GLOSSARY.md` vocabulary. It does not name functions; an implementer who finds a named function has no caller drops it. Label it `ready-for-agent` and `slice-<n>`.

## Land the ticket

Run `tools/land-ticket.sh <N>` from a clean checkout of the slice branch. It merges `ticket-<N>` with `--no-ff` as `Merge ticket-<N>: <issue title> (#<N>)`, runs `tools/check.sh` (every check CI runs, for both languages) on the merged result, pushes the slice branch, and closes the issue with a comment naming the merge commit. A failed check resets the merge and leaves the slice branch as it was.

Done means: the merge commit is on `origin/<slice>`, CI is green on it, and the issue is closed.
