# Codex の使用率 0% の窓は未開始(Idle)であり、reset が窓幅を超えないという上限検査は撤去する

2026-09-17 の grilling(issue #720)で決定。Codex の使用量 probe(`codex app-server`、ADR 0098 / 0116)は
窓を正規化するとき「reset 時刻 − pickup 時刻 ≤ 窓幅」を検査し、外れれば観測不能に倒していた。Lima VM の
実測で、idle の窓(`usedPercent: 0`)は backend が **自分の時計で「今 + 窓幅」の絶対時刻**を `reset_at` として
返し(`codex-rs/backend-client` はそれを無加工で渡す)、観測のたびに滑ると分かった。検査は probe の往復と
秒への丸めのぶん必ず超え、結果は盤面の速さで割れるコイン投げになる。さらに検査を直しても、滑る reset を
ペース線に流せば `elapsed ≈ 0` で予約ぶん(session 20pt = 1時間)絞られ、待ち明けの再観測がまた「今 + 窓幅」を
見る livelock になる —— ADR 0076 が Claude 側で退けた「0% 窓の合成」と同じ形が vendor の側から来ている。
導入 commit 8910b92 の pin は既に 0.147.0 で、vendor の drift ではなく盤面の最初からの読み違い(ADR 0127 と
同じ形)。実測の逐語・3回の probe の表・算術・`file:line` は #720 のコメントに置く。

## 決定

1. **Codex の `usedPercent === 0` の窓は ADR 0076 の未開始(Idle)** —— 観測できた不在で、ペース線を持たず、
   絞らない。判別は使用率だけで、reset 時刻は見ない。primary / secondary に一様に適用する。
   自己制限性は ADR 0076 と同じ: 誤読できるのは 0% の間だけで、盤面が pickup して 1% でも付けば次の観測から
   予約込みのペース線が効く。Claude の「0% + Resets あり = 活性」に相当する区別は Codex では持たない —— 開いた
   直後の 1% 未満の窓も Idle に畳み、被害は窓の 1% 未満に閉じる。
2. **Idle の窓は観測の windows から落とす**(status は `observed`、その Provider は throttled されない)。
   ADR 0076 の「永続状態・UI は変えない、未開始は throttled = 0 に畳む」と同じ着地 —— 無い窓の状態は無く、
   行を残せば vendor の滑る reset が「次の reset」として人間に見える。
3. **上限検査「reset が窓幅を超える」は撤去し、下限(reset が過去)だけ残す。** 守っていた前提(reset は盤面の
   pickup 時刻から窓幅以内)は vendor の契約だったことが一度も無く、比べているのは OpenAI backend と盤面ホストの
   時計で余裕がゼロ —— idle だけでなく開いた直後の活性窓も落とす。撤去した先で窓幅より遠い reset が来ても、
   ペース線は `elapsed < 0` で throttled、`resumesAt` は将来のタイマー付きになり fail-closed のまま自己回復する。
   失うのは「ゴミ応答を理由付きの観測不能として表示する」診断の正直さだけで、drift の門は ADR 0098 の schema
   適合が持つ。probe に渡す `now` は pickup 時刻のまま変えない。
4. **0% で `resetsAt` / `windowDurationMins` が null の応答は fail-closed のまま**(未観測の形に互換を推測しない、
   ADR 0098)。起きれば理由付きの観測不能として表に出るので、それ自体が観測経路 —— issue は起票しない。
5. **Codex の Idle は Spend-down に触れない。** Spend-down の窓の同一性は Claude の session / week(ADR 0030 / 0091)
   で、Codex の窓の不在はそれについて何も言わない。決定2 で行ごと落ちるので判定にも入らない。

## 退けた案

- **検査だけ直す**(往復後に `now` を採る / 許容幅を入れる) —— 観測不能が throttled に変わるだけで、idle の間
  openai が pickup されない症状は livelock として残る。往復後の `now` 単独では超過が往復を超える観測(3回中2回)
  で半分落ち、許容幅は往復の上限が無いので任意の定数になる。
- **0% かつ「reset が窓幅まるごと先」で判別** —— Q2 で捨てた定数が判別に戻り、1秒前に開いた 0% の窓と区別できない。
- **前回観測から reset が滑ったことで判別** —— 状態が要り、起動後最初の観測を判定できない。
- **Idle を Claude 固有の語彙にとどめる** —— livelock を受け入れる選択で、観測された痛み(#706 の症状)を残す。

## 帰結

- CONTEXT.md「未開始(Idle)」は概念(観測できた不在)と Harness ごとの描かれ方を分けて書く。ADR 0076 は Claude の
  描画についての決定として不変。
- Claude の Spend-down が Codex の窓に決定なしで当たっている(導入 commit 8910b92)ことは本 ADR の主語の外で、
  派生 issue に切り出す。
