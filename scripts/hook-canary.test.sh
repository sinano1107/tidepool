#!/usr/bin/env bash
# Unit tests for hook_verdict() in .agents/skills/deploy-pi/scripts/hook-canary.sh
# (issue #143 / #160 / ADR 0037). Runs without a Pi and without a claude session:
# hook_verdict() is a pure function over three strings, so it is sourced directly.
#
# This function is the whole verdict of the hook canary, and it is the one part
# that can fail *silently* — every other part of the canary fails loudly. Two
# silences look identical from outside and mean opposite things:
#
#   - hooks are genuinely inert (the pass)
#   - the settings file was dropped wholesale, or the session never ran at all
#     (nothing was measured)
#
# `-p` drops a settings file that fails validation without a word (ADR 0033), so
# the second is not hypothetical. These cases exist to keep it from being scored
# as the first.
#
# Run: bash scripts/hook-canary.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CANARY_SOURCE_ONLY=1 source \
  "$SCRIPT_DIR/../.agents/skills/deploy-pi/scripts/hook-canary.sh"

failures=0
# role, session-ran, hook-fired → expected verdict
check() {
  local what="$1" role="$2" trigger="$3" fired="$4" want="$5" got
  got=$(hook_verdict "$role" "$trigger" "$fired")
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s (hook_verdict %s %s %s)\n' \
      "$what" "$want" "$got" "$role" "$trigger" "$fired" >&2
    failures=$((failures + 1))
  fi
}

echo "live — the board's own profile, real disableAllHooks key"
check "session ran and the hook stayed silent is the pass"    live yes no  PASS
check "a hook that fired is the breach ADR 0037 is about"     live yes yes FAIL

echo "control — the fake disableHooks key, which must NOT stop the hook"
check "the hook firing is what proves the real key did work"  control yes yes PASS
# 「実在キーと未知キーの黙殺の区別」— #143 の B 表が偽キー `disableHooks` を
# negative control に選んだ理由がこれ。偽キーでも hook が黙るなら、settings
# ファイルごと捨てられた(あるいは hook 定義が壊れている)ということであり、
# live 側の沈黙も同じだけ無意味になる。合格にしてはならない。
check "silence under the FAKE key means nothing was measured" control yes no  VACUOUS

echo "no session, no measurement — in either role"
# 「hook が発火しなかった」はセッションが走らなかった場合と見分けがつかない。
# ADR 0033 の「-p は検証に失敗した --settings を黙殺する」があるので、これは
# 想定される定常状態であって理論上の懸念ではない。
check "live without the trigger file proves nothing"          live    no no  VACUOUS
check "control without the trigger file proves nothing"       control no no  VACUOUS
# 発火だけ在ってトリガーが無い形も合格にしない — セッションが notes.txt を
# 残せなかった以上、何がその hook を引いたのかこちらには分からない。
check "live: a fired hook without the trigger is still unmeasured" live no yes VACUOUS

echo "deny — permissions.deny must refuse the Write tool IN ITS OWN WORDS"
dcheck() {
  local what="$1" written="$2" refused="$3" want="$4" got
  got=$(deny_verdict "$written" "$refused")
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s (deny_verdict %s %s)\n' \
      "$what" "$want" "$got" "$written" "$refused" >&2
    failures=$((failures + 1))
  fi
}
dcheck "the rule's own refusal is the pass"                 no  yes PASS
dcheck "a settings file that appeared is the hole"          yes no  FAIL
# ADR 0033:「床はモデルの判断に依存しない」。auto の分類器はこの書き込みを断る
# ことも通すこともある(2026-08-03 実測、再現しない)。分類器が断っただけの回を
# 合格にすると、deny ルールが静かに効かなくなった日に緑のまま出荷される。
dcheck "a classifier refusal is not this floor"             no  no  VACUOUS
# 転記だけを信じない: ルールの文面が出ていてもファイルが在るなら穴。
dcheck "a file that exists outranks whatever was reported"  yes yes FAIL

echo "deny/scope — the ban must stay the size the board thinks it is"
scheck() {
  local what="$1" written="$2" want="$3" got
  got=$(scope_verdict "$written")
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s (scope_verdict %s)\n' "$what" "$want" "$got" "$written" >&2
    failures=$((failures + 1))
  fi
}
# 拒否文言が "File is in a DIRECTORY that is denied" なので、`.claude/` まるごとの
# deny と区別がつかない。実測(2026-08-03)では Edit 2本の下で
# `.claude/skills/**` も `.claude/commands/**` も書けたが、それはベンダー挙動で
# あって盤面が決められる規則ではない。広がった日は ADR 0025 の @workspace skill
# が消え、しかも emit される配列は変わらないのでテストは何も言わない。
scheck "the workspace's own skills stay writable"        yes PASS
# 「広がった」と「セッションが飛ばした」は外からは同じ形。合格にも破れにもしない。
scheck "a missing skill file is ambiguous, never a pass" no  VACUOUS

echo
if [[ "$failures" -eq 0 ]]; then
  echo "hook_verdict: all cases pass"
else
  echo "hook_verdict: $failures case(s) failed" >&2
  exit 1
fi
