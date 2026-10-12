#!/usr/bin/env bash
# Land ticket-<N> on the slice branch: merge, check, push, close the issue.
# See docs/agents/workflow.md.
set -euo pipefail

n="${1:?usage: tools/land-ticket.sh <issue number> [slice branch]}"
base="${2:-$(git branch --show-current)}"

cd "$(git rev-parse --show-toplevel)"

case "$base" in
	slice-*) ;;
	*) echo "land-ticket: $base is not a slice branch; check one out or name it" >&2; exit 1 ;;
esac
if [ "$(git branch --show-current)" != "$base" ]; then
	echo "land-ticket: check out $base first" >&2
	exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
	echo "land-ticket: the working tree is not clean" >&2
	exit 1
fi

title="$(gh issue view "$n" --json title --jq .title)"
before="$(git rev-parse HEAD)"

git merge --no-ff "ticket-$n" -m "Merge ticket-$n: $title (#$n)"

check() {
	pnpm -C conductor install --frozen-lockfile
	pnpm -C conductor lint
	pnpm -C conductor typecheck
	pnpm -C conductor test
	uv run --directory sandbox ruff check .
	uv run --directory sandbox ruff format --check .
	uv run --directory sandbox pytest
}
if ! check; then
	git reset --hard "$before"
	echo "land-ticket: a check failed; $base is back at $before" >&2
	exit 1
fi

git push origin "$base"
gh issue close "$n" --comment "Landed on $base in $(git rev-parse --short HEAD)."
