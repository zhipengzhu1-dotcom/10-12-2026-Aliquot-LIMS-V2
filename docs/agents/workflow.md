# Ticket workflow

How a GitHub issue becomes code on the integration branch. There are no pull requests; a ticket lands by a merge commit.

## Branches

- `slice-0`, `slice-1`, and so on are the integration branches, one per slice of the roadmap in `docs/design/overview.md`. The current slice's branch is the base for every ticket and the one that `main` follows.
- `main` is fast-forwarded to the current slice branch by each landing, so any tool that starts from `main` (a worktree, a checkout, a CI default) sees the real code.
- `ticket-<N>` is the branch for issue `#N`, cut from the current slice branch. A long-running ticket merges the slice branch into itself (`Merge slice-0 into ticket-N`) rather than rebasing, so `seq`-sensitive tests keep their history.
- `prototype/<name>` keeps a throwaway sketch out of the slice branch.

## Write the ticket

A ticket has three sections: **What to build**, **Acceptance criteria** as a checklist, and **Blocked by** naming issue numbers. It names behaviours and the data shape, in `GLOSSARY.md` vocabulary. It does not name functions; an implementer who finds a named function has no caller drops it. Label it `ready-for-agent` and `slice-<n>`.

## Land the ticket

Two rules come first:

- **Land only from a worktree you created.** Another agent's worktree, or the main checkout, may hold work in progress that a landing would merge into or reset.
- **The main checkout stays on the slice branch.** Cut tickets in worktrees; never switch the main checkout to a ticket branch.

Run `tools/land-ticket.sh <N>` from a clean checkout of the slice branch. In order, it:

1. Takes the landing lock, `land.lock` in the git common directory, so only one landing runs across every worktree. It refuses, naming the lock and its pid, when another landing holds it. A lock left by a process that no longer runs is taken over.
2. Fetches `origin`, and refuses unless the local slice branch is at the same commit as `origin/<slice>`.
3. Refuses unless the latest CI run on that commit concluded `success`, naming the conclusion it found.
4. Prints `git worktree list`, so you see who else is working.
5. Merges `ticket-<N>` with `--no-ff` as `Merge ticket-<N>: <issue title> (#<N>)` and runs `tools/check.sh` (every check CI runs, for both languages) on the merged result. A failed check resets the merge and leaves the slice branch as it was.
6. Pushes the slice branch and closes the issue with a comment naming the merge commit.
7. Fast-forwards `main` on `origin` to the slice branch when `main` is an ancestor of it; otherwise it says so and leaves `main` alone.

`tools/land-ticket.sh --branch <name>` lands any branch the same way, as `Merge <name> into <slice>`, and closes no issue. Each refusal prints `land-ticket refused: <reason>` and exits 1.

Done means: the merge commit is on `origin/<slice>`, CI is green on it, and the issue is closed.
