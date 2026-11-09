# drift の観測者は走る前なら pickup の門、走った後なら後始末であり、verb は拒むだけ —— 完了の門は名前が解けないときも tip の記録を待って `done` にしない

2026-11-09 の grilling(issue #3094、ADR 0359 の派生)で決定。work の `complete_task` は verb の前に task の workspace 名を registry から解いて
門に渡すが、名前が解けない(drift)と `resolveOrQuarantine` が Quarantine を立てて `undefined` を返し、門は走らずに verb が `done` を記録し、
後始末は `workspace: null` を受けて解放を丸ごと飛ばす。tip は名前の場所に着かず、worker の commit は task の checkout にだけ残り、Quarantine の
受理がやり直す merge back は古い `task/<id>` を運ぶ —— ADR 0359 決定1 の「`done` ⇔ tip が記録にある」が 1 つの帯域外の registry 編集で
fail-open になる。門の失敗の扱いが失敗の性質でなくコードの位置で割れていた: 解決は門の try の外なので ADR 0084 決定2 の「解決できない →
スキップ」、fetch / `update-ref` は中なので ADR 0359 決定1 の拒否。ADR 0084 決定2 のこの箇条だけ Status 追記が無く、前提(門は clean の読みだけで
記録に書くものが無い)は ADR 0356 / 0359 で消えていた。drift を Quarantine にする手は pickup の門・verb の副作用・後始末・起動時の復旧の 4 箇所に
散り、後始末の「完了なら解き直さない」(ADR 0274 決定3)は verb が撃ったという導出に依っていた。到達は帯域外だけである —— 削除の扉は
`in_progress` を含む未決着 task が持つ workspace を拒み、改名の扉は無い。実測と `file:line` は #3094 のコメントに置く。

## 決定

1. **名前の場所の解決は完了の門の一部であり、解けなければ ADR 0359 決定1 の DomainError で拒む。** 「盤面が tip を記録へ置けない」事象の持ち主は
   1 つで、名前が解けないのもその 1 形である。`done` ⇔ tip が記録にある、は drift でも破れない。ADR 0084 決定2 の「解決できない → 門をスキップ」は
   task の checkout には掛からない。
2. **verb の時点では drift に資源の停止を登録しない。** ADR 0359 決定4 の「verb の失敗は拒むだけ」を、署名の有無でなく「session が slot を握る間この
   workspace の pickup は無く、後始末が一歩あとに同じ drift を必ず観測するので、verb で登録しても止まるものが無い」という理由で drift へ広げる。
   走った後の drift の観測者は後始末 1 人(再起動の復旧も同じ経路)、走る前は pickup の門 1 人。verb で撃たないので、後始末が `done` から
   「撃ち済み」を導く例外(ADR 0274 決定3)と、呼び直すたびの `quarantine_refired` は要らなくなる。
   読む verb も同じ —— Interview の root の envelope(`get_current_task`、監査 review の写し)が実環境の名前を解く手は登録せず、解けなければ
   `real_environment` を載せないだけである。
3. **門を持つ verb は記録へ書く手を持つものだけ**(work の `complete_task`、`pose_probe`)。監査・Interview の完了は前倒しの解決を持たず、後始末が
   escalate と同じく最初の観測者になる。`runReleasingVerb` の不変条件は「門を渡さずに `done` へ決着した」から「完了の門が掛かる task が門なしに
   `done` になった」に絞る。
4. **後始末が drift で解放を飛ばすとき、開いた記録に task の checkout があれば、立てる Quarantine の理由にその在り処を書く。** 盤面は残した成果を
   運ばない —— drift は扉を迂回した人間の操作で、その後始末も人間の手で足りる(`KEPT_TASK_CHECKOUT` の形)。worker への拒否文にも同じ在り処を
   載せ、escalate を指す(`pose_probe` の `ESCALATE_UNFIXABLE` の形)。

## 退けた形

- **点修正**(解けなければ拒むだけ)—— verb の Quarantine と ADR 0274 決定3 の例外を温存し、呼び直すたびの `quarantine_refired` を別に塞ぐ手が要る。
- **pickup で名前の場所の在り処を記録に pin し、門と後始末は記録を読む** —— ADR 0009 が退けた形。退けた根拠のうち「mid-task drift は扉で塞がれ
  帯域外でしか起きない」は今も立つ。後始末の merge back・休止位置・remote 追従は entry の宣言(branch / repo)を読むので、pin は path でなく
  registry entry の写しになり、ADR 0020 の「読むのは committed main」と割れる。
- **Quarantine の受理で残した checkout から tip を fetch する** —— 読み手は帯域外の操作をした人間 1 人で、人間の手で足りる。

## 派生

- Status 追記: ADR 0084 決定2、ADR 0274 決定3、ADR 0359 決定4。GLOSSARY.md: Quarantine、task の checkout。
- #3062(`PlaceNotOpenError` の兄弟分岐)は持ち主が違う(盤面自身の開いた event)ので傘下に入れず、triage の推奨どおり対象外で close。
- 実装は 1 slice、#3094 のコメントが spec。
