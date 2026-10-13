#!/usr/bin/env bash
# Run every check CI runs, for both languages. Exits non-zero on the first failure.
# Usage: tools/check.sh [--conductor-only | --sandbox-only]
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

mode="${1:-all}"
case "$mode" in
	all | --conductor-only | --sandbox-only) ;;
	*) echo "usage: tools/check.sh [--conductor-only | --sandbox-only]" >&2; exit 2 ;;
esac

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

step() {
	local name="$1"
	shift
	echo "check: $name"
	if ! "$@"; then
		echo "check: FAILED: $name" >&2
		exit 1
	fi
}

conductor() {
	step "conductor install" pnpm -C conductor install --frozen-lockfile
	step "conductor lint" pnpm -C conductor lint
	step "conductor typecheck" pnpm -C conductor typecheck
	# The Docker suites build this image under tags of their own; building it first makes theirs a cache hit.
	step "sandbox image build" docker build -f sandbox/Dockerfile -t aliquot-sandbox:test sandbox
	step "conductor test" pnpm -C conductor test
}

sandbox() {
	step "sandbox sync" uv sync --directory sandbox --locked
	step "sandbox ruff check" uv run --directory sandbox ruff check .
	step "sandbox ruff format --check" uv run --directory sandbox ruff format --check .
	step "sandbox pytest" uv run --directory sandbox pytest
	step "synth --seed 42" uv run --directory sandbox synth --seed 42 --out "$scratch/synth-42"
}

# The toy workflow on every Fixture against a fresh home: fails when any Evaluation fails.
workflow() {
	local home="$scratch/home"
	step "workflow run-all fixtures" pnpm --silent -C conductor cli --home "$home" workflow run-all "$PWD/fixtures"
	step "ledger verify" pnpm --silent -C conductor cli --home "$home" ledger verify
}

case "$mode" in
	--conductor-only) conductor; workflow ;;
	--sandbox-only) sandbox ;;
	all) conductor; sandbox; workflow ;;
esac

echo "check: all passed"
