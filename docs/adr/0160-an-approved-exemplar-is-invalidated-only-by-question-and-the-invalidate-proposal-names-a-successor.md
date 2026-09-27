# approved の Exemplar の無効化は question だけを通り、提案 op invalidate は後継を名指せる

2026-09-27 の grilling(issue #1029)で決定。meta-review の直接の無効化は approved の gate を Behavior にしか掛けておらず、
approved の Exemplar を question なしに任意の理由で無効化できた。提案 op invalidate は Behavior しか target に取らず、
Exemplar の無効化を人間に問う経路は無かった。spec #949 の story 10 は冗長な事例を `invalidate_memory` の `superseded` +
後継で引退させるとしていたが、question を通さない根拠はどの記録にも無い。コードの調査は #1029 のコメントに置く。

## 決定

1. **approved の Exemplar の無効化は、`superseded` を含めて question を通る。** ADR 0153 決定1「承認の線は Behavior と同じ」
   のとおりで、spec #949 story 10 の直接書きは撤回する。meta-review が直接無効化できるのは candidate だけ(Behavior と同じ)。
2. **提案 op invalidate は approved の Behavior と Exemplar を target に取り、`superseded` のときは後継を名指す。** 後継は
   approved で未無効化の Behavior か Exemplar で、target の種別を問わない。理由の集合は種別で分けない。
3. **後継も pin に入る。** 後継が無効化されれば提案は陳腐化する。ただし同じ entry への二重提案の拒否には入れない —
   A→R と B→R は両立する。
4. **question の detail は後継の本文を target と同じ描画で載せる。** どちらを残すかを人間が見比べるため。

## なぜ代表化も承認の線の内側か

代表に寄せると、落ちる側の注釈は注入に届かなくなる。2つの Exemplar の注釈が重ならない限り、何を残すかは文言の取捨で、
承認と同じ種類の判断である。「後継の出所が残るので何も失わない」は注釈が完全に重なるときにしか成り立たない。

## なぜ後継の欄を足すのか

出所が同じ事例は `consolidate` で注釈の list を1つに畳める。出所が違う事例は、anchor が1つの出所の記録の欄に結ばれる
(ADR 0153 決定3)ので1つの Exemplar に統合できない。一般化できれば `consolidate` の kind behavior に畳めるが、一般化できない
重複や、既存の approved Behavior がすでに覆う事例は、決定1で直接書きを閉じると言い表す経路が無い — 既存の理由コード
(`capability` / `environment` / `requirement_change`)はどれも重複を意味しない。Behavior 同士の重複も同じ穴を持っていた。

## 退けた案

- **approved Exemplar の直接の `superseded` だけ残す** — 上の理由で、代表化は承認の線の外に置けない。
- **後継の欄を足さず、代表化は `consolidate` だけにする** — 出所の違う類似事例を畳めない。
- **後継に種別の制限を掛けない** — Knowledge / Definition で事例を置き換えるのは種別の線を越える。
