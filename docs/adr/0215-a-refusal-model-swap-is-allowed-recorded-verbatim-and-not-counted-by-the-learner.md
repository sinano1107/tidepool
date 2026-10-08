# refusal による差し替えは止めず、逐語で記録し、学習器は数えない

2026-10-08 の grilling(issue #1523)で決定。#1425 の VM 実測(CLI 2.1.286)で、Fable の応答が Provider の safeguard に止められ、
CLI が `system/model_refusal_fallback` を出して以降を `claude-opus-4-8` で続けた session を1本見た。盤面はこの行を読まず、
`worker_spawned` の pin(Fable の行)の実績として学習器に数え、advisor の分離判定も走っていない model と比べていた。固定版の
binary を読むと、refusal の処理は2段である: まず同じ model で1回だけ注意文を注入して続け(この grilling の session 自身で観測)、
再び拒まれたときだけ CLI 内蔵の分類→model の表で同 Provider の別世代に替える。差し替えは env と settings で止められ、first-party の
base URL でしか起きない。schema の読みと実測の形は #1523 のコメントに置く。

## 決定

1. **差し替えは止めない。** 止めれば2回続けて拒まれた task が Fable の行のまま落ちるが、その終わり方は観測できておらず、狙って
   起こす手段も無い。同 Provider 内の降格は review の門が受け止め、記録が逐語で残れば学習器は歪まない。host に答えを委ねない
   (ADR 0005)ので、止める側の env 3つは spawn env から消して「許す」を固定する。止める側へ切り替える条件は、差し替えられた
   session の成果物が review で落ちる観測で、それはこの記録があって初めて見える。
2. **読むのは `system` 行の `subtype` 1点で、main が替わったと読むのは `scope` が `local` でないとき。** schema が `local` を
   「subagent / side-question だけが替わり session の model は変わらない」と定め、省略は `session` と読めと書く。`direction` では
   分岐しない(出るのは `retry` だけと schema が言う)。root の assistant 行の `message.model` のずれから読む案は、観測から帰属を
   推論しない線(ADR 0094 決定2)に反する。
3. **記録は `worker_exited.usage` に置く。** 差し替えは元の model / 替わった model / 範囲 / 分類の列、拒否そのもの(同じ model で
   続いた1段目も)は分類の列で、どちらも出た順、欄は常に置き、欄名は盤面の語、値は逐語。advisor の相談と同じく stream で観測した
   事実を usage に同居させる先例に乗り、配分評価の judge には新しい経路なしで届く(ADR 0214 決定4)。盤面は分類でも理由でも
   分岐しない。
4. **main が替わった session は学習器の `excluded` で、advisor の使用量の分離は null に倒す。** 仕事をしたのは表に無い model で、
   行は「その model はそのティアの品質を満たす」という分類(ADR 0114 決定2)なので、受理でも却下でも Fable の行の実績にすると
   比較が歪む。`excluded` は「判定が無い」「帰責が worker の落ち度でない」に「pin の行が仕事をしていない」を足した3つの意味を
   束ね、別の値は足さない —— 値で分岐する読み手が無い。
5. **question は立てず、新しい表示面も作らない。** session は exit 0 で完走し、人間が決めることが無い。報告なき exit の failure
   question 文に、`last_message` / `reported_error` と同じ並びで差し替えの1行を足すだけ。Precedent は観測した subtype を
   「知っていて捨てる行」に足し、マーカーにはしない(位置を読む読み手が無い)。

## 帰結

- moonshot の行は差し替わらない(first-party の base URL でだけ起きる)。
- `-p` の stream-json での実物(差し替えの行、拒否の assistant 行)は観測が1本と保存 transcript だけで、fixture は実物待ち。
- 止めたときの終わり方(`model_refusal_no_fallback`)は未観測のまま —— 決定1 を見直すときに要る。

## 退けた案

- **spawn env で差し替えを止める** —— 決定1。1回目の拒否は同じ model で吸収されるので落ちるのは2回続けて拒まれた task だけだが、
  その終わり方を測れていない。
- **CLI 内蔵の分類→model の表を盤面が持つ** —— release ごとに変わり、替わった model は行に逐語で届く。
- **差し替えのある episode に別の outcome 値を足す** —— 決定4。
- **Precedent のマーカーにする** —— db の CHECK を触り、位置を読む読み手が無い。
