# Codex の subagent の床は hook の門である —— 閉じた `multi_agent` は model metadata に上書きされていた

2026-09-18〜20 の grilling(issue #730)で決定。ADR 0129 決定2 は Codex route の「subagent から盤面 verb 禁止」の床を
`multi_agent` を閉じることで置き、ADR 0130 決定2 は開け直しを #730 に預けた。vendor source(`rust-v0.147.0`、0.154.0 も同じ)
を読むと、subagent の版は `multi_agent_v2=true` → `agents.enabled=false` → **model の metadata** → `features.multi_agent` の順で
解決され、盤面の economy / standard の model(`gpt-5.6-terra` / `gpt-5.6-sol`)は metadata が v2 なので `multi_agent=false` は
読まれていなかった —— 床は置かれた日から効いておらず、
subagent からの盤面 verb を止めていたのは #731 の hook(`agent_id` で deny)だけだった。#730 が選ぶはずだった v1 / v2 も、
同じ理由で盤面の選択肢ではなかった。Lima VM で、spawn と同じフラグ・実物の hook を使って subagent を立て、子・孫・上限いっぱいの
3本のどの盤面 verb も `Tidepool board verbs are main-thread only` で deny され、main thread は通ることを観測した。実測の表と
`file:line` は #730 のコメントに置く。

## 決定

1. **床は hook の門(ADR 0130 決定1)に移し、ADR 0129 決定2 を supersede する。** `multi_agent` を `CLOSED_FEATURES` から外す。
   ADR 0130 決定2 の受け入れ観測はこの grilling の中で取れたので、派生の `needs-info` issue は持たない。これで Claude 経路と
   同じ機構になり、CONTEXT.md の Subagent の項は経路に依らない1文に畳む。
2. **版は宣言しない。** `multi_agent_v2` は既定のままにし、v1 / v2 は vendor の model metadata に任せる。門は両版で同じ形
   (`agent_id`)で、どの版で走ったかが盤面から見えないことは床に響かない。v2 の model に v1 を強制する設定は vendor に無い。
3. **`agents.max_concurrent_threads_per_session=3` を spawn 設定で宣言する。** 値は V2 の実効既定と同じで、目的は絞ることでは
   なく意味の固定である —— この key は版に依らず効く。frontier の `gpt-6-astra` は pin(0.147.0)同梱の metadata に居らず、
   どの版で走るかは未観測で、v1 なら既定は 6 になる。宣言しておけば、版がどちらでも本数は同じになる。
   V2 は `agents.max_depth` を無視し孫を立てられるため(実測)、session 全体にかかる歯止めはこの1本だけになる。到達時は queue
   されず model に `agent thread limit reached` が返る(実測)。`agents.*` は `features list` に出ないので、統制は ADR 0129
   決定4 と同じ —— `--strict-config`、pin、spawn 引数 seam の宣言テスト。未知の名前は strict-config の有無に依らず
   `expected struct AgentRoleToml` で起動が落ちる(実測)。深さは盤面の関心事にしない —— subagent の成果は何段でも親の完了
   基準に吸収される。
4. **Codex worker に届く盤面の文面に、spawn は `fork_turns: "none"` で行う旨を1文足す。** V2 の既定 `"all"` は親の rollout を
   読みに行き、`--ephemeral`(ADR 0098 決定3)は rollout を保存しないので必ず失敗する(初手 8/8 が `"all"`、全敗。`"none"` は
   fork が理由の失敗なし)。vendor に fork の既定を替える config key は無い(0.147.0)ので、機構ではなく文面で置く。
   `fork_turns` は V2 の引数で、v1 の spawn(`fork_context`、既定 false)は rollout を読まないのでこの文は無害に余る。stderr の `collab spawn failed: no thread with id` はこれである。履歴全部の fork は親の盤面文面ごと
   subagent に写す挙動でもあり、`none` のほうが「労力の分割」の線に合う。

## 退けた案

- **暫定で `agents.enabled=false` を足して閉じ直す** —— 実稼働の盤面は無く、門は配線済みで、観測は同じ週に取れた。
- **`multi_agent_v2=true` で V2 を明示する** —— metadata が null の model にまで V2 を強制する。得るものが観測に無い。
- **上限を既定より絞る / 宣言しない** —— 前者は守る対象(quota 窓、資源)の痛みが未観測で値の根拠が立たず、後者は版で既定が
  動いても盤面から見えない。
- **`config/read` で上限の実効値を preflight に載せる** —— app-server が同じ `-c` を食うことしか見えず、exec が絞ることの観測に
  ならない。
- **`--ephemeral` をやめる / fork の失敗を受け入れる** —— 前者は ambient な状態を除く床を1引数のために動かし、後者は spawn の
  たびに確実に起きる無駄を残す。
- **CONTEXT.md に「資源の上限は盤面が宣言する」を足す** —— Claude 経路は上限を宣言しておらず、一般則として偽になる。
