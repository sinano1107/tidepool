# 語彙の中でも model が受けない effort は、盤面がそれを知れる場所で拒む

2026-10-09 の grilling(issue #1525)で決定。ADR 0216 は effort を閉じた5値にしたが、5値の中でも model が受けない値が
残った。Claude CLI はそれを黙って下げるか捨て(Haiku 4.5 はどの値でも effort 無しで走る)、Codex の API は
`unsupported_value` の 400 で断る(`gpt-5.5` + `max`)。前者は学習器のセルと `worker_spawned` に走っていない effort を
綴り、後者は selector が決定論なので pickup のたびに同じ行で failure question を立てる。実測と binary の読みは #1525 の
コメントに置く。

## 決定

1. **拒む場所は、盤面が「受けない」を知れる場所で決まる。** Claude は CLI の版ごとに閉じた事実として書く前に知れるので
   書く入口と起動時に、Codex はアカウントと版で変わる一覧の観測で知れるので pickup の前の probe で拒む。
2. **Codex は `model/list` の `supportedReasoningEfforts` と行の effort を照合し、広告されない組を走れない行にする。**
   ADR 0184 決定3 の照合を effort に広げる。Quarantine の鍵は (provider, model, effort) —— model ごとの拒否と同じ鍵では、
   同じ model の走れる effort の行まで外れる。Interview の対象にも同じ照合を当てる。
3. **Claude は「その版の組み込みの規則で、id ごとに effort をどう扱うか」を adapter が持つ。** 系列ではなく id で持つ
   (2.1.286 で捨てるのは `claude-haiku-4-5` で、Haiku 5.5 は CLI の知らない id として5値がそのまま送られる)。知らない id は
   すべての値を受けるものとして通す。版上げの手順で binary の拒否一覧と突き合わせる。
4. **`high` に下がる値は書く入口で拒み、走る値を名指す。** 黙って書き換えると人間の分類を変え、通すと同じ走り方の2行を
   別の段に置ける(ADR 0200 の「行は (model, effort) の組の分類」が崩れる)。
5. **effort を捨てる id の行は effort を「無い」で綴る。** 渡すべき値が無いものはフラグを省く以外に綴れない(ADR 0042)。
   扉は捨てる id には「無い」を、それ以外には5値を求め、spawn は `--effort` を省き、セルは advisor と同じく「無い」を持つ。
6. **起動時に anthropic / moonshot の行を事実と照らし、書いた effort で走らない行を決定2と同じ単位の Quarantine に入れる。**
   事実は tidepool の更新でしか変わらないので照合は起動時で足り、同じ理由で回答では決着せず表の編集だけで決着する。
   文面は「走れない」とも観測とも言わず、版の組み込みの規則と書くべき値を名指す。
7. **routing meta-review には拒否の文で返す。** 提案を作る時点で拒まれるので人間には届かない。id ごとの例外は旧世代の
   数件で版上げで変わるので、tool の description に常に載せない。

## 帰結

- 盤面は走った effort を観測しない。headless で読めるのは control request の `get_settings` だけで、adapter はその経路を
  持たない。守るのはセルの綴りで走れるかではないので、起動経路や床(hooks)を変えるほどの値は無い。
- CLI は組み込みの規則より先に served catalog(api.anthropic.com から実行時に取る)を読む。catalog が変われば盤面に
  見えないずれが起きうる。今は実測と組み込みの規則が一致している。
- API が effort を断ると、CLI は effort 無しで黙って送り直す。CLI の知らない id(Moonshot の `kimi-k3`、
  `claude-haiku-5-5`)は、2.1.286 で5値とも断られずこの道に乗らなかった(issue #1654 の実測)。Moonshot が受けた
  effort を推論に効かせているかは盤面から見えない。
- `execution_settings.effort` は NULL を許す。migration は書かず盤面を作り直す。

## 退けた案

- **ADR 0216 が退けた「一覧と照合して Quarantine」との関係** —— 0216 が挙げた不一致(`ultra`、`none`)はどちらも語彙の外
  で、5値の中で一覧が広告しない既知の点(`gpt-5.5` の `max`)は API も `unsupported_value` で断る。語彙の中に絞れば
  一覧は API と食い違わない。
- **Codex も書く入口で拒む** —— 扉の時点で新しい一覧がある保証が無い。ADR 0184 が照合を probe に置いた理由がそのまま当たる。
- **Haiku 4.5 の行を書けなくする / 5値のどれかで綴る** —— 前者は #1415 の Interview と運用者の行(ADR 0200 決定1)を閉じ、
  後者は走っていない effort を記録に残す。
- **版上げの手順書で運用者が行を確かめる** —— 黙って残るずれに人間の記憶で気づくことになる。
