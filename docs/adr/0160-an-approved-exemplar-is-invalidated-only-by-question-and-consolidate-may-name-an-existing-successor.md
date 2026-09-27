# approved の Exemplar の無効化は question だけを通り、統合の提案は既存の後継を名指せる

2026-09-27 の grilling(issue #1029)で決定。meta-review の直接の無効化は approved の gate を Behavior にしか掛けておらず、
approved の Exemplar を question なしに任意の理由で無効化できた。提案 op invalidate は Behavior しか target に取らず、
Exemplar の無効化を人間に問う経路は無かった。spec #949 の story 10 は冗長な事例を `invalidate_memory` の `superseded` +
後継で引退させるとしていたが、question を通さない根拠はどの記録にも無い。コードの調査は #1029 のコメントに置く。

## 決定

1. **approved の Exemplar の無効化は、`superseded` を含めて question を通る。** ADR 0153 決定1「承認の線は Behavior と同じ」
   のとおりで、spec #949 story 10 の直接書きは撤回する。meta-review が直接無効化できるのは candidate だけ(Behavior と同じ)。
2. **提案の op は「置き換える」と「落とす」で分ける。** `consolidate` は replaces を1つの後継に置き換える提案で、後継は
   新しく書く candidate か、既にある approved・未無効化の Behavior / Exemplar(replaces の種別を問わない)のどちらか。
   `invalidate` は後継なしで落とす提案だけで、approved の Behavior と Exemplar を target に取り、理由の集合は種別で分けない。
3. **既存の後継も pin に入る。** 後継が無効化されれば提案は陳腐化する。ただし同じ entry への二重提案の拒否には入れない —
   A→R と B→R は両立する。
4. **question の detail は既存の後継の本文を replaces と同じ描画で載せる。** どちらを残すかを人間が見比べるため。

## なぜ代表化も承認の線の内側か

代表に寄せると、落ちる側の注釈は注入に届かなくなる。2つの Exemplar の注釈が重ならない限り、何を残すかは文言の取捨で、
承認と同じ種類の判断である。「後継の出所が残るので何も失わない」は注釈が完全に重なるときにしか成り立たない。

## なぜ既存の後継を名指せるのか

出所が同じ事例は新しい Exemplar に注釈の list を畳める。出所が違う事例は、anchor が1つの出所の記録の欄に結ばれる
(ADR 0153 決定3)ので1つの Exemplar に統合できない。一般化できれば kind behavior に畳めるが、一般化できない重複や、
既存の approved Behavior がすでに覆う事例は、決定1で直接書きを閉じると言い表す経路が無い — `invalidate` の理由コード
(`capability` / `environment` / `requirement_change`)はどれも重複を意味しない。Behavior 同士の重複も同じ穴を持っていた。

## なぜ `invalidate` でなく `consolidate` に入れるのか

記録に残る形はどちらも `superseded` + 後継で同じで、後継が新しいか既存かは出どころの違いでしかない。op の境界を意味の軸
(後継があるか)に引けば、人間が question で読む op が「置き換え」と「喪失」の区別をそのまま運ぶ。`consolidate` は既に
複数の replaces・pin・置換対象の detail を持ち、重複の N→1 をそのまま受ける。直接適用の側(`fold_memory` と
`invalidate_memory` の `superseded`)は同じ軸にまだ揃っておらず、#1033 で扱う。

## 退けた案

- **approved Exemplar の直接の `superseded` だけ残す** — 上の理由で、代表化は承認の線の外に置けない。
- **既存の後継を名指す形を作らない** — 出所の違う類似事例を畳めない。
- **`invalidate` に後継の欄を足す** — `invalidate` が「落とす」と「既存へ置き換える」を兼ね、`consolidate` と意味が重なる。
- **後継に種別の制限を掛けない** — Knowledge / Definition で事例を置き換えるのは種別の線を越える。
