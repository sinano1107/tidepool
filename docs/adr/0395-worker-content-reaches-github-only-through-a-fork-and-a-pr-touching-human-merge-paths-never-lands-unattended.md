# worker の内容は PR の出元 repo(fork)を通ってだけ GitHub に出て、人間が merge する path に当たる PR は無人で着地しない

**Status 追記: App `tidepool-board` は公開(Any account)を前提とする —— 非公開の App は作った account にしか install できず、決定6 の出元 repo の所有者(org)に install できない。2026-11-21 に公開へ変えた。秘密鍵は broker だけが持ち、token は認証したユーザーが push 権を持つ repo にしか出ない(ADR 0093 決定2)ので、他人の install は盤面の token を与えない(issue #3482)。**

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
- 盤面は1つの workspace に2つの鍵(出元 repo への push、base の PR 操作)を持ち、収束と ADR 0387 が読む head は出元 repo になる。
- 未測定: base 限定の installation token で出元 repo を head にした PR を作れるか(broker の形を決める)、App が開いた fork の PR の workflow が承認待ちになるか、fork された repo の Actions の既定の状態(どれも実装の受け入れ条件)。盤面の知らない連携が fork の PR を secrets 付きでビルドしないことは推論であり、その実例が出たら fork の根拠を問い直す。

## 射程の境界

- 人間の書いた定義が `pull_request_target`・`workflow_run` で head を扱う形、self-hosted runner、インストール後に足された定義 —— installer の選択で、警告はインストール時の1回だけである。
- 宣言された path の外の code が merge の後に main の job(deploy など)で secrets 付きで走ること —— path の宣言と merge ダイヤルの仕事(ADR 0362 射程の境界と同じ線)。
- CI の緑を head の内容で偽れること(#3473)は fork でも塞がらない。

## 検討した選択肢

- **同じ repo のまま付与を減らす**(App から `Workflows: write` を外す、完了の門で `.github/workflows/` を人間しか書けない path にする、repo の既定 token を read にし secrets を environment に置く運用を求める) —— CI が実行するのは定義でなく head の repo 全体なので、path の列挙では merge の前の露出が残り、残りは盤面が確かめられない repo の設定に頼る。`Workflows: write` は App 単位なので(docs の知識、未測定)、外すと出元 repo への push も worker の CI の提案も拒まれる。
- **保護ブランチの規則を登録の条件にする** —— App に Administration が無く読めないうえ、fork の後は必要が無い。
- **人間が判断してから push する** —— CI は push しないと走らず、`auto_if_ci_green` が成り立たない。
