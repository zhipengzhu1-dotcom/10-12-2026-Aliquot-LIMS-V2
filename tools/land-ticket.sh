#!/usr/bin/env bash
# Land ticket-<N> (or any branch given with --branch) on the slice branch:
# lock, fetch, check that the slice tip is the origin tip with green CI, merge,
# run tools/check.sh, push, close the issue, and fast-forward main.
# See docs/agents/workflow.md.
set -euo pipefail

usage="usage: tools/land-ticket.sh <issue number> | --branch <name>  [slice branch]"
if [ "${1:-}" = "--branch" ]; then
	branch="${2:?$usage}"
	n=""
	shift 2
else
	n="${1:?$usage}"
	branch="ticket-$n"
	shift
fi
base="${1:-$(git branch --show-current)}"

cd "$(git rev-parse --show-toplevel)"

refuse() {
	echo "land-ticket refused: $1" >&2
	exit 1
}

case "$base" in
	slice-*) ;;
	*) refuse "$base is not a slice branch; check one out or name it" ;;
esac
if [ "$(git branch --show-current)" != "$base" ]; then
	refuse "check out $base first"
fi
if [ -n "$(git status --porcelain)" ]; then
	refuse "the working tree is not clean"
fi

# One landing at a time across every worktree of this repository. mkdir is
# atomic, and macOS has no flock; a lock whose pid no longer runs is taken over.
lock="$(git rev-parse --path-format=absolute --git-common-dir)/land.lock"
if ! mkdir "$lock" 2>/dev/null; then
	holder="$(cat "$lock/pid" 2>/dev/null || true)"
	if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
		refuse "the landing lock $lock is held by pid $holder"
	fi
	rm -rf "$lock"
	mkdir "$lock" || refuse "the landing lock $lock is held"
fi
echo "$$" >"$lock/pid"
trap 'rm -rf "$lock"' EXIT

git fetch origin
head="$(git rev-parse HEAD)"
origin_tip="$(git rev-parse "origin/$base")"
if [ "$head" != "$origin_tip" ]; then
	refuse "local $base is at $head but origin/$base is at $origin_tip; bring $base level with origin first"
fi

conclusion="$(gh run list --branch "$base" --commit "$head" --limit 1 --json conclusion --jq '.[0].conclusion')"
if [ "$conclusion" != "success" ]; then
	refuse "the latest CI run on $base at $head concluded '${conclusion:-none}', not success"
fi

git worktree list

if [ -n "$n" ]; then
	title="$(gh issue view "$n" --json title --jq .title)"
	message="Merge $branch: $title (#$n)"
else
	message="Merge $branch into $base"
fi

git merge --no-ff "$branch" -m "$message"

if ! tools/check.sh; then
	git reset --hard "$head"
	refuse "a check failed; $base is back at $head"
fi

git push origin "$base"
if [ -n "$n" ]; then
	gh issue close "$n" --comment "Landed on $base in $(git rev-parse --short HEAD)."
fi

if git merge-base --is-ancestor origin/main "$base"; then
	git push origin "$base":main
else
	echo "land-ticket: main is not an ancestor of $base, so main stays where it is"
fi
