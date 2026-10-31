# ponytail-review は新しい context で review 強度で回し、implementer は残して修正も当て、ponytail 本体は上流の本文に repo の frontmatter だけを付けて使う

2026-10-31 の grilling(issue #2763)で決定。PR #2762 の skill 更新で、ponytail-review は over-engineering 専用の review から、
正しさ・安全・負荷・テストまで見る review になった。ponytail 本体も上流で全面的に書き直された。`/code-review` の2軸
(Standards = 規約と smell、Spec = 要求との一致)は、誤った結果・データ損失・競合・テストの欠落を探さない。そのため正しさを
見る review は、implementer の自己レビュー1回しか無かった。計測(直近の PR の指摘、コメントの数)は #2763 のコメントに置く。

## 決定

1. **ponytail-review は `/implement` の review 段階で、新しい context の sub-agent が回す。** Standards / Spec と並ぶ3本目の
   報告で、軸をまたいで並べ替えない。書いた本人の context では、自分の思い込みを検算できない。
2. **ponytail-implementer は残し、自己レビューを持たせない。** 定義の本文は sub-agent の system prompt(Codex では
   `developer_instructions`)に載る。「ponytail で実装する」の持ち主を、呼ぶ側の書き方と無関係に1か所に置く。
3. **review の指摘は親が判定し、同じ implementer に続けて当てさせる。** 届かないときだけ新しく呼び、そのことを PR に書く。
   親の thread には ponytail が入らないので、親が当てると修正だけが規則の外で書かれる。commit は実装と修正の2段になる。
4. **implementer の「やらなかったこと・確かめていないこと」は review 役に渡さない。** 親が filing step と PR に回す。
   決定1 の理由(書いた側の見方を持ち込まない)を保つ。
5. **review 強度(`/implementation-delegation`)は3本すべてに効く。**
6. **ponytail 本体は上流の本文を使い、repo 独自なのは frontmatter だけ。** 入口を限る description と
   `disable-model-invocation` を残す。Persistence は上流の文のまま。
7. **設計の段階(grilling / spec / triage)では ponytail を使わない。** 梯子の1段目は、頼まれていない選択肢を省き、曖昧な依頼には
   最小の版で応じるよう求める。選択肢を並べて比べる設計の仕事とぶつかる。この前提は 2026-08-20 に `workflow.md` に予測として
   書かれただけで、ADR は無かった。
8. **コメントは上流の「コードからは読めない why だけを1行で」に従う。記録された決定に由来する why は宛先(`ADR N 決定M`)を
   名指す。** 宛先の規約は repo 直下の `CODING_STANDARDS.md` に置き、implementer と `/code-review` の Standards 軸が読む。
   ADR 番号は、書き換えの前にコードからの引用を数える grep の宛先になる(`docs/agents/domain.md`)。宛先だけで why を書かないと、
   読み手は理由を知るために ADR を開くことになる。既存コメントの扱いは #2764。

## Considered options

- **ponytail-review を implementer の自己レビューのまま残す** — 正しさの検算が、書いた本人の context の中だけになる。
- **ponytail-implementer を消し、task prompt の1行で ponytail を読ませる** — 規則が system prompt から task prompt に下がり、
  持ち主が呼ぶ側ごとに散る。
- **ponytail 本体を上流と完全に同じにして lock に戻す** — 自動で追従でき、`/implement` の外で書くコードにも効く。一方で、
  model が設計の session でも呼べるようになり、一度入ると session の終わりまで残る。`/implement` の外のコードにも ponytail を
  入れたくなったら、これが反転条件。
- **コメントの1行の上限を外す** — why を保ったまま短いほうが、読むたびのトークンが少ない。
- **宛先の規約を ponytail 本体に足す** — ADR 番号を宛先にするのはこの repo の規約で、手を抜く規則ではない。
