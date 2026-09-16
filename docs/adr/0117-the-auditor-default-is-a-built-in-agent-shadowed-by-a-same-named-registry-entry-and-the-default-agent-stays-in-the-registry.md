# Auditor の既定は盤面の組み込み agent であり registry の同名エントリに shadow される — 既定 agent は registry に残る

2026-09-12 の grilling(issue #540、ADR 0110 / 0111 からの切り出し)で決定。実行設定が agent 定義を離れた(ADR 0110)後、既定 agent と
Auditor の registry エントリに何が残っているかを一つずつ当てた。本文は両方とも空(ADR 0017 / 0089)。fugu で生きている値は
`skills: ["@workspace"]` と icon / description だけで、profile は ADR 0013 が code 定数にして読まれていない。tako で生きている値は
`authority: standard` — その profile(merge ダイヤル・assignable_to)は Condensation と人間が信頼の成長に応じて広げる編集面である。
実装の測定と `file:line` は #540 のコメントに置く。

## 決定

1. **組み込み(Built-in)agent を導入し、Auditor の既定 `fugu` をそれにする。** 盤面の code が frontmatter 相当(`skills: ["@workspace"]`、
   icon、description、provider は省略 = ADR 0116 の展開)を運び、profile は ADR 0013 の reviewer 定数のまま — 授権は増えない。種まき
   (ADR 0089)は auditor の2ファイルを書かなくなる。
2. **名前の解決は registry が先、無ければ組み込み(shadowing)。予約名にはしない。** registry に `agents/fugu.md` があればそれが fugu で、
   消せば組み込みに戻る。正本は「registry が先」の1規則で、表示(built-in / shadows built-in の印)は機械の解決を映すだけ。作成の扉は
   同名を拒まないが shadow を告げる — 静かな shadow は作らない。組み込みは削除の対象にならない。ADR 0087 決定3 の「ポインタの指す先は
   消せない」の唯一の例外として、shadow しているエントリは消せる(消えても組み込みに落ちるだけで事故にならない)。
3. **既定 agent `tako` は registry に残る。** code に畳むと既定 agent の権限を広げる経路が消える。ADR 0089 決定3 の「自由に書かせて思いがけない
   使い方が生まれる方を取る」は撤回する — generalist の本文は構造的に空である(担当範囲は「全部」、盤面全体の好みは Behavior 宛先 全員の
   領分で、agent 1体の本文に書くとスコープを誤る、制約は profile、手順は skills)。空は ADR 0017 の正規形であり、キャンバスではない。
4. **役割ポインタ2つ(`TIDEPOOL_AGENT` / `TIDEPOOL_AUDITOR`)は env のまま残す。** 自作 agent への付け替え(ADR 0019 の「役割の付け替えは
   ポインタの差し替え」)を費用ゼロで保つ。frontmatter の盤面別編集に価値は無い — provider は省略が中立値(ADR 0116)、tier の盤面別既定は
   拡張なので痛みの観測待ち。
5. **workspace 単位の既定 agent は作らない。** ADR 0031 の棄却(場所キーはタスクの性質を表現できない)を維持する。

## 退けた案

- **tako も code に畳む(定義も profile も)** — Condensation の主ループが既定 agent に届かなくなる。
- **定義は code、profile だけ registry** — code が registry のファイル名を参照する片割れで、削減にならない。
- **組み込み名を予約名にする** — 気に入った名前で自作の Auditor を持てなくなる。shadowing なら1規則で同じ安全が出る。
- **同名の2体を表示で区別する** — 名前は識別子(assignee / review_by / worker_id / Behavior の宛先)で、機械が区別できないものを表示は区別できない。

## 帰結

- ADR 0087 決定3 の規則に例外が1つ、ADR 0089 決定3 の根拠は撤回、決定4・5 の auditor 分は組み込みが引き受ける。ADR 0020 の当時版は
  組み込みでは registry commit に無く、spawn 記録の定義版が盤面の版を運ぶ。

  **2026-09-16 追記(issue #568 の実装で判明)**: 盤面に「版」は無い —— `package.json` は `private: true` で `version` フィールドを
  持たない。そのため `worker_spawned.definition_version` が組み込みの spawn で運ぶのは版ではなく固定文字列 `"built-in"` であり、
  Episode の「当時の agent 定義の版」欄が言うのは「registry に無い = 盤面の code が定義を持っていた」ことだけである。盤面の版が
  必要になったら、それは `package.json` に版を持たせるという別の決定になる。
- 専門 agent の本文の存在価値は未観測(唯一の実測は fugu の A/B)— 最初の専門 agent が現れたときの問いとして別 issue に置く。
