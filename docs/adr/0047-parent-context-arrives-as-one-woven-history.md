# 親の文脈は1本の年表として届く

issue #179 で決定。ADR 0045 の実装スコープ(issue #171、未実装)が子へ渡すはずだった文脈は
**2つの別々の束**だった — 親の decision log(`EventRow[]`。id と created_at を持つ)と、親の
settled 子(`SettledChildContext[]`。title / status / handoff doc だけで、時刻も、どの分解判断
から生まれたかも持たない)。子の側から2つを噛み合わせる手段が無く、親が統合復帰して方針を
変えた後に生まれた子は、どの判断が自分の根拠でどれが既に破棄された計画なのかを判別できない。
最悪、古い計画に従う。ADR 0045 が「記録は在るのに届いていない」と診断した穴が、その処方箋
自身の中に残っていた。

盤面は既に答えを持っていた。`registerTask` は decompose の子に `based_on_decision` — その子が
乗っている decision log エントリの event id — を刻んでいる(`src/events.ts:59`、
`src/tasks.ts:1576`)。**構造の線は在るのに、注入がそれを運んでいなかった。**

## 決定

**1. 2つの束を1本の `history` に織り、`get_current_task` はそれを渡す。** 各エントリは
キー1つで自分を名乗り、`based_on_decision` は**入れ子**として綴られる:

```jsonc
// C(decompose の子)から見た親の history
"history": [
  { "child_outside_the_decomposition": { "title": "Q1", "status": "done", … } },
  { "decision": "<分解理由の本文>",
    "children": [ { "title": "A", "status": "done", "handoff_doc": "…" },
                  { "title": "B", "status": "done", "handoff_doc": "…" } ] },
  { "child_outside_the_decomposition": { "title": "R(修理)", "status": "done", … } },
  { "decision": "<次の分解理由>", "children": [ { "title": "C", "you": true, … } ] }
]
```

並び順は event id(`decision_logged` / `task_completed` / `task_registered` は同じ `events`
テーブルの単調増加 id を共有する)。`decision` の `children` の中も同じ。**時刻は一切載せない**
(下記の決定3)。

エントリ形は3種で、3つ目の `completion` は**親が done のときにだけ**現れる。そしてその状態は
必ずこの形になる — done な親は未完了の子を持ったまま完了できず(`completeTask`、
`src/tasks.ts:691`)、完了後は slot に入らないので decompose もできないため、done な親が後から
獲得する子は完了時レビューと ADR 0046 の修理タスクだけであり、どちらも単独エントリで、
どちらも `task_completed` より後の event id を持つ:

```jsonc
// 修理タスク R(ADR 0046)から見た、done な元タスクの history
"history": [
  { "decision": "…", "children": [ … ] },
  { "completion": "<完了基準に対する結果1行>" },
  { "child_outside_the_decomposition": { "title": "R", "status": "in_progress", "you": true } }
]
```

`completion` が運ぶのは結果1行だけで、handoff doc は `parent.handoff_doc` が運ぶので重複しない
(決定6)。

子の payload は依頼内容三つ組 + status を基本に、**`SettledChildContext` が今日運んでいる型
ごとの形をすべて引き継ぐ** — done な work の `handoff_doc`、done な question の `items` /
`answer` / `comment`、cancelled な子の `origin_question`(どの abandon が計画を終わらせたか。
`src/tasks.ts:2117`)。`settledChildren` を丸ごと置き換える改修なので、引き継ぎを明示しておく —
黙って1フィールド落とすことは、まさに ADR 0045 が存在する理由の失敗である。

**2. `history` はタスク1つの性質であり、自タスクにも親にも同じ形で当てる。** 同じ穴は
統合復帰する親・retry セッションにも開いており(自分の decision log と自分の settled 子が
やはり2つの束で届く)、片方だけ直すと同じ payload の中に「織られた年表」と「別々の2束」が
同居する。`settledChildren` + `taskDecisionLog` を別々に呼ぶ現在の形は1関数に置き換わる。
自タスクの `history` では自分が根なので `you` は現れない。

