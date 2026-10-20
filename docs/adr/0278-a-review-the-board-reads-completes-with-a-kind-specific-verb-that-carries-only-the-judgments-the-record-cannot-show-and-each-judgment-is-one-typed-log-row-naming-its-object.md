# 盤面が完了を材料として読む review は種別ごとの完了 verb で終わり、verb が運ぶのは記録が示せない判断だけで、判断1つが対象を名指す判断ログ1行になる

2026-10-19 の triage / grilling(issue #1919)で決定。worker が task を終える verb は種別によらず汎用の `complete_task` 1つで、
`completeTask` が見るのは work の handoff と未決着の子だけだった。統合レビュー・RCA・memory / routing の meta-review は、種別固有の
仕事(判定・所見・candidate やセルの判断)をしたかを盤面に見られずに done になれ、「何もしなかった完了」と「判断した結果、何もない
完了」を盤面も人間も区別できないまま、後続の機構(受理と配分評価、第2回の帰責、材料の窓の消費)がその完了を材料として読んでいた。
実測(`file:line`)と各種別の例は #1919 のコメントに置く。先例は Interview の出題の監査(ADR 0273 決定4)——review type のまま
種別を構造で見分け、`complete_task` を伏せて専用 verb で判定を値で残す。

## 決定

1. **完了を盤面の機構が材料として読む review の種別は、種別ごとの完了 verb で終わる。** 統合レビュー(受理と配分評価が読む)、
   RCA(第2回の帰責が読む)、memory / routing の meta-review(材料の窓を閉じる)。線は列挙ではなく性質で引き、読み手が人間だけの
   review(root の独立監査、親を名指した review 子)は汎用の完了のまま。verb の差し替えは `taskVerbSwap`(ADR 0122 決定2)で、
   domain はその種別への `complete_task` を扉を問わず拒む(ADR 0253 決定5 の線)。type は増やさない —— 権限面が review と同じなので
   review の中の種別である(ADR 0272 決定2)。
2. **判断は項目ごとに閉じた語彙の値で、「何もない」も値である** —— memory `left_as_is`、routing `no_change`、RCA `no_proposal`、
   統合レビュー `no_findings`。任意の1行 `reason` を添えられ、文は盤面が「<値>: <対象> — <reason>」の形で組む。
3. **verb が運ぶのは記録が示せない判断だけ。** 記憶の書き込みの行(ADR 0252)、提案 question、candidate の作成、修理子は記録が
   既に持つので二度申告させない。盤面は 被覆 = 判断を要する項目 − 記録の行為 を計算し、項目の一覧を材料の節に注入する(必ず読むものは
   注入、ADR 0180)。不足と材料に無い id は何も記録せず拒み、拒否文は id を名指す。**行為済みの項目への値は受け取り、何も記録せず、
   応答にも書かない** —— 記録を優先すれば矛盾は残らず、完了の verb は session を終えるので応答の読み手はいない。
4. **判断1つは型つきの `decision_logged` 1行になり、対象を名指し、文は盤面が組み、完了と同じ transaction で書く**(出題の行と同じ形)。
   ADR 0252 決定2「行の単位は verb の呼び出し1回」の根拠は判断1回 = 1行であり、書き込みの verb が判断を1つ運ぶから一致していた ——
   完了の verb は判断を N 個運ぶので N 行である。Interview の採点が N 個の値を受験者側に置くのは対象が task だからで、ここでの対象
   (candidate・エントリ・行・agent・段・異議されたエントリ・成果物)は task ではないので、行は review 自身に置く。
5. **種別ごとの項目。** memory: 被覆は残高でなく窓で切る —— 窓で起草された candidate、窓で決着した提案が名指す candidate / エントリ、
   Objected decisions が cause `memory` で名指すエントリ、窓の店の変更、配下にエントリを持つ定義の無い枝、複数 scope が定義した path。
   読み手は今どおり残高を読み、どの candidate にも行為できる。routing: 項目は材料の行ではなく評価の対象 —— 窓の乖離 shadow 行で走った
   行、初観測のセル、人間が変えた行、配分評価の集計に現れる agent(agent の段の出所)と段(task の段の出所)、学習器。提案は op で
   対象に写す(`row` / `add_tier` は行、`agent_tier` は agent、`tier_description` は段、`promote` / `demote` は学習器、`interview` は根拠
   session が走った行)。RCA: 項目は**所見**(`entries` + `root_cause`)で、材料の各エントリがちょうど1つの所見に入る。`proposed` は
   この RCA が立てた candidate から、`repair` はこの RCA の子の有無から導き(所見が2つ以上で子が1つなら RCA 単位の近似)、どちらも
   無い所見に `no_proposal`。第2回の帰責は所見の行を読む。統合レビュー: 項目は成果物1つ、`findings` は必須、修理子が無いときだけ
   `no_findings` の印が要り、`repaired` は修理子から導く。受理は今どおり done から導き(ADR 0111)、配分評価は verdict と findings を
   この行から読む。
6. **`complete_task` は type を問わず handoff の `outcome` を必須にする**(work は今の全欄のまま、人間 assignee の完了は免除)。review と
   memory_repair だけが空で done になれたのは同じ穴で、人間登録の review と記憶の修理子の産物は findings そのものである。

## 退けた案

- **`complete_task` に種別ごとの必須欄** —— 名前が1つのままでは Codex の `enabled_tools` に差を写せない。
- **verb が全判断を運び盤面が記録と照合する**(RCA の `consequence`、routing の提案 id、統合レビューの `verdict` 欄)—— 記録が持つ
  行為を欄で言わせ、欄が記録と食い違える。食い違いを拒めば agent は追跡の手間と再呼び出しを払う。
- **完了1回 = 1行** —— 異議が判断を名指せず、#1915 の修理の対象が引けない。
- **memory の被覆を残高全件にする** —— 変化の無い candidate 全件に毎周期同じ行が付き、流し読みを定型文で埋める。
- **routing の項目を材料の行にする** —— 配分評価の集計行はセルを名指さず、「集計行に no_change」という不自然な申告になる。
- **行為済みの項目への値を拒む / 無視した旨を応答に返す** —— 指示に従っただけの呼び出しを拒んで token を使わせ、返しても読み手がいない。
- **`outcome` 必須を review だけにする** —— memory_repair にも同じ穴がある。線は type ではなく「agent の完了は判断を運ぶ」。

## 追記2(2026-10-19 の grilling、issue #1915 / ADR 0279)

決定6 の「`complete_task` は type を問わず `outcome` 必須」は第5の type `routing_repair` にも当たる。決定5 の memory / routing の項目に、
窓で異議された同主題の判断の行が名指す対象(生きているもの)を足す(ADR 0279 決定5)。

## 追記3(2026-10-19 の grilling、issue #2285 / ADR 0280)

決定5 の RCA の「`proposed` はこの RCA が立てた candidate から、`repair` は子の有無から導く」は、記録が RCA を名指さなかった(self と
auditor の RCA は同じ異議群を材料にする)ので成り立たず、ADR 0280 に改めた —— 行為は RCA の task に帰属する記録から読み、所見の行は
行為(書いた記憶・子)を列挙して `no_proposal` だけを値に持つ。決定3 の「candidate の作成は記録が既に持つ」は、この記録が持つと読む。

## 追記4(2026-10-19 の triage、issue #2292)

決定3 の「材料に無い id は拒む」の材料は、spawn 時に注入した項目の一覧 —— `meta_review_material_injected`(ADR 0180)に項目を記録し、
完了の verb はそこから読む。実装は完了時に項目を今の店から計算し直しており、spawn から完了までに他の worker が書いた未定義の枝を
`unjudged` で、人間が引退させた注入済みの candidate への値を `not items to judge` で拒んでいた(観測は #2292)。項目の全体は注入時の
記録(再 spawn なら最新の記録 —— agent が読んだ表)で、今の計算は**絞り込みにだけ**使う: 開いている項目 = 注入した一覧 ∩ 今も項目で
あるもの − この review の行為。注入済みの項目に spawn 以後、誰であれ記録が示す行為があれば「行為済み」として値を受け取り記録しない
(決定3 の「記録を優先」をこの review の行為に限らない)。注入した一覧に無い id / path への値は、この review 自身が upTo の後に書いた
ものでも拒む —— 一覧を読み違えた合図で、拒否文が名指すので1回で閉じる。退けた案: 凍結して引退済みに `left_as_is` の行を書く(偽の
判断ログ)、今の再計算のまま拒む(agent が何もしていないのに再呼び出しを払う)。

## 追記5(2026-10-20 の grilling、issue #2284)

決定5 の routing の項目「初観測のセル」は「初観測のセルの、今の表の行」に改め、routing の項目は 走った行・人間が変えた行・初観測の行 の
和集合(鍵は行)と agent・段・学習器にする。1つの (provider, model, effort) が属する段は1つ(ADR 0200 決定5)なので、セルの行はどの
瞬間にも0本か1本で、セルの判断は常にその行の置き方に帰着する。`row` 提案の鍵はセルの鍵と同じ3欄で、`row` / `add_tier` / `interview`
はどれも今の表の行を要求するので、行の無いセルには routing の verb が届かない。人間が行を足して同じ窓で走ると行の項目とセルの項目が
重なり、字義どおりだと `no_change` が2行になる(決定3「二度申告させない」の線)。帰結: verb の鍵から `cell` が消え、op の写しにセルの
規則は要らない。advisor 違いの2セルは同じ行の項目1つ。行の無い初観測のセル(人間が行を消した)は項目にせず材料で読むだけ —— 届く verb
が無い対象の値は強制された `no_change` で、判断ではない(ADR 0280 の「値は何もない側だけ」)。行の項目の鍵は (provider, model, effort)
の3欄で段を含めない —— 段は鍵から決まり、spawn 後の段の移動は `execution_settings_changed` が行為済みにする。段は注入の一覧と判断ログの
文に盤面が添える(今の表の段)。乖離 shadow 行の actual のセルが「走った」かは、その pickup が開いた session の有無で読み(配分評価と
同じく episode を辿る)、session に辿り着かなかった shadow 行は走っていないので項目にしない —— schema は変えない。走った行もほかの行の
項目と同じく今の表の行で、spawn までに人間が消した行は届く verb が無いので項目にしない。ADR 0279 決定4 の「セルを名指す行には…」と決定5 の
routing の「セル」は、セルを名指す判断の行が無くなるので空文になる。退けた案: セルを別の項目のままそのセルの行への提案で覆う
(重なりの二重申告が残る)、字義どおり別に申告させる。

## 追記6(2026-10-20 の grilling、issue #2326 / ADR 0282)

決定5 の memory の枝の項目「複数 scope が定義した path」は外し、「配下にエントリを持つ定義の無い枝」は (path, scope) の単位 —— 欠けて
いる scope ごとに1項目、盤面全体のエントリがその path かその下にあれば (path, 盤面全体) の1つだけ。決定4 の枝の判断の行も (path, scope)
を名指し、決定3 の被覆は定義の (path, scope) と動いた行の scope で数え、盤面全体への行為はどの scope の項目も覆う。

## 追記7(2026-10-20 の grilling、issue #2331 / ADR 0284)

追記2 の「窓で異議された同主題の判断の行が名指す対象(生きているもの)」の枝の「生きている」は、その scope の無効化されていないエントリ
(candidate も)が path かその下にあること —— 決定5 の構造の項目「配下にエントリを持つ定義の無い枝」(approved の木)とは読みが違う。

## 追記8(2026-10-20 の triage、issue #2335)

決定3・追記4 の「注入した一覧に無い id は拒む」は、窓の前に起草された candidate や窓で変わっていない approved の Behavior / Exemplar
—— 読み手が残高で読み行為できるが項目でない対象 —— にも当たる。それらへの scope の変更(狭める・workspace 間・approved の scope)を
正しいと判断した据え置きは `complete_memory_review` の reason では言えず、ADR 0176 決定8 のまま `log_decision` で、エントリ id(枝なら path と scope)と判断した
scope を名指す1行に残す(#1186 の観測が数える語彙)。#2283 の purpose の差し替えは項目の場合だけで、項目でない場合を言い落としていた
(domain 層で再現)。型なしの行は異議されても次の周期の項目に戻らない —— op を作るかは #1186 の観測待ちのまま。
