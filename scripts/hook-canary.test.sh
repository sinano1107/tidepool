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
check() {
  local what="$1" want="$2" verdict="$3" got
  shift 3
  got=$("$verdict" "$@")
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s: wanted %s, got %s (%s %s)\n' \
      "$what" "$want" "$got" "$verdict" "$*" >&2
    failures=$((failures + 1))
  fi
}

# session-ran, parent-reached, subagent-reached, deny-worded → expected verdict
echo "board-hook/live — the deny hook must stop the subagent and only the subagent"
check "parent through, subagent silent, hook's own words = the pass" PASS board_hook_live_verdict yes yes no yes
check "a subagent call in the stub's log is the breach"              FAIL board_hook_live_verdict yes yes yes yes
# ログはトランスクリプトにもトリガーにも勝つ — stub に届いた行は、セッションが
# notes.txt より先まで走った証拠そのものでもある。
check "the stub's log outranks a missing trigger"                    FAIL board_hook_live_verdict no no yes no
# 親の ping が届いていないなら、subagent の沈黙は配線切れと区別できない。
# しかも「hook が親を deny している」なら本番の worker が全滅する形 — どちらも
# 人間がトランスクリプトを読むまで緑にしない。
check "a silent PARENT is never a pass (wiring or overblock)" VACUOUS board_hook_live_verdict yes no no no
check "a silent parent with deny words is still not a pass"   VACUOUS board_hook_live_verdict yes no no yes
# subagent が試しもしなかったセッションは、deny された セッションと stub 側から
# は同じ形。hook 自身の文言だけがその沈黙を測定に変える。
check "silence without the hook's words proves nothing"        VACUOUS board_hook_live_verdict yes yes no no
check "no trigger, nothing in the log — the session never ran" VACUOUS board_hook_live_verdict no no no no

# session-ran, guarded-thing-happened → expected verdict。board-hook/control
# (subagent が stub に届いたか)と auto-memory/control(固定した移し先への書き込みが
# 着地したか — ADR 0156)の両方がこの1つで判定される。
echo "control rows — the one guard removed: what it stops MUST happen"
# control で届くことが、live の沈黙を「hook が止めた」と読んでよい根拠になる。
check "the subagent reaching the stub is what proves delivery" PASS control_verdict yes yes
# 届かないなら live 行も同じだけ無意味 — ハーネスが subagent への MCP 配達を
# やめたのかもしれず、それは設計ごと見直す事件であって緑ではない。
check "a silent control means the live row measured nothing" VACUOUS control_verdict yes no
check "no session, no measurement"                           VACUOUS control_verdict no no

# deny と auto-memory(ADR 0156)の両方がこの1つで判定される。
echo "deny / auto-memory — permissions.deny must refuse the Write tool IN ITS OWN WORDS"
check "the rule's own refusal is the pass"        PASS deny_verdict no yes
check "a settings file that appeared is the hole" FAIL deny_verdict yes no
# ADR 0033:「床はモデルの判断に依存しない」。auto の分類器はこの書き込みを断る
# ことも通すこともある(2026-08-03 実測、再現しない)。分類器が断っただけの回を
# 合格にすると、deny ルールが静かに効かなくなった日に緑のまま出荷される。
check "a classifier refusal is not this floor" VACUOUS deny_verdict no no
# 転記だけを信じない: ルールの文面が出ていてもファイルが在るなら穴。
check "a file that exists outranks whatever was reported" FAIL deny_verdict yes yes

echo "deny/scope — the ban must stay the size the board thinks it is"
# この行が問うのは「ban が2ファイルから `.claude/` まるごとへ広がっていないか」
# だけである。判定材料が「書けたこと」から「**deny ルールが口を利いたか**」へ
# 移ったのは、本番の形(acceptEdits)ではモード自身がこの書き込みを承認要求に
# 落とすため — 2026-08-03 実測、`Claude requested permissions to write to
# …/.claude/skills/…` — 書けないことが常態になったから。deny はモードに勝つ
# (ADR 0038 の層の分担)ので、広がった ban なら**先に** deny の文言が出る。
check "a write that landed proves the ban never covered it" PASS scope_verdict yes no no
# 広がった日は ADR 0025 の @workspace skill が消え、しかも emit される配列は
# 変わらないので盤面のテストは何も言わない。ここだけが見つけられる。
check "the RULE refusing this path is the ban having widened" FAIL scope_verdict no yes no
# モードの承認要求で止まったのなら、止めたのは ban ではない。ADR 0025 の
# @workspace skill は**読み**であって、この行が守っているのは deny の広さである。
check "the MODE refusing it means the ban stayed its size" PASS scope_verdict no no yes
# 「広がった」と「セッションが飛ばした」は外からは同じ形。合格にも破れにもしない。
check "no attempt at all is ambiguous, never a pass" VACUOUS scope_verdict no no no
# 転記より先にファイルシステムを信じる(deny_verdict と同じ順序)。
check "a file that exists outranks whatever was reported" PASS scope_verdict yes yes yes

echo "project-hook — sparse live must stay silent while full-checkout control fires"
check "only the full-checkout control fires" PASS project_hook_verdict yes yes no yes
check "a hook firing in the sparse live workspace is the breach" FAIL project_hook_verdict yes yes yes yes
check "a silent control proves nothing" VACUOUS project_hook_verdict yes yes no no
check "a session that never ran proves nothing" VACUOUS project_hook_verdict no yes no yes

echo
if [[ "$failures" -eq 0 ]]; then
  echo "hook-canary verdicts: all cases pass"
else
  echo "hook-canary verdicts: $failures case(s) failed" >&2
  exit 1
fi
