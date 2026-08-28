# タスクブランチの fork 元は系譜が決め、成果は切られた場所へ帰る

**Status: 決定3 の ff-only 着地と決定4 の事後検知の一点は ADR 0103 で置き換え済み** — 「ff できない = 帯域外の手作業」の前提は、盤面自身の着地が保護ブランチを進める直列運用(issue #468)で破れた。帯域外の判定は ff の成否ではなく盤面自身の ref snapshot との一致で行い、一致下の非 ff は Tidepool 名義の merge で追いつかせる。merge question を通る着地の形と「人間の手は分解ツリー1本につき1回」の線は維持される。

issue #220 / #228 のグリリング(2026-08-09)で決定。ADR 0052 の実環境動作確認 第1段 1-A で、
1つの穴の両側が同時に観測された。

**#228 側 —— 切られる場所が系譜を見ていない。** `ensureTaskBranch`(`src/workspace.ts:187`)は
`taskId` しか受け取らず、fork 元は無条件に `protectedBranchRef` である。したがってレビューの修理
タスクは**直すべきコードが1行も無いブランチ**の上に立つ。今回は worker(tako)が自分で気づき、正しい
fork 元を特定して `git merge --ff` で土台を作り直したから修理が着地した —— ADR 0033 が繰り返す
「モデルの判断は floor ではない」の線に照らせば、これは運が良かった観測であって動く仕組みの観測では
ない。同じ穴は完了時レビュー(レビュー対象がブランチに無い)、decompose の子(親の成果が見えない)、
そして **decompose の親の統合復帰(子たちの成果が1つも見えない —— ADR 0003 の中核経路)** にある。

**#220 側 —— 帰る場所が1つも無い。** remote を持たない `sandbox` で work タスクが完了するたび、
`promoteHandoffPr` が origin へ push を試みて偽の failure question を1本立てた。ゲートを足して
撃たなくすると、今度はその workspace の完了作業が保護ブランチへ到達する手段が**ゼロ**になる。実測では
`main` が init のまま動かず、後続タスク(1-B)を走らせるのに人間が `git merge --ff-only` を手で撃つ
しかなかった。registry の書き込みは purely-local の着地を持つ(`src/registry-write.ts:35`、ADR 0052
決定1)のに、**同じ概念が workspace のタスク作業側に無い**。

## 決定

### 1. fork 元は系譜が決める。保護ブランチは系譜が尽きたときの底である

```
fork元(task) =
  review タスク → 親のタスクブランチ(存在しなければ保護ブランチの参照)
  それ以外      → 候補 = 保護ブランチの参照。
                  系譜を**ルートから親まで下りながら**、work の祖先 A ごとに
                    A が未決着(統合幹として今も使われる)、または
                    `rev-list --count <今の候補>..task/A` > 0(候補へ未着地の独自コミットを持つ)
                  なら 候補 = task/A。最後に残った候補が fork 元。
```

**比較の相手は固定の保護ブランチではなく、そこまでで確定した候補である。** 決定2 が着地先を系譜依存に
した以上、「着地済みか」もそのタスク自身の着地先に対して問われなければ整合しない。保護ブランチに
固定すると、`task/P` へ merge back 済みの decompose 子 C1 が「保護ブランチには着地していない」と読まれ、
C1 のレビューの修理が**既に帰り終えた死んだブランチ** `task/C1` の上に立って座礁する(`task/C1` を
もう一度 `task/P` へ運ぶ機構は存在しない)。下りの1パスなら候補が `task/P` まで進んだ時点で
`rev-list task/P..task/C1` = 0 になり、修理は `task/P` から切られて統合が拾う。系譜の深さが1の
経路では候補が保護ブランチのままなので、この式は保護ブランチとの比較に退化する。

**review は書き込みの系譜に対して透明である。** 読むために親のブランチに立つが、fork 元を決める
下りの側からは type で飛ばされる。review の書き込み床は permission 層の `manual`(ADR 0035、
`src/claude-worker.ts:1709`)なので、review のブランチは独自コミットを**永久に持たない** —— 運ぶものが
無い中継点を系譜に数えない、というだけの規則である。question タスクは slot に入らないためそもそも
ブランチを持たず、同じ扱いに自然に落ちる。

`branch` は ADR 0023 のまま**参照**であり続ける。親のブランチ名は `task/<parent_id>` として系譜から
毎回導出されるので、ADR 0023 が拒否した「fork 事実の永続化」は発生しない。

判定を2条件の or にしているのは、**未決着の祖先と決着済みの祖先では「独自コミットを持たないブランチ」の
意味が逆だから**である。purpose を読んで即 decompose した親のブランチは差分ゼロだが、それは「まだ何も
無い」であって着地済みではない —— ここで着地判定だけを使うと、子が統合幹から切り離される。逆に決着
済みの祖先の差分ゼロは、本当に運ぶものが無いことを意味する。

### 2. 着地は fork 元の双対である —— 帰る先は、そのとき規則が指す場所である

| 完了時に規則が指す場所 | 着地 |
|---|---|
| 祖先のタスクブランチ | そのブランチへ **merge back**。PR も question も立たない |
| 保護ブランチ | remote-backed → PR(今日どおり) / purely-local → 決定3 |

「切られた場所へ帰る」は言い方としては正しいが、**盤面は切られた場所を記録しない**。完了時に決定1の
規則をもう一度走らせ、そのとき指された場所へ帰る(ADR 0023 の「参照であって fork 事実ではない」の
完全な延長)。

**再計算は記録より厳密に正しい。** 系譜の着地状態は、そのタスクが走っている間に**正当に動く**からで
ある —— 付帯子は親を塞がない(ADR 0049)ので、次が起きる:

1. P が decompose し、子 C1 が完了して `task/P` へ merge back される
2. C1 に完了時レビュー R が付き、R が修理 F を生む。R も F も C1 を塞がず、C1 は done のまま
3. **C1 が done なので P は unblock され、R と F が走っている最中に統合復帰して完了し、着地する**
4. その後 F が完了する

pickup 時の fork 元(`task/P`)を記録して読めば、F は**既に着地し終えた** `task/P` へ merge back して
座礁する。再計算なら、P の PR が未 merge のときは候補が `task/P` に戻って**開いたままの PR が更新され**、
merge 済みのときは候補が保護ブランチのままなので F が自分で PR を開く —— `task/F` は着地済みの
`task/P` から切られているので、その PR の差分はちょうど F の分だけになる。

merge back は完了時にのみ走る(escalate / watchdog 失敗の slot 解放では走らない —— 帰すべき成果が
まだ無い)。順序は `releaseTree` → merge back → `parkOnProtectedBranch` で、WIP コミットが先に
タスクブランチへ載ってから帰る。

**ff-only では撃たない。** 正当な非 ff が起きる —— C1 が escalate で中断している間に C2 が完了して
親ブランチを進め、その後 C1 が再開して完了する順序では、C1 の merge back は真の merge になる。
コンフリクトは `releaseWorkspace` の同じ try に入るので **workspace の quarantine** に落ちる
(CONTEXT.md の Quarantine が既に契機として挙げる「slot-release tree rule 自体の失敗 —— コンフリクト
や破損など」と同じ行き先)。

この決定は既存の穴を1つ閉じる。今日は decompose の子の完了が個別に base=保護ブランチの PR を開き、
`merge: auto_if_ci_green` なら**親が統合検証を終える前に無人 merge されうる**(`src/merge.ts:41`)。
ADR 0003 が「完了イベントは実際に基準が満たされた時にのみ流れる」と決めた線が、merge の側では守られて
いなかった。子が PR を開かなくなることで、**PR の粒度 = 説明責任の単位 = 完了基準の全体を覆う単位**が
一致する。

### 3. purely-local な workspace では merge ダイヤルが効かず、着地は常に人間の merge question を通る

merge ダイヤル(authority profile の `merge`)の3状態はいずれも purely-local で根拠を失う。

- `auto_if_ci_green` —— CI の緑を根拠にするが、purely-local にその観測は存在しない。観測不能を緑と
  読まない(Throttle の「使用率が観測不能な間も throttled」と同じ fail-closed)。既存の risk_flag の
  倒し(`src/tasks.ts:1490`)と同型で、**倒した理由を question の本文に書く** —— 「auto_if_ci_green に
  したつもりが効いていない」が黙って起きることはない。
- 省略 —— 「盤面の外(GitHub)で merge する」ことを意味するが、purely-local にその面が無い。
- `escalate` / 保護 workspace —— そのまま question。

回答が `merge` なら盤面が保護ブランチへ `merge --ff-only` する。ff で撃つのは ADR 0052 決定7 と同じ
理由で、ff できない = 帯域外の手作業で保護ブランチが動いた、なので quarantine。question が立つのは
**fork 元が保護ブランチだったタスクだけ**なので、人間の手は分解ツリー1本につき1回である。

`hold` は**恒久的な「着地しない」決定**とする。成果はタスクブランチに残り、盤面はもう提示しない。
remote-backed の open PR が持つ「保留された着地」の永続的な面は、purely-local には存在しない ——
これは非対称を自覚のうえで受け入れる。#220 が報告した「経路が1つも無い」とは質が違い、こちらは
**人間が明示的に選んだ結果**であって、Pause の「明示的な意思の放置は放置ではない」と同じ線に乗る。

`promoteHandoffPr` に `isRemoteBacked` のゲートを足すが、これは他の事前条件と同じ**skip ではなく分岐**
である(purely-local では PR の代わりに着地 question が立つ)。strict=true(issue #66 の retry)は
到達不能になる —— retry ボタンは PR 昇格の failure question にしか現れず、その question が立たなく
なるためである。

### 4. worker がタスクブランチの土台を動かすことは検知しない

tako の `git merge --ff` は救済だったが、規則が直れば土台を動かす**理由**が消える(observed pain over
speculation)。加えて:

- **列挙による禁止は既に失敗と結論済み**である。`REVIEW_BASH_WRITE_DENIALS`
  (`src/claude-worker.ts:221`)は review 専用で、work 側に `Bash(git merge*)` を足しても同ファイルの
  コメントが認めるとおり `sh -c` で抜けられる。
- **検知は fork 事実の記録を要求する。** 「土台が動いたか」を言うには保護ブランチとの merge-base の
  不変性が要り、ADR 0023 が「盤面は再起動するので永続化が要り、しかもブランチ移行シナリオで誤動作
  する」として降りた側へ一歩戻る。
- **事後的な検知は追加機構なしで手に入る。** purely-local の着地は ff-only なので土台が動いていれば
  落ち、merge back のコンフリクトも quarantine に落ちる。

issue #234 が提案する不変条件(「タスクブランチは worker が変更してよい唯一の ref」)とは**重ならない**。
tako が動かしたのは自分のタスクブランチであり、#234 の下では合法である。両者は独立に決まる。

## 根拠

**1. レビュー対象は「そのタスクが産んだ差分」であり、タスクブランチはその恒久記録である。** タスク
ブランチを削除するコードは存在せず(`gh pr merge --merge` に `--delete-branch` は無い ——
`src/github.ts:182`)、GitHub 側で自動削除されてもローカルの `task/<id>` は残る。したがって PR が
merge 済みでも `merge-base(<protectedBranchRef>, task/work)..task/work` で完全な差分が読める。
review の fork 元を「着地済みなら遡って保護ブランチ」にしてはならないのはこのためで、それをやると
レビュアーは main のツリーだけを渡されて差分を失い、fugu が `git show` による静的レビューしか
できなかった状態へ戻る。**review が要るのは「読む位置」、work が要るのは「書く土台」であり、1つの
述語には畳めない。**

**2. 「PR が merge された後のレビュー修理」は例外ではなく普通の姿である。** 完了時レビューは付帯子
なので親を塞がず(ADR 0049)、`auto_if_ci_green` は CI が緑になった時点で merge する。決定1の type
飛ばしがこの経路を正しく処理する —— 修理は review を飛ばし、着地済みの work でも候補が動かないので
**現在の保護ブランチ**から切って自分で PR を開く。未 merge なら `task/work` から切って merge back し、
**開いたままの PR が黙って更新される**。同じ1つの規則が両方を出す。

**3. purely-local の非対称は purely-local 特有ではなかった。** merge ダイヤルの省略は remote-backed
でも「盤面は着地させない、人間の帯域外操作に任せる」であり、GitHub の merge ボタンがその穴を埋めて
いただけである。#220 が観測した「人間が `git merge --ff-only` を手で撃った」は、その帯域外操作の
裸の姿だった。省略の意味が定義されていないこと自体は authority profile の宣言主義の問題なので
**issue #235 として切り出した**。本 ADR の決定3はその結論に依らず成立する。

**4. 統合復帰は fork 規則だけでは直らない。** 親のブランチは decompose の前に作られ、統合復帰は既存
ブランチを checkout するだけである(`ensureTaskBranch`)。子の成果が親のブランチへ届く経路 ——
決定2の merge back —— が別に要る。副産物として、後続の兄弟が先行兄弟の成果の上で作業できるように
なる(ADR 0047 の「1本の時系列」のブランチ版)。

## Considered options

- **系譜を review / repair に限った特例にする** —— 影響範囲は最小で、子の PR 差分の問題も起きない。
  しかし #228 のコメントが確定させた decompose の子と親の統合復帰は直らないまま残り、規則が
  「タスク種別で分岐する」形になる。
- **worker への明示指示として作法を文書化する(現状維持)** —— tako が実際にやった救済を作法にする
  だけであり、ADR 0033 の「モデルの判断は floor ではない」に正面から反する。
- **子も PR を開くが base を親のタスクブランチにする(stacked PR)** —— 差分は子の分だけで綺麗になり、
  merge back を GitHub 側へ委譲できる。しかし CONTEXT.md の Branch discipline が言う保護ブランチの
  3役のうち「PR の base」まで外れ(決定1で fork 元の役は既に系譜へ譲っている)、かつ purely-local
  には PR が無いので盤面のローカル merge 経路が結局必要になり、**着地が2経路になる**。決定2の
  merge back は purely-local と remote-backed で同一である。
- **merge back 先が無いブランチについて、タスク type を問わず盤面が PR を開く** —— 決定1で review を
  型で飛ばす前は、「PR merge 済みのレビュー修理」が `task/review` で行き止まる問題があり、その処理
  として検討した。review タスクの完了が PR を開くことになるが、透明化でこの行き止まり自体が消えた
  ため不要になった。
- **review タスクは自分のブランチを持たず、親のブランチ上で走る** —— fugu の観測が最も直接的に消える
  が、`review_allowed_commands` で `npm test` を許した場合の生成物を `releaseTree` の `git add -A`
  (`src/workspace.ts:319`)が拾い、**親のブランチに WIP が載る**。編集不可でもツリーは汚れる。
- **レビューの修理子を review ではなく被レビュー work の子にする** —— 行き止まりが消えるが、ADR 0046
  と CONTEXT.md の Review「修理の決着後、統合復帰したレビューが直りを見届けてから完了する」を壊す。
- **purely-local では完了時に盤面が無条件で ff merge する** —— `commitToRegistry` の purely-local
  着地(ADR 0052 決定1)と同型で人間の手はゼロ。しかし保護ブランチが人間の判断を1度も通らずに動き、
  完了時レビューが見つけた欠陥は**常に**「merge 済みコードの修理」になる。根拠2の経路が purely-local
  の既定の姿になってしまう。
- **purely-local では `auto_if_ci_green` を登録時に選べなくする** —— 宣言と挙動の乖離を入口で塞げる。
  しかし `merge` は agent の profile 単位、purely-local は workspace 単位であり、profile は
  `allowed_workspaces: ["*"]` を持ちうる。禁止を成立させると**新しい purely-local workspace の登録が
  既存の profile を遡って不正にする**という、他エンティティの編集で壊れる不変条件になる。
- **未着地のタスクブランチを盤面上に一覧として持つ**(`hold` の受け皿)—— open PR の等価物を作れるが、
  Board / キュー / Decision log のどれでもない4枚目の面を v1 に足すことになる。痛みはまだ観測されて
  いない(#220 の観測は「選べなかった」であって「hold したら見失った」ではない)。
