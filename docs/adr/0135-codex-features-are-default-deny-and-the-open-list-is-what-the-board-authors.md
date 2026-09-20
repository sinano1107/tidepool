# Codex の features 軸は既定拒否である —— 盤面が書くのは開ける名前のほう

2026-09-20 の grilling(issue #571)で決定。ADR 0039 の「既定拒否の allowlist」はツール層の決定で、Codex の features 軸の向きは
どこにも決まっていなかった。`CLOSED_FEATURES` は名指しで閉じる列挙で、導入元(#453)にも ADR 0098 / 0108 にも選定の根拠が無く、
stable かつ true のまま列挙の外にいる feature が 23 件あった。vendor source(`rust-v0.147.0`)を feature ごとに読んだ結果と
`file:line` は #571 のコメントに置く。

## 決定

1. **向きは既定拒否。** 盤面が書くのは `OPEN_FEATURES`(開ける名前と理由)で、閉じる側は「`features list` の全名 − 開ける名前 −
   決定4 の名前」として導出し、既定が false のものにも明示的に `=false` を渡す。名指しで閉じる向きでは、vendor が stable / true で
   足した feature が開いたまま入ってくる。#532 の snapshot は差分を fail-closed で見せるが、その差分の既定を決めるのは向きである。
2. **線は2本。** 能力や面を足す feature は閉じる。**必須機能の実装を切り替えるだけ**の feature(`unified_exec` /
   `remote_compaction_v2` / `shell_snapshot` / `enable_request_compression`)は vendor 既定のまま開ける —— 閉じても封じ込めは
   増えず、worker を vendor があまり走らせていない経路へ移すだけで、compaction のように長い session でしか発火しないものは
   受け入れの run 1本では壊れ方が見えない。`personality` は使用者が選ぶ文体の軸なので前者に当たり、閉じる。
3. **`codex exec` では走らない feature も閉じる。** 「exec からは到達しない」は vendor の実装の事実であって盤面の宣言ではない ——
   ADR 0108 が `-p` について問題にしたのと同じ形の依存を置かない。
4. **`=false` が通らない名前は、開ける名前とは別の列挙で持つ。** stage `removed` の一部は vendor の `apply_map` が設定を
   読み飛ばし、`features list` は true を返し続ける。読む箇所が無いので面ではないが、導出から除かないと snapshot と食い違う。
5. **「閉じた」の証拠は、pin 単位の source 読みと、受け入れの worker run 1本。** `features list` の state は設定の写しであって
   runtime の面ではない —— model metadata が features に勝つ軸が今日2本ある(`multi_agent_version`: ADR 0134、`tool_mode`: #762)。
   pin を上げるときは snapshot の採り直しに加えて、この軸と `apply_map` の読み飛ばしを source で読み直す。feature ごとの runtime
   観測は求めない —— 不在を観測する手段が feature ごとに違い、多くは無い。
6. **snapshot の照合は、封じ込め能力の「ツール面が宣言どおりか」の Codex 版と位置づける。** 対象は同じ(宣言した設定を CLI が
   honor しているか)で、観測先が違う。決定5 の限界は CONTEXT.md の同じ項に書く。

## 退けた案

- **`CLOSED_FEATURES` に名前を足すだけ** —— 今日の 23 件は片付くが、向きが「黙って開く」のまま残る。
- **run の成立に要らないものは実装の切り替えも含めて全部閉じる** —— 線は1本で済むが、得るのは vendor 既定から外れた経路だけ。
- **`unified_exec` だけ閉じる** —— bundled model の metadata は `shell_command` で、開けているほうが metadata を上書きしており、
  PTY と長寿命 process のぶん Worker 容器の回収の面も広い。ただし今の worker は全 run がこの経路で、回収は成立している。
  閉じる根拠が観測に無い。
- **`tool_mode` の上書きをこの決定に含める** —— source の読みだけで runtime は未観測。#762 に預ける。
