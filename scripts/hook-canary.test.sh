#!/usr/bin/env bash
# Unit tests for the verdict functions in
# .agents/skills/deploy-pi/scripts/hook-canary.sh (issue #143 / #160 / ADR 0037,
# reshaped by issue #378). Runs without a Pi and without a claude session: each
# verdict is a pure function over strings, so the file is sourced directly.
#
# These functions are the whole verdict of the canary, and they are the one part
# that can fail *silently* — every other part fails loudly. Several silences
# look identical from outside and mean opposite things:
#
#   - the deny hook refused the subagent's board verb (the pass)
#   - the subagent never tried, the MCP stub never connected, the settings file
#     was dropped wholesale, or the session never ran at all (nothing measured)
#
# `-p` drops a settings file that fails validation without a word (ADR 0033), so
# the last is not hypothetical. These cases exist to keep any of them from being
# scored as the first.
#
# Run: bash scripts/hook-canary.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CANARY_SOURCE_ONLY=1 source \
  "$SCRIPT_DIR/../.agents/skills/deploy-pi/scripts/hook-canary.sh"

failures=0
# session-ran, parent-reached, subagent-reached, deny-worded → expected verdict
lcheck() {
  local what="$1" trigger="$2" parent="$3" sub="$4" worded="$5" want="$6" got
  got=$(board_hook_live_verdict "$trigger" "$parent" "$sub" "$worded")
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s (board_hook_live_verdict %s %s %s %s)\n' \
      "$what" "$want" "$got" "$trigger" "$parent" "$sub" "$worded" >&2
    failures=$((failures + 1))
  fi
}

echo "board-hook/live — the deny hook must stop the subagent and only the subagent"
lcheck "parent through, subagent silent, hook's own words = the pass" yes yes no yes PASS
lcheck "a subagent call in the stub's log is the breach"              yes yes yes yes FAIL
# ログはトランスクリプトにもトリガーにも勝つ — stub に届いた行は、セッションが
# notes.txt より先まで走った証拠そのものでもある。
lcheck "the stub's log outranks a missing trigger"                    no  no  yes no  FAIL
# 親の ping が届いていないなら、subagent の沈黙は配線切れと区別できない。
# しかも「hook が親を deny している」なら本番の worker が全滅する形 — どちらも
# 人間がトランスクリプトを読むまで緑にしない。
lcheck "a silent PARENT is never a pass (wiring or overblock)"        yes no  no  no  VACUOUS
lcheck "a silent parent with deny words is still not a pass"          yes no  no  yes VACUOUS
# subagent が試しもしなかったセッションは、deny された セッションと stub 側から
# は同じ形。hook 自身の文言だけがその沈黙を測定に変える。
lcheck "silence without the hook's words proves nothing"              yes yes no no  VACUOUS
lcheck "no trigger, nothing in the log — the session never ran"       no  no  no  no  VACUOUS

# session-ran, subagent-reached → expected verdict
ccheck() {
  local what="$1" trigger="$2" sub="$3" want="$4" got
  got=$(board_hook_control_verdict "$trigger" "$sub")
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s (board_hook_control_verdict %s %s)\n' \
      "$what" "$want" "$got" "$trigger" "$sub" >&2
    failures=$((failures + 1))
  fi
}

echo "board-hook/control — no hook in the way: the subagent MUST get through"
# control で届くことが、live の沈黙を「hook が止めた」と読んでよい根拠になる。
ccheck "the subagent reaching the stub is what proves delivery"  yes yes PASS
# 届かないなら live 行も同じだけ無意味 — ハーネスが subagent への MCP 配達を
# やめたのかもしれず、それは設計ごと見直す事件であって緑ではない。
ccheck "a silent control means the live row measured nothing"    yes no  VACUOUS
ccheck "no session, no measurement"                              no  no  VACUOUS

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
  local what="$1" written="$2" rule="$3" mode="$4" want="$5" got
  got=$(scope_verdict "$written" "$rule" "$mode")
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s (scope_verdict %s %s %s)\n' \
      "$what" "$want" "$got" "$written" "$rule" "$mode" >&2
    failures=$((failures + 1))
  fi
}
# この行が問うのは「ban が2ファイルから `.claude/` まるごとへ広がっていないか」
# だけである。判定材料が「書けたこと」から「**deny ルールが口を利いたか**」へ
# 移ったのは、本番の形(acceptEdits)ではモード自身がこの書き込みを承認要求に
# 落とすため — 2026-08-03 実測、`Claude requested permissions to write to
# …/.claude/skills/…` — 書けないことが常態になったから。deny はモードに勝つ
# (ADR 0038 の層の分担)ので、広がった ban なら**先に** deny の文言が出る。
scheck "a write that landed proves the ban never covered it"   yes no  no  PASS
# 広がった日は ADR 0025 の @workspace skill が消え、しかも emit される配列は
# 変わらないので盤面のテストは何も言わない。ここだけが見つけられる。
scheck "the RULE refusing this path is the ban having widened"  no  yes no  FAIL
# モードの承認要求で止まったのなら、止めたのは ban ではない。ADR 0025 の
# @workspace skill は**読み**であって、この行が守っているのは deny の広さである。
scheck "the MODE refusing it means the ban stayed its size"     no  no  yes PASS
# 「広がった」と「セッションが飛ばした」は外からは同じ形。合格にも破れにもしない。
scheck "no attempt at all is ambiguous, never a pass"           no  no  no  VACUOUS
# 転記より先にファイルシステムを信じる(deny_verdict と同じ順序)。
scheck "a file that exists outranks whatever was reported"      yes yes yes PASS

echo
if [[ "$failures" -eq 0 ]]; then
  echo "hook-canary verdicts: all cases pass"
else
  echo "hook-canary verdicts: $failures case(s) failed" >&2
  exit 1
fi
