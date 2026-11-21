# worker の内容は fork 先を通ってだけ GitHub に出て、人間が merge する path に当たる PR は無人で着地しない

2026-11-21 の grilling(issue #3482)で決定。盤面は人間が一度も見ていない worker の内容を origin と同じ repo の `task/<root>` に push していた。GitHub は同じ repo の branch を書き込み権のある協力者の内容として扱うので、PR の CI は head の workflow 定義と head の code を repo の資格情報で走らせる —— 使い捨ての repo で、repo の既定が `read` でも head の定義の `permissions: contents: write` が書ける token を得て、repo の secrets も渡ることを測った。fork からの PR では、fork の所有者が base の admin 本人でも token は read、secrets は渡らなかった。実測の表と、spec に運ぶ実装の制約(`file:line` 付き)は #3482 のコメントに置く。同じ repo か fork かは、これまで一度も決められていなかった。

## 決定

1. **worker の内容は fork 先へ push し、fork 先から base へ PR を開く。** 人間担当の `task/<H>` も一律に fork 先へ送る —— agent の子の内容が統合されうるので、「agent の内容を含むか」を判定する道は作らない。止めるのは付与(同じ repo の branch であること)であり、GitHub が外部の貢献者に掛ける扱いを、盤面の知らない実行者にもそのまま効かせる。
2. **fork 先は workspace の宣言の欄として持つ。** 名前は規則から導けない(同名の fork は GitHub が改名する)。fork 先の無い remote-backed の workspace は、着地の push も `task/*` の publish もしない(fail-closed、移行は足さない)。registry を編集する workspace も同じ。fork 先の差し替えは危険な値の門を通り、fork 先 ≠ `repo`、≠ registry の repo、parent = `repo` を検査する。
3. **publish は2段になる。** 保護ブランチだけを今の atomic な push で origin へ送り(巻き戻しの範囲は origin に閉じる)、fork 先が宣言されたとき `task/*` を fork 先へ送る。門を通っていない `task/*` が fork 先に載っても、そこには資格情報が無いので穴にならない。タスクブランチの恒久記録(ADR 0066)は fork 先が持つ。
4. **人間が merge する path を workspace ごとに宣言し、PR の差分が当たればダイヤルに依らず merge question に倒す。** fork が守るのは merge の前だけで、無人 merge が運んだ定義は main の上で repo の資格情報で走る。`.github/workflows/**` と CODEOWNERS(root・`.github/`・`docs/`)は外せない既定。判定は書き手を問わず差分だけで、無人 merge の直前に、CI を読み `--match-head-commit` で固定するのと同じ head で行う。path の照合は ADR 0362 の畳みと、tree でない entry を当たりとする扱いに揃える。`external` と purely-local には掛けない(前者は question を立てない宣言、後者はもともと常に merge question)。欄の削除は危険な値の門を通る。人間の作業台に path の門は掛けない。
5. **conflict を解ける人間は fork 先に書ける人間である。** ADR 0376 決定9 の push 先は fork 先の PR の head になる。他の人に解かせるには、その人を fork 先の org に足す。盤面を共有する形でも、ユーザーごとに持つ形でも、複数ユーザーへの拡張は塞がれない。
6. **インストールヘルパーが一度だけの準備を持つ。** org の作成と App の install は案内(org は API で作れない)、fork と fork 先の Actions の無効化は自動。private repo では「fork の PR で workflow を走らせる」をオン、「書ける token・secrets を送る」をオフに案内する。base の `pull_request_target`・`workflow_run` と self-hosted runner は警告する。

## 帰結

- fork の PR では secrets の要る job は走らない。skip させればその job は無人 merge の判定から外れ(SKIPPED は緑に数える —— 変えると path filter の job が赤になる)、失敗させれば人間に倒れる。どちらにするかは installer の定義の選択である。
- 盤面は1つの workspace に2つの鍵(fork 先への push、base の PR 操作)を持ち、収束と ADR 0387 が読む head は fork 先になる。
- 未測定: App が開いた fork の PR の workflow が承認待ちになるか、fork された repo の Actions の既定の状態(どちらも実装の受け入れ条件)。盤面の知らない連携が fork の PR を secrets 付きでビルドしないことは推論であり、その実例が出たら fork の根拠を問い直す。

## 射程の境界

- 人間の書いた定義が `pull_request_target`・`workflow_run` で head を扱う形、self-hosted runner、インストール後に足された定義 —— installer の選択で、警告はインストール時の1回だけである。
- 宣言された path の外の code が merge の後に main の job(deploy など)で secrets 付きで走ること —— path の宣言と merge ダイヤルの仕事(ADR 0362 射程の境界と同じ線)。
- CI の緑を head の内容で偽れること(#3473)は fork でも塞がらない。

## 検討した選択肢

- **同じ repo のまま付与を減らす**(App から `Workflows: write` を外す、完了の門で `.github/workflows/` を人間しか書けない path にする、repo の既定 token を read にし secrets を environment に置く運用を求める) —— CI が実行するのは定義でなく head の repo 全体なので、path の列挙では merge の前の露出が残り、残りは盤面が確かめられない repo の設定に頼る。`Workflows: write` は App 単位なので、外すと fork 先への push も worker の CI の提案も拒まれる。
- **保護ブランチの規則を登録の条件にする** —— App に Administration が無く読めないうえ、fork の後は必要が無い。
- **人間が判断してから push する** —— CI は push しないと走らず、`auto_if_ci_green` が成り立たない。
