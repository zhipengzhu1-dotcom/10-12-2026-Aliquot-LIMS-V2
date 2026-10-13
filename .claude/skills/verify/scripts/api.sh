#!/usr/bin/env bash
# api.sh <run dir> get <route>                         GET /api/<route>
# api.sh <run dir> act <verb> '<json>' [--expect <code>] POST /api/actions/<verb>
# Prints the body, then `HTTP <code>` on stderr. Exits 0 only when the code
# is the expected one (200 unless --expect says otherwise).
. "$(dirname "$0")/lib.sh"
load_run "${1:-}"
shift

expect=200
case ${1:-} in
get)
	route=${2:?get takes a route, such as org or ledger/verify}
	shift 2
	args=("$URL/api/$route")
	;;
act)
	verb=${2:?act takes a verb, such as pause}
	body=${3:?act takes a JSON body}
	shift 3
	args=(-X POST -H 'content-type: application/json' --data "$body" "$URL/api/actions/$verb")
	;;
*) die "usage: api.sh <run dir> get <route> | act <verb> '<json>' [--expect <code>]" ;;
esac
[ "${1:-}" = --expect ] && expect=${2:?--expect takes an HTTP code}

body_file=$(mktemp)
code=$(curl -s -o "$body_file" -w '%{http_code}' "${args[@]}")
cat "$body_file"
rm -f "$body_file"
printf '\nHTTP %s\n' "$code" >&2
[ "$code" = "$expect" ]
