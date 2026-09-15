# meta-review の直接適用は scope を引数で持ち、専用 verb は盤面が task を見て登録し、記憶の書き込みは書き手の task の記録に属す

2026-09-15 の grilling(issue #619 の実装着手時に見つかった前提の穴)で決定。周期の meta-review task は workspace null で
登録され(ADR 0120 決定2)、既存の `record_knowledge` / `define_memory_branch` は scope を task の workspace → 盤面の既定
workspace の順で解決する(issue #623)。#619 は「meta-review から呼ばれたら author を `meta_review` にする」とだけ書いていて、
そのままでは meta-review の書く記憶がすべて既定 workspace に落ちる。null に固定すれば workspace ごとの定義を直せず、既定
workspace のままでは他の workspace の記憶を取り違える — どちらも成り立たない。読み側(`browse` / `search` / `read`)にも同じ
穴があり、meta-review は他の workspace の INDEX を辿れない。現状の `file:line` と walk-through は issue #619 のコメントに置く。

## 決定

1. **meta-review の直接適用は専用の書き込み verb で、`scope`(workspace 名 or null = 盤面全体)を必須引数に持つ。** worker
   の verb は触らない(ADR 0120 決定2 の原文どおり「専用の書き込み verb」)。verb は4つ: `define_memory`(Definition の起草・
   改訂、`supersedes`)/ `fold_memory`(Knowledge の畳み: 新本文 + `replaces` を後継つき `superseded`、出所 = `based_on_decision`
   の decision event = 推論)/ `move_memory`(Knowledge の移動: 盤面が title・text・出所を写し、旧を `path_moved` で新へ指す)/
   `invalidate_memory`(#619。`path_moved` は受けない — 「本文は同じ」は LLM の申告でなく `move_memory` が保証する)。
   meta-review が Knowledge を新規に書く verb は無い(ADR 0120 決定1(c) と同じ線: LLM の推論を事実として店に入れない)。
   `scope` は registry の workspace 名と照合し、無ければ拒否する。#621 の consolidate の `text.scope` と同じ語・同じ null の意味。
   **承認の線は種別のまま**(ADR 0083 追記4): Knowledge / Definition は scope に依らず直接適用、Behavior は scope に依らず承認。
   盤面全体の Knowledge / Definition を人間が直接書ける非対称は今日すでにあり、意図された線である。**後継は別 scope でよく、
   検査は足さない** — 後継の検査の理由は「置換の連鎖が注入に届く側で止まらないこと」で、scope はそれを壊さない。
   `path_moved` の意味は「置き場(path / scope)が変わり本文は同じ」で、`superseded` との線は本文の異同だけ。
   読み口には4つ目 `list_memory_entries(scope?, kind?, state?, page)` を足す — 人間の面と同じ一覧(candidate・無効化済み・影に
   入った盤面全体の定義も返す)で、「両方を見る必要があるのは矛盾を見る人間と meta-review だけ」(ADR 0083 追記4)に忠実。
2. **主題つきの verb は、盤面が接続の task を見て登録する。** MCP server は接続ごとに task id を受けて組まれるので、
   `meta_review_subject = memory` の task にだけ #619 / #620 / #621 と本 ADR の verb を登録し、他の task の tool 一覧には
   出さない。Claude 側は `mcp__tidepool` をサーバ単位で開けたまま(ADR 0035 / 0038「verb の権限は盤面側が縛る」)、Codex 側
   は spawn ごとの `enabled_tools` に同じ差を写す。preflight probe は task 無しで繋ぐので基本の面だけを見、期待値は変えない。
   主題 `memory` の task には worker の memory verb(`record_knowledge` / `define_memory_branch` / `browse` / `search` / `read`)を
   登録せず、専用 verb で**置き換える** — `memoryScope` は既定 workspace が設定されていれば null-workspace の task をそこへ解決する
   ので、門ではなく非表示でしか塞げない(残せば meta-review が既定 workspace に author `worker_verb` の Knowledge を新規に書ける)。
   memory 系でない worker verb は残す。呼び出し時の DomainError の門は残す — tool 一覧は権限の境界ではない。spec #615 E の「BOARD_VERBS に入れるが他の task
   から呼べば DomainError」は ADR に無い spec の線で、story 48(非 RCA の worker に新しい verb を見せない)と矛盾していた
   ので改める。`propose_from_objection`(#616)も同じ規則に揃える(派生 issue)。
3. **記憶の書き込みは書き手の task の記録に属し、決定ログのエントリとして異議の対象になる。** ADR 0083 追記4 の「直接適用して
   決定ログに流し、人間は異議で戻す」は、`memory_entry_created` / `memory_entry_invalidated` が task に紐づかず異議も付けられない
   今の形では成り立っていない — meta-review にも worker にも同じ穴。原則を本 ADR で置き、実装(event の task 帰属、決定ログの
   表示、異議 → 帰責の接続)は派生 issue。自己申告(`log_decision` の規律)で代えない(ADR 0083 決定8 の線)。

## 退けた案

- **既存の worker verb に `scope` 引数を足し、主題外の task が渡したら拒否する** — worker の tool 面と schema を触り、
  決定2 の登録の差と二重になる。
- **盤面全体(null)の Knowledge / Definition だけ承認 question を通す** — 人間の注意予算を増やし、Knowledge / Definition が
  承認を要さない理由(置き場を左右し、判断も権限も左右しない)に scope は関係ない。
- **`browse` / `search` / `read` に meta-review だけが渡せる `scope` を足す** — worker 向け verb の schema を触り、影に入った
  定義を返さない(workspace が勝つ)ので #599 の「定義の矛盾」が見えない。
- **移動を「meta-review が本文を打ち直して新規作成 + 無効化」の2手にする** — 写し間違いが事実として残る。
- **workspace ごとに meta-review を1本** — ADR 0120 で既に却下。
