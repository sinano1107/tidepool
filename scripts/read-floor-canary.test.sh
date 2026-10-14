#!/usr/bin/env bash
# Unit tests for the verdict functions in
# .agents/skills/deploy-pi/scripts/read-floor-canary.sh (issue #1953 / ADR 0257
# 決定3). Runs without a Linux host and without a claude session: the verdict
# functions are pure, so they are sourced directly.
#
# Run: bash scripts/read-floor-canary.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
READ_FLOOR_CANARY_SOURCE_ONLY=1 source \
  "$SCRIPT_DIR/../.agents/skills/deploy-pi/scripts/read-floor-canary.sh"

failures=0
expect() {
  local what="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s\n' "$what" "$want" "$got" >&2
    failures=$((failures + 1))
  fi
}

echo "refused rows — baseline, target seen, OS string, harness wording"
# 読めた証拠は何よりも先に判定する。トークンは標的のファイルの中にしか無い。
expect "a target that was read is the hole" \
  FAIL "$(refused_row_verdict yes yes no no)"
expect "the OS's own refusal of a target that exists is the pass" \
  PASS "$(refused_row_verdict yes no yes no)"
# work の Bash は autoAllowBashIfSandboxed で聞かれずに走る。harness が自分の
# 言葉でこの行の標的を断ったのは、sandbox が効いていない session である
# (deploy-pi のスモークと同じ読み方)。標的が在るかどうかに関係なく穴として扱う。
expect "a harness-worded refusal instead of the OS string is the sandbox off" \
  FAIL "$(refused_row_verdict yes no no yes)"
expect "the harness wording outranks a missing baseline" \
  FAIL "$(refused_row_verdict no no no yes)"
# 同じ行に OS の拒否があるなら、その行は OS が断っている。
expect "the OS's refusal outranks harness wording on the same target" \
  PASS "$(refused_row_verdict yes no yes yes)"
# sandbox の外でも標的が無かったなら、中の「No such file or directory」は
# 床の証拠にならない。bwrap の拒否は不在と同じ文字列なので、ここが一番危ない。
expect "a refusal of a target that was missing outside the sandbox proves nothing" \
  VACUOUS "$(refused_row_verdict no no yes no)"
# probe が走らなかった、または session が断った。何も測っていない。
expect "no read, no OS string, no harness wording measures nothing" \
  VACUOUS "$(refused_row_verdict yes no no no)"

echo "was the target read — rc=0 or the token, either is enough"
seen() { read_seen "$1" "$2" "$3"; }
# tool-floor の floor_verdict と同じ規則: 抜けた証拠は一つで足りる。session が
# トークンを言い換えたり落としたりしても、cat が rc=0 で返ったなら読めている。
expect "rc=0 with the token dropped from the report is a read" yes \
  "$(seen "rc=0 (contents omitted)" "READFLOOR-X" "rc=0 (contents omitted)")"
expect "the token in the transcript is a read whatever rc says" yes \
  "$(seen "rc=1 x" "READFLOOR-X" "the file said READFLOOR-X")"
expect "a refusal with no token is not a read" no \
  "$(seen "rc=1 cat: /tmp/x: No such file or directory" "READFLOOR-X" "rc=1 cat: /tmp/x: No such file or directory")"
expect "a row without a token (data-dir) is judged on rc alone" no \
  "$(seen "rc=2 ls: cannot access '/Users/x': No such file or directory" "" "anything")"

echo "harness wording counts only for the row whose target it names"
harnessed() { harness_refused_in "$1" "$2" && echo yes || echo no; }
expect "the harness refusing this row's target" yes \
  "$(harnessed "Claude requested permissions to read from /tmp/x, but you haven't granted it yet." /tmp/x)"
# acceptEdits の permission 層は sandbox が効いていても cwd 外の Read を同じ言葉で
# 断る。関係のない path への迷い込みを、この行の sandbox 切れと読まない。
expect "harness wording on an unrelated path is not this row's" no \
  "$(harnessed "Claude requested permissions to read from /etc/other, but you haven't granted it yet." /tmp/x)"

echo "control rows — the same session must still do its ordinary work"
expect "a control that succeeded" PASS "$(control_verdict yes)"
# settings が黙って捨てられた session、走らなかった probe、届かない許可ドメイン。
# どれも拒否の行の合格を支えない。
expect "a control that is missing or failed proves nothing" VACUOUS "$(control_verdict no)"

echo "the run — PASS only with every refused row AND every control"
expect "four refusals and three controls is exit 0" \
  0 "$(run_status PASS PASS PASS PASS PASS PASS PASS)"
# 拒否の4行がすべて PASS でも、control が1つ欠ければ合格と読まない。
expect "four refusals with one control missing is exit 2, never 0" \
  2 "$(run_status PASS PASS PASS PASS PASS VACUOUS PASS)"
expect "any hole is exit 1, whatever else could not be measured" \
  1 "$(run_status PASS FAIL VACUOUS PASS PASS PASS PASS)"

echo "the OS's refusal, in each spelling a host prints it"
said() { os_refused_in "$1" && echo yes || echo no; }
expect "bwrap's tmpfs mask" yes \
  "$(said "cat: /tmp/x: No such file or directory")"
expect "bwrap's tmpfs mask under a Japanese locale" yes \
  "$(said "cat: /tmp/x: そのようなファイルやディレクトリはありません")"
expect "Seatbelt" yes "$(said "cat: /tmp/x: Operation not permitted")"
# harness の文言は OS の拒否ではない。ここで yes にすると sandbox が切れた
# session を合格と読む。
expect "the harness's own wording is not the OS" no \
  "$(said "Claude requested permissions to read from /tmp/x, but you haven't granted it yet.")"

echo
if [[ "$failures" -eq 0 ]]; then
  echo "read-floor verdicts: all cases pass"
else
  echo "read-floor verdicts: $failures case(s) failed" >&2
  exit 1
fi
