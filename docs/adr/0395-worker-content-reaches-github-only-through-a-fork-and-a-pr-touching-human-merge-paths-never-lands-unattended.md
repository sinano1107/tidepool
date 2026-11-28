# worker の内容は PR の出元 repo(fork)を通ってだけ GitHub に出て、人間が merge する path に当たる PR は無人で着地しない

**Status 追記: 決定4 の外せない既定に `.claude/agents/**` と `.codex/agents/**` が加わる** —— agent が名指した subagent 定義は保護ブランチから読んで worker に届けるので、無人 merge で載った定義を正本にしない([ADR 0446](0446-a-subagent-definition-the-agent-names-reaches-the-worker-rebuilt-from-the-keys-the-board-allows.md) 決定3、2026-11-28、issue #4038)。

**Status 追記: 決定3 の宣言の扉が「写しのまだ無いタスクブランチだけ送る」(#3605 の追記)の写しは、宣言中の fork に盤面が最後に push した値の記録で、fork ごとに repo id で持ち、出元 repo の差し替えでも外しでも消さない。前に使った fork へ戻る扉と、外した後に置き直す扉も、盤面が一度送ったタスクブランチを送り直さない。決定2 の覚えた出元 repo の畳みは、前方向も行を書くだけになり、行き先の検査が畳む([ADR 0422](0422-what-the-board-last-pushed-to-a-head-repo-is-kept-per-fork-by-repository-id-and-a-head-repo-change-does-not-forget-it.md)、2026-11-26、issue #3851)。**

**Status 追記: 決定3 の「出元 repo が宣言されたとき `task/*` を出元 repo へ送る」から、宣言の repo の記録が今の宣言と食い違う task のブランチを外す —— 別の repo で登録し直した名前の checkout に残る、旧い repo の内容である。出元 repo の記録の食い違いでは外さない([ADR 0419](0419-a-repo-disagreement-is-read-from-the-records-at-the-entrance-of-a-task-bound-operation-and-a-first-branch-cut-compares-the-record-of-its-fork-source.md) 決定7、2026-11-25、issue #3849)。**

**Status 追記: App `tidepool-board` は公開(Any account)を前提とする —— 非公開の App は作った account にしか install できず、決定6 の出元 repo の所有者(org)に install できない。2026-11-21 に公開へ変えた。秘密鍵は broker だけが持ち、token は認証したユーザーが push 権を持つ repo にしか出ない(ADR 0093 決定2)ので、他人の install は盤面の token を与えない(issue #3482)。**

**Status 追記: 帰結の未測定のうち「base 限定の installation token で出元 repo を head にした PR を作れるか」は、private では作れなかった。PR の作成は盤面にログインした人間の user token で行い、それ以外の PR の操作は宣言の repo の token のまま([ADR 0396](0396-the-board-opens-a-pr-from-the-head-repo-with-the-logged-in-humans-user-token-and-does-everything-else-with-the-declared-repos-installation-token.md)、issue #3569)。**

**Status 追記: 2026-11-22 に App `tidepool-board` に Repository permission の Administration: Read-only を足し、installation token で fork の PR の workflow 設定を読めた(issue #3564、実測は #3556 のコメント 7078335373)。決定6 の「読めるなら盤面の検査に上げる」を採る —— 盤面は出元 repo へ push する前(着地の push と、宣言の扉が撃つタスクブランチの送出)に宣言の repo の設定を読み、private で「書ける token・secrets を送る」のどちらかがオンなら着地しない。読めなければ同じく着地しない(fail-closed)。public はこの設定を持たず、読まない。**

**Status 追記: 射程の境界の「CI の緑を head の内容で偽れること(#3473)」は、盤面が塞ぐものではないと決めた(2026-11-23、issue #3473)。CI の緑は head が自ら定めた検査に通ったという事実でしかなく、人間の書いた PR でも同じである。worker の内容の検査は、着地の前に必ず決着する完了時レビュー(ADR 0092 決定1 —— 付帯子が決着するまで PR も開かない。レビューの後に入る修理子の内容は、それを生んだレビューが見届けてから受理する —— ADR 0111 決定2)と、installer が宣言する人間が merge する path(決定4)が担う。テストや scripts の書き換えで作った緑を見逃すのは、Auditor の定義か path の宣言という installer の選択である。帰結の「CI の緑(#3473 で偽れる)」もこの意味で読む。workflow 定義の書き換えは決定4 の外せない既定が塞ぐ。**

**Status 追記: 決定3 の宣言の扉が出元 repo へ送るのは、その出元 repo の写し `refs/remotes/head-repo/task/*` がまだ無いタスクブランチだけである。写しのあるタスクブランチは盤面が一度送ったもので、その後の push は収束が ADR 0376 決定2 の条件で行う。扉は出元 repo の head を読まないので人間の巻き戻しを見分けられず、全部を送り直すと、祖先へ戻されたブランチを fast-forward で元へ戻し、収束が止めた巻き戻し(ADR 0376 決定6)も上書きした。写しの無いタスクブランチは今どおり lease 無しで送る —— 最後に push した値が無いとき、git の fast-forward の規則は ADR 0376 決定2 と同じ判断で、サーバーが原子的に検査する(2026-11-24、issue #3605)。**

2026-11-21 の grilling(issue #3482)で決定。盤面は人間が一度も見ていない worker の内容を origin と同じ repo の `task/<root>` に push していた。GitHub は同じ repo の branch を書き込み権のある協力者の内容として扱うので、PR の CI は head の workflow 定義と head の code を repo の資格情報で走らせる —— 使い捨ての repo で、repo の既定が `read` でも head の定義の `permissions: contents: write` が書ける token を得て、repo の secrets も渡ることを測った。fork からの PR では、fork の所有者が base の admin 本人でも token は read、secrets は渡らなかった。測ったのは public と private の両方で(どちらも個人 account の repo を同じ account の org へ fork、private は fork の PR の workflow を有効にして)、PR は人間の gh token で開いた。実測の表と、spec に運ぶ実装の制約(`file:line` 付き)は #3482 のコメントに置く。同じ repo か fork かは、これまで一度も決められていなかった。

## 決定

1. **worker の内容は PR の出元 repo(宣言の repo の fork)へ push し、そこから base へ PR を開く。** 人間担当の `task/<H>` も一律に出元 repo へ送る —— agent の子の内容が統合されうるので、「agent の内容を含むか」を判定する道は作らない。止めるのは付与(同じ repo の branch であること)であり、GitHub が外部の貢献者に掛ける扱いを、盤面の知らない実行者にもそのまま効かせる。
2. **出元 repo は workspace の宣言の欄として持つ。** 名前は規則から導けない(同名の fork は GitHub が改名する —— docs の知識、未測定)。出元 repo の無い remote-backed の workspace は、着地の push も `task/*` の publish もせず、理由を人間に見せる(fail-closed、移行は足さない)。registry を編集する workspace も同じ。出元 repo の差し替えは危険な値の門を通り、出元 repo ≠ `repo`、≠ registry の repo、parent = `repo` を検査する。
3. **publish は2段になる。** 保護ブランチだけを今の atomic な push で origin へ送り(巻き戻しの範囲は origin に閉じる)、出元 repo が宣言されたとき `task/*` を出元 repo へ送る。門を通っていない `task/*` が出元 repo に載っても、そこには資格情報が無いので穴にならない。タスクブランチの恒久記録(ADR 0066)は出元 repo が持つ。
4. **人間が merge する path を workspace ごとに宣言し、PR の差分が当たればダイヤルに依らず merge question に倒す。** fork が守るのは merge の前だけで、無人 merge が運んだ定義は main の上で repo の資格情報で走る。`.github/workflows/**` と CODEOWNERS(root・`.github/`・`docs/`)は外せない既定。判定は書き手を問わず差分だけで、無人 merge の直前に、CI を読み `--match-head-commit` で固定するのと同じ head で行う。path の照合は ADR 0362 の畳みと、tree でない entry を当たりとする扱いに揃える。`external` と purely-local には掛けない(前者は question を立てない宣言、後者はもともと常に merge question)。欄の削除は危険な値の門を通る。人間の作業台に path の門は掛けない。
5. **conflict を解ける人間は出元 repo に書ける人間である。** ADR 0376 決定9 の push 先は出元 repo の PR の head になる。他の人に解かせるには、その人を出元 repo の org に足す。盤面を共有する形でも、ユーザーごとに持つ形でも、複数ユーザーへの拡張は塞がれない。
6. **インストールヘルパーが一度だけの準備を持つ。** org の作成と App の install は案内(org は API で作れない —— docs の知識、未測定)、fork と出元 repo の Actions の無効化は自動。org のポリシーで fork できなければ、そこで止めて理由を出す。private repo では fork の PR の workflow が既定で走らない(実測)ので、「fork の PR で workflow を走らせる」をオン、「書ける token・secrets を送る」をオフに案内する。この設定は人間の token で API から読めた —— App で読めるかは未測定で、読めるなら盤面の検査に上げる。base の `pull_request_target`・`workflow_run` と self-hosted runner は警告する。

## 帰結

- fork の PR では secrets の要る job は走らない。skip させればその job は無人 merge の判定から外れ(SKIPPED は緑に数える —— 変えると path filter の job が赤になる)、失敗させれば人間に倒れる。どちらにするかは installer の定義の選択である。
- fork が完全に効くのは、人間が merge の前に差分を見る面(`escalate`・保護・人間の根)だけである。`auto_if_ci_green` では、CI の緑(#3473 で偽れる)を満たした worker の code が merge され、main の `push` の workflow が宣言された path の外の code(`package.json`・テスト・`.github/actions/**` など)を secrets 付きで走らせうる。床は宣言した範囲までしか効かないので、main で secrets 付きで走る workflow が実行する file(manifest・lockfile・build の設定・呼ばれる scripts)を installer が宣言すれば、無人 merge のままその変更は人間に回る。範囲は installer の宣言が決める。
- private では、fork の PR に資格情報が渡らないのは「書ける token・secrets を送る」がオフのときに限る。盤面がこれを確かめられるかは未測定で(決定6)、その点で同じ repo の案を退けた理由(盤面が確かめられない repo の設定に頼る)と対称である。違いは既定の向きで、同じ repo は既定が開く側、fork は閉じる側である。
- 盤面は1つの workspace に2つの鍵(出元 repo への push、base の PR 操作)を持ち、収束と ADR 0387 が読む head は出元 repo になる。
- 未測定: base 限定の installation token で出元 repo を head にした PR を作れるか(broker の形を決める)、App が開いた fork の PR の workflow が承認待ちになるか、fork された repo の Actions の既定の状態、PR の無い出元 repo の branch の commit を base から fetch できるか、同名の fork の改名、空の repo を fork できないこと(どれも実装の受け入れ条件)。盤面の知らない連携が fork の PR を secrets 付きでビルドしないことは推論であり、その実例が出たら fork の根拠を問い直す。

## 射程の境界

- 人間の書いた定義が `pull_request_target`・`workflow_run` で head を扱う形、self-hosted runner、インストール後に足された定義 —— installer の選択で、警告はインストール時の1回だけである。
- 宣言された path の外の code が merge の後に main の job(deploy など)で secrets 付きで走ること —— path の宣言と merge ダイヤルの仕事(ADR 0362 射程の境界と同じ線)。
- CI の緑を head の内容で偽れること(#3473)は fork でも塞がらない。

## 検討した選択肢

- **同じ repo のまま付与を減らす**(App から `Workflows: write` を外す、完了の門で `.github/workflows/` を人間しか書けない path にする、repo の既定 token を read にし secrets を environment に置く運用を求める) —— CI が実行するのは定義でなく head の repo 全体なので、path の列挙では merge の前の露出が残り、残りは盤面が確かめられない repo の設定に頼る。`Workflows: write` は App 単位なので(docs の知識、未測定)、外すと出元 repo への push も worker の CI の提案も拒まれる。
- **保護ブランチの規則を登録の条件にする** —— fork の後は必要が無い(ruleset は read 権で読める見込みで、読めないことは理由にしない)。
- **人間が判断してから push する** —— CI は push しないと走らず、`auto_if_ci_green` が成り立たない。
