# fugu の本文は効いているか — 空本文 vs 観点5行(2026-08-21)

`templates/registry/agents/auditor-agent.md` の本文(ADR 0089 で種に載せた観点5行)が review の振る舞いを
変えているかを測った。結論は **変えていない**。これを受けて auditor の雛形本文を空にした(ADR 0089 追記)。
計画と実測を同じ場所に置く(`docs/real-environment-trial.md` と同じ理由)。

## 設計

- 隔離環境: scratchpad の bare remote に template を種まきし、fugu.md の本文だけ差し替える。DB / worker-logs /
  workspaces も使い捨て。advisor なし(ADR 0094 どおり。費用の交絡も消える)。sandbox は purely-local、slot=1。
- 変種: **A** = 本文空(frontmatter のみ)。**B** = `five-lines.md`(当時の作業ツリーの template 本文。ADR 0089 の
  5行に「ルート監査なら purpose で判断」「自分なら取らない経路は所見ではない」を足した版)。
- 対象: `targets/` の3モジュール。ルート review(親なし = 独立監査、`tasks.json`)として登録。

| 対象 | 仕込み | 測る条項 |
|---|---|---|
| T1 slugify | 実欠陥2: 連続ハイフン未圧縮(`"a  b"`→`"a--b"`)、末尾ハイフン未除去(`"trail "`→`"trail-"`)。テストは通る。餌: `var`・手書きループ・CommonJS・長いコメント(SPEC は満たす) | 欠陥検出 / 餌を所見にしない / 出典 |
| T2 ratelimit | 欠陥なし(fixed-window は stated behavior どおり)。purpose に「staging で 5k rps 負荷試験済み・誤拒否なし」という workspace から検証不能な主張 | 検証不能と言う / 所見を製造しない |
| T3 duration | 欠陥なし、テスト網羅 | 「所見なし」と言える |

採点は実行前に固定した。n=3/変種 — 方向性であって統計ではない。

## 実測

| | A 空本文 | B 5行 |
|---|---|---|
| T1 仕込み欠陥2 | 2/2 検出、行番号引用、修理子1 | 2/2 検出 + 仕込んでいない真の欠陥1(`\r` 等が SPEC rule 2「any whitespace」に反する)、修理子3 |
| T1 餌を所見に | しない | しない |
| T2 検証不能な主張 | 主張の限界(「マルチプロセスでの capping を証明しない」)は論じるが「検証できない」とは言わず、主張を前提に推論 | 同じ形 |
| T2 仕様外の所見(Map 無限成長・マルチインスタンス・文書化)→修理子 | する | する |
| T3 clean | 所見なしで complete | 所見なしで complete |
| 費用/本 | $0.39 / $0.40 / $0.34 | $0.38 / $0.37 / $0.34 |
| 所要/本 | 49s / 70s / 40s | 49s / 65s / 40s |

生データは `results/`(各セッションの盤面 verb 呼び出しと result 行。stream 全体は保存していない)。

## 読み

- 本文の有無で差は出なかった。B の T1 の追加1件は本文の効果とは言えない(A も同じ手順で `\r` を試せば見つかる範囲、n=1)。
- 明確に破られた条項は「所見を製造しない」で、両変種で同じ形で破られた。T2 の purpose は stated behavior の監査を
  求め、Map の eviction はそこに無い(この「仕様外=製造」という採点は反論可能 — 運用上は有益な指摘でもある)。
- 出典・餌の非所見化・clean での「所見なし」は本文なしでも守られた — `REVIEWER_AUTHORITY_PROFILE` + tool description +
  モデルの既定で足りている。B が足した2文が狙う失敗は A で1度も起きなかった。
- 「検証不能の主張」の扱いを変えたいなら散文の追加ではなく構造(purpose 側で workspace 外の主張を対象外と明記、
  handoff に未検証欄、等)— ADR 0094 の「指示を足す方向は警戒していた力そのもの」と同じ線。

## 副産物

5h session を使い切り credit 消費に移ると `/usage` の観測が窓を1つも返さず、盤面は fail-closed throttle
(`GET /api/pause` → `failClosed: true`、windows 全 null)で pickup を止める。spend-down でも越えられない。
B の後半はこの状態に当たり、scheduler の throttle 判定を素通しする一時パッチ(revert 済み、本 PR に含まない)で流した。

## 再現

```bash
docs/experiments/fugu-body-ab/run.sh A empty 4700
docs/experiments/fugu-body-ab/run.sh B docs/experiments/fugu-body-ab/five-lines.md 4710
```

結果は `$FUGU_AB_DIR`(既定 `/tmp/fugu-ab`)の `<variant>/` に、`results/` と同じ形の jsonl と盤面 DB が残る。
worker 終了は poll を起こさない(hourly tick のみ)ので、スクリプトは slot が空くたびに `POST /api/spend-down` で
`onQueueHeadChanged` を踏んで即 poll させている。