**3. 運ぶのは出自であって時刻ではない。** 「親が `D2` を書いたとき B の結果を読んでいたか」は
盤面の不変条件から導出できる — 親は未決着の子を持つ間 blocked であり、MCP の全 verb は slot
タスクとの一致を要求する(`src/mcp.ts:249`)ので、blocked な親も done な親も decision エントリ
を書けない。したがって `D2` を書いた親セッションは、`D1` で登録された子が全て settled になった
後にしか存在しえない。時刻を並べると worker は時刻で推論し始めるが、それを支える材料(子の
完了時刻)は線の上に無く、中途半端な時系列が戻る。順序が事実である。

**唯一の例外は人間 decompose の連続**。`assertHumanDecomposable`(`src/tasks.ts:1654`)は
「未決着・実行中でない・agent の decompose 判断に基づく子をまだ持たない」しか見ず、`blocked` は
`todo` の表示状態にすぎないため門を通る。人間が2回続けて decompose すると、1回目の子が未決着
のまま2回目の分解理由が書かれる。限界として受け入れる — この例外を作れるのは人間だけで、
その分解理由を書くのも人間本人であり、自分が何を読んだ上で割ったかを知っている書き手である。

**4. `history` は settled 子ではなく全ての子から組む。** 未決着の兄弟も title / purpose /
completion criteria / status で現れる(handoff は存在しないので運ばない)。理由は2つ。
(i) 現在のタスク自身が `you` として必ず線の上に1つ現れるという保証がこれに依る — `you` の
不在から「自分は分解判断に基づかない」を導かせる設計は、ADR 0041 / 0044 の「不在は宣言する」
に反する。(ii) `D2` が C と C2 を同時に出したとき、C2 を隠すと C には「`D2` は自分1人を出した」
と読める。C2 の存在は C が自分の担当境界を越えないための材料であり、ADR 0045 決定4 が定めた
外化そのものである。`settledChildren` の除外理由(「走っている兄弟を見せると干渉を招く」)は
内容を見せる場合の話で、そもそも worker には他タスクへ手を伸ばす経路が無い。

**5. 兄弟は依頼内容も運ぶ — title / purpose / completion criteria + status。** ADR 0045 決定4 は
外化のチャネルを2本(子の purpose と分解理由)定めたのに、届く配線は分解理由の1本しか作られて
いなかった。「C2 はこの範囲を引き受ける」という外化は、それを読むべき C に永遠に届かない。
量の懸念は ADR 0045 が決着させている(全文・切り詰めなし、肥大は分解粒度の兆候)。GitHub 展開は
1回も増えない — 子タスクは issue-backed になれないため(`src/api.ts:576`)、live 展開が要るのは
今日と同じく自分と親だけである。

**6. 親の `handoff_doc` の review ゲートを外す。** 今日 `handoff_doc` は `type === "review"` の
ときだけ渡る(`src/mcp.ts:344`)。handoff doc は完了したタスクにしか存在しないので、ゲートが
実際に効くのは「親が done なのに子が走っている」場面だけ — 完了時レビュー、独立監査、そして
ADR 0046 の修理タスクである。type の線はこの3つ目を取りこぼすためだけに存在しており、修理
タスクは直すべき成果物の記録を読めない。

