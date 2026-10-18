# 受験者は出題の head から fetch した自分の checkout で解く —— 面接室は root が組む場所、決着した受験者の checkout は記録として残る

2026-10-19 の grilling(issue #2239 —— #2193 の code-review の疑い)で決定。面接室は机が1つの部屋で、受験者が順に座る形だった
(ADR 0273 決定1)。机を片付ける機構は決着した兄弟のブランチの ref を外すこと(ADR 0263 決定5)と、その reflog と object を落として
答案を記録の器に写すこと(ADR 0266)だけで、境界テストの形で測ると同じ机の上に漏れが3つあった —— root や先の受験者が作った
ignored のファイルが作業ツリーに残る、question で止まっている(未決着の)兄弟のブランチから答案と WIP が `git show` で読める、
root のブランチの tree rule の WIP commit の件名が root の title(Interview の語)を運ぶ。ADR 0266 は「受験者ごとに fresh clone」を
「塞ぐ範囲に対して変える面が大きい」と退けたが、当時の漏れは1つで、変える面と挙げた3つのうち封じ込めの組と床の cwd は ADR 0273 の
`RunPlace`(name ≠ path)で既に受験者だけ別の形になっている。塞ぐ範囲が3つになり、1つの checkout のまま塞ぐと漏れごとに「外して戻す」
機構が増えるので、前提を変える。実測の表(3つの漏れ、gitlink、fetch の履歴)は #2239 のコメントに置く。

## 決定

1. **受験者は自分の checkout で解く。** 初回の pickup(タスクブランチが無い)で、盤面が面接室の**外**(`conventionCheckoutPath(受験者 id)`)
   に `git init` し、面接室から出題の head を fetch してタスクブランチを切る。`git clone` ではない —— clone は root のブランチごと運ぶ。
   再開(ブランチがある)は同じ checkout をそのまま使い、何も消さない —— 自分の ignored の生成物は自分のもので、中断中に兄弟が走っても
   自分の checkout には触れない。cwd はこの checkout で、読みに開く場所は無い(面接室も兄弟の checkout も床の外)。面接室の内側に
   置かない —— root の tree rule(`add -A`)が gitlink として取り込む(実測)。
2. **環境は出題の head だけ。** root が `.gitignore` で外したものは受験者に届かない。監査が判定したのは head であり、head の外にあるものは
   監査の目を通っていない。root が受験者に渡したいものは ignore しない —— `interview` type の注入(ADR 0275 決定3)に1行。
3. **走る場所の名前は root id のまま。** 受験者の fetch 元は面接室で、準備の失敗は面接室の性質なので、quarantine と封じ込めの組は
   ADR 0273 決定8 のとおり root id で立つ。ADR 0064 の ref snapshot の鍵だけは checkout(受験者 id)にする —— name を共有すると
   中断中の受験者の行を次の受験者が上書きし、再開で盤面自身の違反として立つ。
4. **決着した受験者の checkout は残す。** 面接室と同じ線 —— 監査・異議・retry の新しい root と人間が答案を読む記録で、消すのは人間の行為。
   ADR 0263 決定5 の ref 外し、ADR 0266 決定1(reflog expire / repack / prune)・決定2(bundle への写し)、`task_branch_removed` は
   要らなくなる。在り処は開いた時点の event で引く(面接室の `interview_room_opened` と同じ形)。ADR 0064 決定2 の例外は消え、
   タスクブランチは決着後も削除されない、に戻る。
5. **ADR 0266 決定3 の停止種別(盤面の記録の器が書けない)は残す。** 入口は transcript の open の1つになる(ADR 0149 追記1)。

## 退けた形

- **1つの checkout のまま塞ぐ** —— pickup ごとの `git clean -fdx`、未決着の自分のブランチを解放ごとに bundle へ写して外し再開で戻す、
  root のブランチを受験者の前に外して root の再開で戻す、ADR 0266 の掃除を受験者の pickup ごとに走らせる。漏れごとに「外して戻す」
  経路が増え、次の漏れでまた増える。
- **`git worktree`** —— ref と object store を共有するので兄弟のブランチが見える。何も閉じない。
- **bundle への写しを残して checkout を消す** —— 消す理由(兄弟から読める)が無くなったのに消す機構を持ち続ける。
- **受験者 id を走る場所の名前にする** —— 1人の準備失敗がその受験者だけの quarantine になり、ADR 0273 決定8 の単位が変わる。

## 帰結

- 未決着の兄弟のブランチの漏れ、root のブランチの漏れ、#2224(registry drift で残った未 commit を次の受験者が抱える)は機構ごと消える。
- ADR 0263 決定5・6、ADR 0266 決定1・2、ADR 0273 決定1・8、ADR 0064 決定2 の例外に Status 追記。CONTEXT.md「面接室」「Interview」
  「タスクブランチ」「盤面全体の停止」「Quarantine」の該当文を直す。
- `workspace_state` の鍵が変わる(既存の表の鍵)ので priority:high のまま。実装は `/to-spec` → `/to-tickets`。
- 面接室の作業ツリーは root の解放後 `main`(空)に戻り、監査・retry の root・人間が path を覗くと空に見える。監査の purpose は
  「出題の head で読め」と言っていて git 経由が前提だが、この grilling では触らず別 issue に置く。
