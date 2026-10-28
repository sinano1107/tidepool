# 答えを取りに行く Board call は stream を読み、差し替えと拒否を usage の行の隣に逐語で残し、差し替えは止めない

2026-10-28 の triage → grilling(issue #2661、#2658 の副産物)で決定。#2551 の stop 8 の帰責 Board call は、Provider が内容を拒み CLI が
`claude-fable-5-1` を `claude-opus-4-8` に替えて答えていた(CLI 自身の session transcript で観測)。`board_calls` の行は pin の model と
2つの model の合計の usage を持ち、差し替えの事実をどこにも言えなかった。固定版 2.1.286 の headless の loop を binary で読むと、
`-p --output-format json` は最後の result 1 object だけを stdout に書き、result object に差し替えの欄は無い。差し替えの
`system/model_refusal_fallback` 行が stdout に出るのは `json --verbose`(全 message の配列)か `stream-json --verbose` のときだけで、
runner はそのどちらでもなかった。さらに `boardCallEnv` は差し替えを止める env 3つを消しておらず(消すのは worker の spawn env だけ)、
Board call で差し替えが起きるかは host env が決めていた。適合試験(ADR 0303 決定4)は Board call の1ターンを `stream-json --verbose` で
撃っていて、runner の形と既にずれていた。binary の読みと `file:line` は #2661 のコメントに置く。

## 決定

1. **ADR 0215 の3点を答えを取りに行く Board call にも当てる。** 差し替えは止めず、止める側の env 3つ(`SWAP_DISABLE_ENVS`)は
   Board call の env からも消して「許す」を固定し(ADR 0005)、観測は逐語で記録する。止める案は ADR 0215 決定1 が退けた理由
   (止めたときの終わり方 `model_refusal_no_fallback` は未観測で、狙って起こす手段も無い)がそのまま当たり、帰責の答えが取れずに
   落ちる経路を今より増やす。
2. **runner は `stream-json --verbose` で撃ち、差し替えと拒否は worker と同じ行の読み手で読む。** 判定は `subtype` 1点
   (ADR 0215 決定2)。`modelUsage` の2キーから答えた model を推論する案は同じ決定が退けた線。`json --verbose` の配列を歩く
   読み手を別に書く案は、同じ行を読む読み手を2本にする。stream にすると runner の形が適合試験の測っている形と一致する。
   result 行は runner 自身が最後の `result` 行として読み、既存の封筒の判定(行の拒否・401・429・`is_error` の usage)をそのまま通す
   —— worker の result の読み手は `is_error` を捨てる(#534)が、runner は usage つきの失敗も行にする(ADR 0299 決定3)。
3. **記録は `board_calls` の行に `model_swaps` / `refusals` の列で、常に置く。** 欄の形と意味は `worker_exited` の直下の欄と同じ
   (ADR 0215 決定3 / ADR 0317 決定1): 出た順、欄名は盤面の語、値は逐語、無ければ `[]`。答えが返った行にも usage を報告した
   失敗の行にも乗せ、probe の行と Codex の行は `[]`。追加列だけで既存の列は触らない。`model` 列は pin の綴りのまま —— 列が
   間違っているのではなく、記録が差し替えの事実を言えなかったのが欠陥である(ADR 0299 決定2 は pin か答えた model かを決めていない)。
4. **usage の無い呼び出しで観測した差し替えは残さない。** 行の定義は「usage を報告した呼び出し」のまま(ADR 0299 決定3・4)。
   ADR 0317 が worker で「報告の無い session でも残す」と決めた理由は学習器の `excluded` と failure question の読み手で、Board call には
   どちらも無く、失敗は呼び手の `*_failed` event が持つ。usage を null にした行を書く案は、表に「usage 無しの行」という新しい
   意味を足し、翻訳 spend の読み手に null を教える。
5. **読み手は足さない。** 翻訳の usage API(settings の translation spend)に差し替えは載せず、学習器・配分評価の judge・Interview は
   `board_calls` を読まないので outcome も変えない。記録するのは記録の事実だからで、読み手は人間の triage(記録から原物の model を
   言う)だけ。

## 帰結

- ADR 0215 と ADR 0317 に Status 追記。CONTEXT.md の 差し替え(Model swap)は worker session 限定の文から Board call を含む文に直す。
- probe(認証の検査・model probe)は `json` のまま列に `[]` を書く。probe の差し替えが観測されたら揃える。Codex の答えを取りに行く
  runner(#2417)は `[]` を書く。
- `board_calls` は task を持たない(ADR 0299 決定5)ので、差し替えられた帰責がどの task のものかは `use` と `created_at` で寄せる。
  読み手が人間の triage だけの間は欄を足さない。
- `-p` の stream-json での差し替え行・拒否の assistant 行の実物は未観測のまま(#1615)。fixture は固定版の binary が yield する形
  (snake_case の `original_model` / `fallback_model` / `scope` 省略可 / `api_refusal_category` null あり)から合成する。
- 応答原文を残す問い(#2657)の器は、runner が stream を丸ごと手にするので同じ stream になる。この ADR の範囲外。

## 退けた案

- **Board call だけ env で差し替えを止める** —— 決定1。
- **据え置き(host env 次第のまま)** —— ADR 0005 の線に反し、観測した1回は host env の偶然で起きた。
- **封筒の `modelUsage` の2キーから推論する** —— 決定2、ADR 0215 決定2。
- **`json --verbose` の配列を読む runner 専用の読み手** —— 決定2。
- **差し替えの兄弟表** —— 読み手が無いのに結合を足す。
- **usage null の行で usage の無い呼び出しの差し替えを残す** —— 決定4。
- **result 行の `modelUsage`(model 別の内訳)を行に残す** —— ADR 0094 決定2 の理由は advisor の分離の観測で Board call には無く、`model_swaps` が替わった model を逐語で言う。読み手が出たら追加列で足せる。
