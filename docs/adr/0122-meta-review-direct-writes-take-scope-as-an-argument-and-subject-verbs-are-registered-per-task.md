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

## 追記(2026-09-30 の triage / grilling、issue #1209)

**読み口に5つ目 `list_memory_branches`(枝の一覧)を足す —— 全 scope を通して枝ごとに1行、その path の Definition と、配下に
エントリを持つ scope を並べる。** 決定2 が worker の memory verb を置き換えたので meta-review には木を返す読み口が無く、purpose が
運ぶ「未定義の枝」の検査(ADR 0083 追記8)は、平らな一覧の全ページから path を組み直すしかなかった。未定義の枝には行が無いので、
`list_memory_entries` の行への印では運べない。

退けた案「`browse` / `search` / `read` に scope を足す」の理由のうち、「影に入った定義を返さない」は ADR 0178 決定6 で影ごと
無くなった。残る「worker 向け verb の schema を触る」は、専用の verb にすれば当たらない。

- **読み手ごとの木ではなく、盤面の枝の一覧にする。** ADR 0178 で path は誰が読んでも1つの意味なので、木を読み手ごとに分けて
  返す理由が無い。「複数の workspace が同じ path を定義している」(ADR 0178 決定8)は、定義が2つ以上並ぶ行としてそのまま出る。
- **「どの scope で未定義か」の印は返さない。** 行の2つの欄の差でしかない。印が中身を持つのは、workspace の定義だけがある
  path に別の workspace のエントリもある場合だけで、そこで印は「その workspace に定義を書く」へ誘導する —— 複数の workspace が
  同じ path を定義する形を作る手である。要るのは、既にある定義の下にその leaf が合うかの判断。
- **配下の件数は返さない。** ADR 0083 追記8 が落とした「子が1つの枝」の検査の材料になる。
- **枝を作るのは approved で未無効化のエントリだけ**(宛先は問わない)。worker に見えている木の検査で、candidate は承認されて
  から数える。定義の無い枝への書き込みは拒否しない(ADR 0083 追記4)ので、承認の瞬間に未定義の枝ができても禁じた形ではない ——
  ADR 0178 の門が candidate を数えるのは、承認で禁じた形ができるからで、理由が違う。
- **ページを持たず、全件を1応答で返す。** 他の読み口が共有するページ長から外れるのは、木の全体が要る読み手だから —— 置き場
  違いの移動先も、同じものを持つ枝も、木を通して見ないと判断できない。行は短く、枝の数は履歴ではなく店の語彙で伸びる。
- **leaf は `list_memory_entries` の `path` の絞り込み(その枝と配下)で読み、枝の一覧には載せない。** 見る枝が決まった後の
  読みで、店の総なめは減らさない —— そちらは #1226。
- **人間の面(管理MCP)にも同じ読み口を出す。** 決定1 の「人間の面と同じ一覧」と同じ線。WebUI の viewer は #1219。

名指された id を読む口が無い点は #1225。tool 応答の上限の実測は #1209 のコメントに置く。

## 追記(2026-09-30 の triage / grilling、issue #1225)

**読み口に `read_memory_entries(ids)` を足す —— 名指された id の行を返し、Behavior / Exemplar は case 描画ごと返す。** 決定2 が
worker の `read_memory` を置き換えたので、meta-review には id で読む口も case を読む口も無かった。purpose は cause `memory` の
Precedent が名指す entry を「読め」と言い(ADR 0166 決定5)、`propose_memory_change` は Exemplar の注釈の引用を case の欄から
逐語で写せと言うが、本文を返すのは一覧のページだけで、case はどの verb も返さなかった。実測は #1225 のコメントに置く。

- **case を同じ口で返す。** case を要る仕事 —— 名指された Behavior / Exemplar の判断、candidate を Exemplar に畳むときの注釈、
  事例の重複の判断 —— はどれも「一覧で id を得て、選んだものを読む」形で、id を鍵にした読み口は1本で足りる。一覧の行には
  載せない(1ページ分の handoff が tool 応答の上限を超えうる)。
- **専用の verb にし、一覧の `ids` の絞り込みにも、worker と同じ名前にもしない。** 絞り込みは case も鎖のたどりも運べない。
  `read_memory` は「読んで従った記憶」の列(Precedent の `entries_read`、帰責の入力 —— ADR 0166 決定2)が数える verb で、
  meta-review が読む行は判断の材料であって従う指針ではない(meta-review は spawn 注入を受けない)。別の名前なら、一覧と同じく
  seen にだけ入る。
- **本文が同じ鎖(`path_moved`・復元の複製)だけ末尾までたどり、`requested_id` を添える。それ以外の無効化は行そのものを本文ごと
  返す。** 書き込みの verb は生きた id しか受けないので、移された行は手を打つ相手が末尾になる —— meta-review 自身が同じ run で
  枝ごと移した後にも起こる。ADR 0167 と同じ「本文が同じならたどる」の線で、違いは2つ: 視界の門が無い(一覧と同じ全 scope・
  全宛先・全状態)ことと、`dropped` の代わりに本文を返すこと —— worker に本文を返さないのは視界の線で、meta-review は無効化
  済みの行も読む(決定1)。
- **存在しない id は黙って落とさず `missing` に返す。** worker の「黙って落とす」は視界の外を見せないためで、門の無い読み手には
  当たらない。
- **件数の上限もページも持たない。** 応答の上限を超えるかは件数でなく case の長さで決まり、件数の上限では防げない。上限で
  弾かれた応答の pull も記録に残る点は #1229。
- **Exemplar の注釈の原文は返さず、一覧3 verb と過去の提案の修正値も同じ側に揃える。** meta-review は注釈の原文を書けず
  (schema が拒む)、読んで使う先が無い —— #1052 が現状維持とした点を改める。
- **`list_precedents` の `entries` に本文は載せない。** case ごと載せれば1ページが応答の上限に近づき、名指された id は
  1呼び出しで読める。後継・置き換えた id・提案が名指す id も同じ口で読む。
- **人間の面(管理MCP)には出さない。** 管理MCP の一覧は全件を1応答で返すので id の行は今も拾え、case は行の出所の event
  から preview で引ける(帰責 event も通る)。
