#!/usr/bin/env bash
# Unit tests for classify() in .agents/skills/deploy-pi/scripts/containment-canary.sh
# (issue #154). Runs without a Pi, a board, or a claude session: classify() is a
# pure function over three curl output fields, so it is sourced directly.
#
# classify() is the whole verdict of the containment canary — ADR 0036's
# 「401 / 403 / 接続失敗 の3つに限定して列挙」. Every other part of the canary can
# fail loudly; this one fails *silently*, by scoring a hole as a pass, which is
# the specific failure the ADR calls out and the reason these cases exist.
#
# Run: bash scripts/containment-canary.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINMENT_CANARY_SOURCE_ONLY=1 source \
  "$SCRIPT_DIR/../.agents/skills/deploy-pi/scripts/containment-canary.sh"

failures=0
# code, connect, curl-exit → expected class. The shape string is deliberately
# not asserted: it is prose for a human and will be reworded.
check() {
  local what="$1" code="$2" connect="$3" rc="$4" want="$5" got
  got=$(classify "$code" "$connect" "$rc")
  got="${got#*|}"
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s (classify %s %s %s)\n' "$what" "$want" "$got" "$code" "$connect" "$rc" >&2
    failures=$((failures + 1))
  fi
}

echo "classify() — the three allowed shapes"
check "401 is refused"                          401 000 0 refused
check "403 is refused"                          403 000 0 refused
check "no connection at all is unreachable"     000 000 7 unreachable

echo "classify() — everything else is a hole, not a pass"
# ADR 0036: 「200 でなければ合格」にしない。404 と 500 は、穴が別のパスに移っただけ・
# 盤面が壊れているだけの状態であり、否定形の規則ならどちらも通り抜ける。
check "200 is reachable"                        200 000 0 reachable
check "404 is reachable, not a refusal"         404 000 0 reachable
check "500 is reachable, not a refusal"         500 000 0 reachable

echo "classify() — the proxy layer (#152's shapes)"
check "CONNECT refused with 403 is refused"     000 403 56 refused
check "CONNECT refused with 407 is refused"     000 407 56 refused
# The regression this file exists for. #152 measured `raspberrypi:8443` getting
# `200 Connection Established` and then failing the TLS handshake — the worker
# DID get out. Judged by the failed request alone it looks like a dead
# connection, and the canary would go green with the deny entry deleted.
check "CONNECT allowed then TLS died is REACHABLE" 000 200 35 reachable
check "CONNECT allowed then 401 is still refused"  401 200 0 refused

echo "verdict_for() — baseline × observed"
want_verdict() {
  local what="$1" base="$2" observed="$3" want="$4" got
  got=$(verdict_for "$base" "$observed")
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s\n' "$what" "$want" "$got" >&2
    failures=$((failures + 1))
  fi
}
want_verdict "reachable outside, refused inside"        reachable   refused     PASS
want_verdict "reachable outside, unreachable inside"    reachable   unreachable PASS
want_verdict "reachable outside, REACHABLE inside"      reachable   reachable   FAIL
# The guard the whole baseline exists for: a dead target means the run proved
# nothing, and must never be scored as containment working.
want_verdict "dead outside stays VACUOUS, not PASS"     unreachable unreachable VACUOUS
want_verdict "dead outside stays VACUOUS even if refused" unreachable refused   VACUOUS

if [[ "$failures" -gt 0 ]]; then
  echo "$failures case(s) failed" >&2
  exit 1
fi
echo "all cases passed"