**7. 人間 decompose の分解理由を必須にする(issue #129 の任意の線を撤回)。** 案 B の下では
分解理由の**有無そのもの**が構造的な主張になる — 理由の無い子は
`child_outside_the_decomposition` として現れ、盤面が「この子はどの分解計画にも属さない」という
事実でないことを主張してしまう。issue #129 が「割り方が自明なら書かなくてよい」と決めたのは、
理由が散文としてのみ読まれるという前提の下だった。前提が変わった。加えて、決定3 の例外
(blocked な親への人間 decompose)で「自分が何を読んだ上で割ったか」を残せる場所は分解理由
しかない。**人間 decompose の門は2枚ある** — WebUI / `/api`(`src/api.ts`)と管理MCP(ADR 0032 が
v1 の面に人間 decompose を含めている)— ので、必須化は両方に効かせる。片方だけ直すと、
盤面が嘘のラベルを出す経路が1本残る。

**8. 視界は親1ホップのまま。** 年表を1本にしたことで、その年表が親1人分しかないことは目立つ
ようになるが、拡げない。「なぜ親が存在するか」は親の purpose が既に運んでおり(ADR 0045
決定4 の外化)、運んでいないならそれは注入の穴ではなく外化の失敗である。深さには自然な停止点が
無く、祖父を入れるなら曾祖父を排する理由が要る。観測された痛みが先。

**9. 読み方は `get_current_task` の description に置く。** エントリごとの散文は持たせない
(同じ文言が毎エントリに繰り返される)。description が綴るのは3点だけ — `history` は上から
時系列に読むこと、`decision` の `children` はその判断に基づいて登録された子であること、
`child_outside_the_decomposition` はどの分解判断にも基づかない子(人間の異議から生まれた
修理タスク、このタスク自身の escalation、watchdog の失敗質問など)であること。

## #171 の実装スコープへの効果

- **項目1(親の settled 子を視界に追加)** — 範囲が拡大(決定4: 未決着の兄弟も)し、内容が
  拡大(決定5: 依頼内容も)し、形が `history` に置き換わる
- **項目3(親の decision log を全子へ開放)** — 形が `history` に置き換わる。あわせて
  `handoff_doc` のゲートも外す(決定6)
- **項目4(settled 子の文脈に question の purpose を追加)** — 決定5 の内容三つ組に吸収される
- **項目2(自タスクの decision log を全タスクに注入)** — 決定2 により `history` として実装
- **項目5(再開の合図 = WORKER_PROTOCOL の静的1行)** — 影響なし

## Considered options

- **`SettledChildContext` に `based_on_decision`(event id)を載せ、平坦なまま子に join させる
  (issue の案1)** — 認知負荷を worker 側に置く形であり、「文脈が届く」という ADR 0045 の
  目的に対して半分しか働かない。加えて `EventRow` の生の形(`task_id` / `worker_id` / `kind`)が
  worker の面に出続けることを追認する。
- **分解理由の本文を各兄弟のエントリに同梱する(id を渡さない)** — 同じ本文が親の log と兄弟
  エントリの2箇所に出る。ADR 0045 が退けたのは「取りに行かせる」形であって、同じ payload の
  中での突き合わせは取りに行くことではない。
- **完全に平坦な1本のリストにし、`kind` で各エントリを名乗らせる(「`child` = 直前の decision に
  基づく」)** — 冗長は同じく消えるが、「基づく」が順序に化け、決定3 の不変条件に寄りかかる。
  今日は成立するが、`based_on_decision` の値をそのまま写す入れ子は不変条件が崩れても嘘を
  つかない。認知負荷もむしろ高い(「`D1` から生まれた子はどれか」に前方走査が要る)。
- **settled 子に完了時刻を載せる / 1本の時系列に interleave する(issue の案2)** — 決定3。
  順序が既に構造的事実であり、盤面が並べ方を決め打ちしているわけではない。
- **現状維持 — 親が「A・B の結果を踏まえて」と分解理由に書く作法に委ねる(issue の案3)** —
  順序は盤面が直接観測できる構造的事実であり、散文の規律に委ねる理由が薄い。
- **人間 decompose の理由を任意のまま残し、理由なしの分解を第3の形
  (`{ "decision": null, "children": […] }`)で綴る** — 既存の決定を覆さずに済むが、エントリ形が
  増え、「値が常に null のフィールド」という一度退けた綴りが戻る。人間が1行書くコストのほうが
  安い。
