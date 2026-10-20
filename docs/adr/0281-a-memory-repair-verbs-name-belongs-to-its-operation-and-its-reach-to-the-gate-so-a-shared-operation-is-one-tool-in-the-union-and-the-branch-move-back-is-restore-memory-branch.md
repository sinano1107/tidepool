# 記憶の修理子の verb は名前が操作に付き、射程は門に付く —— 同じ操作の verb は和の組でも1つ、枝の移し戻しは `restore_memory_branch`

2026-10-20 の grilling(issue #2304、元 #1915 / ADR 0279)で決定。ADR 0279 決定3 は、同じ memory meta-review の書き込みの行と判断の
行の両方に異議があれば修理子は1本で「verb は和」とした。書き込みの行の修理 verb 5本と memory meta-review の書き込み verb は
`invalidate_memory` / `move_memory` / `move_memory_branch` の3つで名前が同じで中身が違い、MCP の `registerTool` は同じ名前を2回登録
できず、Codex の `enabled_tools` も名前の集合なので、和の組がそのままでは作れない。3つの名前は ADR の決定ではなく code の写しである ——
ADR 0252 決定4 は操作を「逆操作・置き換え・移動」と呼び、ADR 0272 が名指す verb は `replace_memory` だけ。実測(`file:line`)は #2304 の
コメントに置く。

## 決定

1. **verb の名前は操作に付き、射程(触ってよい対象)は門に付く。** 同じ操作で射程だけが違う verb は、どの組でも1つの tool で、入力の形は
   広い側(meta-review 版)。門は対象で切り替わる —— 対象が異議された書き込みの射程にあれば修理の規則(移し戻しは門なし、ADR 0252 決定4)、
   異議された判断の行が名指す対象にあれば meta-review の規則。1本の修理子の中で2つの射程は互いに素 —— 判断の行は `left_as_is` だけで、
   その task 自身の行為は項目から引かれる(ADR 0278 決定3)—— ので、どちらの規則で動くかは対象で一意に決まる。これに当たるのは
   `invalidate_memory`(後継なしで落とす)、`move_memory`(エントリを移す —— 両版が同じ門と同じ移動を呼ぶ)、`move_memory_branch`
   (枝を移す・統合する)の3つ。
2. **書き込みの行の修理の「移動」は枝ごとの移動を含む。** ADR 0252 決定4 の「移動 —— meta-review の直接の移動と同じ門(ADR 0176)」の
   ADR 0176 は枝ごとの移動を含むが、code はエントリ1件の `move_memory` しか写していなかった。それでは「定義を書いた枝を別の名で呼べ」
   「bar でなく baz へ移すべきだった」の方向コメントが実行できない —— Definition の path は枝ごとの移動でだけ変わる(ADR 0176 決定3)。
   **書き込みの射程で枝は枝の単位で判定する**: その書き込みが path に Definition を作った、または path かその下へエントリを移したなら、
   その枝は射程で、配下に書き込みが触っていない leaf があっても枝ごと動く —— 判断の行が枝を名指すときの meta-review 版と同じ振る舞い。
3. **別の操作は別名で、組によらない。** 書き込みの行の修理の「枝の移し戻し」(その書き込みが移したエントリだけを元の scope と path へ戻す、
   後から来たエントリは残す、門なし)は `move_memory_branch`(枝の改名・統合)と操作が違うので `restore_memory_branch` と呼ぶ ——
   `restore_memory`(落としたエントリを元どおりに戻す)と同じ、逆操作の名前の形。書き込みの行だけの修理子でもこの名前。
4. **片側にしかない verb の射程は和の組でも広げない。** `restore_memory` / `replace_memory` / `restore_memory_branch` は書き込みの射程のまま、
   `define_memory` / `fold_memory` / `propose_memory_change` と読み口は判断の行の修理子の形のまま。和は verb の集合の和であって射程の融合
   ではない —— ADR 0252 決定4 は書き込みの行の修理を3操作に限り、ADR 0279 決定3 は判断の行の修理を meta-review の verb に限る。

## 退けた案

- **3つとも1つの tool で振り分け、枝の移し戻しも `move_memory_branch` に抱える** —— 枝の tool が `to_path` の有無で2つの操作を抱え、
  入力の形が操作を言わなくなる。
- **meta-review 版を優先する** —— 書き込みの行の枝の移し戻しが消え、ADR 0252 決定4 の逆操作が欠ける。
- **和の組でだけ修理側を別名にする** —— 同じ操作の名前が束の中身で変わる。未公表なので互換の名前は守らない。
- **枝の移動は運ぶエントリ全件が射程のときだけ** —— 定義を書いた枝に既存の leaf があれば拒まれ、改名の方向コメントに直す手段が無い。
  「射程はエントリの集合」は写しの都合で、決定の理由ではない。

## 帰結

- 書き込みの行だけの修理子の verb は6本: `invalidate_memory` / `restore_memory` / `move_memory` / `move_memory_branch` /
  `restore_memory_branch` / `replace_memory`。和の組は16本(meta-review の13本 + `restore_memory` / `restore_memory_branch` / `replace_memory`)。
- 書き込みの行だけの修理子でも `invalidate_memory` の入力は meta-review 版(`rejected` を含む)になる。「`rejected` は candidate だけ」の
  門は、対象がどちらの射程にあっても1つの tool が掛ける —— 書き込みの射程にも candidate は入りうる(`restore_memory` が戻した candidate の
  写しなど)ので、meta-review 側の門に任せるだけでは書き込みの射程で `rejected` が通る。
- 同じ線は routing_repair(#2305)にも当たるが、routing の読み口と提案 verb は routing meta-review の verb そのもので、別の射程の同名 verb
  が無い。
- 追記する ADR: 0279 決定3、0252 決定4。

## 追記(2026-10-20 の grilling、issue #2330 / ADR 0285)

決定2 の「判断の行が枝を名指すときの meta-review 版と同じ振る舞い」のうち、盤面全体へ広げる向きは修理子には開かない —— 書き込みの射程で
通った枝の `move_memory_branch` も、行き先の scope は移動元と同じ。決定2 の理由(改名・移し替えの方向コメントを実行できること)は scope を
変えない移動で満たされる。
