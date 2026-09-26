# 事例(Exemplar)は記憶の第4種であり、表現の選択は condensation の仕事で、Behavior の読み出しは依拠した事例を返す

2026-09-25 の grilling(issue #587 を錨に、context-vault `projects/tidepool/memory-and-growth.md` の設計懸念を審査)で決定。
懸念は「異議 → RCA → Behavior の経路が、経験を自然言語の常設指示へ過圧縮する」— 具体の成功 / 失敗が持つ高次元の質は規則文に
畳むと失われる。vault の4分法を盤面の語彙に写すと、hard boundary は registry の authority / profile(Memory は決裁権を広げない、
ADR 0083 決定5)、generalizable tendency は Behavior、weakly supported は昇格しない candidate(一般化可能性は meta-review の判断、
ADR 0115 決定4)に既に居場所があり、残余は **tacit な質に worker 向けの置き場が無い**ことだけ — 昇格しない candidate は worker に
見えず、Precedent は meta-review 専用(ADR 0083 決定10)。これは #587 の問いそのものである。実装の調査は #587 のコメントに置く。

## 決定

1. **Exemplar(事例)は記憶エントリの第4種。** 出所は事例の Episode(decision entry または `worker_spawned` の event id)で、
   人間が書いても同じ — 事例は記録を指すのが本体であり、ADR 0083 追記5 の「人間の出所 = 自身の作成 event」は指す記録が無い
   Knowledge の話。本文は注釈の list で、各注釈は {anchor(case 描画の逐語引用 or whole)、polarity(imitate / avoid)、text}。
   「全体はこの形で、特にここを真似よ」は注釈が複数で位置を持つ形でしか書けず、1つの例に正負の注釈が同居する。承認・無効化の
   単位はエントリ(文言 = list 全体)で、極性はエントリに無い。承認の線は Behavior と同じ(AI 起草は candidate → question、
   人間直書きは approved)。新エンティティにしないのは Definition と同じ理由(追記4)。

2. **表現の選択は condensation の仕事。** RCA の起草(ADR 0120 決定1)は変えない。一般化できない candidate を meta-review が
   `consolidate` で kind exemplar の新 candidate(出所は同じ、注釈1件・avoid・anchor = 異議された decision の引用)に畳み、元を
   `superseded` にする。正の事例の入口は人間の直書きだけ(ADR 0152 の線) — 学習入力は異議だけ(ADR 0083 決定7)と 👍 の先送りは
   維持する。meta-review が outcome から正の事例を起草する提案 op は形だけ決め(根拠の引用が必須、修正値で注釈 list を直せる)、
   建設は「人間が直書きで事例を繰り返し書いた」観測の後(#587)。

3. **worker が読む本文は 注釈 + case 描画(decision 本文 + steering + Episode の handoff / result)。** transcript は盤面側のまま
   (決定8)、行動列は観測後。**Behavior の `read_memory` も同じ描画で依拠した事例を返す** — RCA 起草の Behavior は出所に異議 event を
   持ちそこから Episode まで辿れるのに worker には数字しか返らない、既存経路の穴であり観測を待たない。anchor は描画ではなく記録の欄に
   結ぶ — `whole` か `{ field, quote }`(field は decision / steering / handoff / result、quote はその欄の逐語部分文字列)— で、
   一致しなければ書き込みを拒否する。欄は不変の記録なので書いた時点で一致した注釈は以後も一致し、未解決の注釈は存在しえない。
   人間の扉は決定ログの一覧から事例を選び、その場に出る case 描画から文字列を選択して anchor を埋める。人間が Behavior を書くときも
   任意で同じ出所を添えられる(添えなければ作成 event が出所のまま、case は空)。

4. **関係は出所から派生し、列も表も足さない。** 同じ Episode を出所に持つ Behavior が「事例に支えられる規則」。冗長な事例は
   `superseded` + 後継 = 代表。**Precedent の自由 pull は作らない** — 承認不要の第3層の再提案(決定3)。#587 の観測門は
   「エントリ経由で足りない場面」と「提案 op」の2つに狭まる。

## 退けた案

- **`constraint` / `guidance` を記憶の種別にする** — 前者は registry、後者は Behavior の別名。語彙は増やさない。
- **注釈は散文1本 / 注釈1つ = エントリ1つ** — 前者は重複と陳腐化を検査できず、後者は注入の目次が例1つにつき注釈数だけ濁る。
- **anchor をオフセット / 段落番号で持つ / 描画の逐語引用にして描画時に検証し未解決を印す** — 前者は描画の書式に結合し、後者は
  描画器の版が変わると承認済み注釈が宙に浮く。記録の欄に結んで書き込み時に拒否すれば、落ちうるものを保存しない。
- **Behavior ↔ Exemplar の link 表** — 出所の Episode からの読み出し時スライスで足りる(decision マーカーと同型)。
- **完了ごとの Board call / worker の自薦で正の事例を起草する** — 前者は承認 question が完了数だけ増え、後者は自己申告(決定7)。
- **Exemplar 本体を #587 の観測後に建てる** — write path の表現が1つしか無いのは既存挙動の欠陥で、kind が無ければ「一般化できな
  かった」観測自体が記録されない。観測を待つのは提案 op だけ。

## 追記: meta-review の畳みも注釈 list を受ける(2026-09-26、issue #954)

決定2 の括弧書き「注釈1件・avoid・anchor = 異議された decision の引用」は、RCA が起草した candidate を畳むときの典型の形であり、
制約ではない。`consolidate` の kind exemplar は人間の write と同じ注釈 list を受ける — 件数・polarity・anchor の欄を問わず、
検証も同じ関数。1つの例に正負の注釈が同居する(決定1)のは meta-review の起草でも同じで、1件・avoid に絞ると
「全体はこの形で、特にここを真似よ」を meta-review が書けない。
