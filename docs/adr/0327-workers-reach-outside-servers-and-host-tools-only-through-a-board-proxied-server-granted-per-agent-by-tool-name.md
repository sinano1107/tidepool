# worker が盤面の外のサーバと母屋の道具に届く形は、盤面が代理する MCP だけ —— 付与は agent が tool 名で持ち、母屋の道具は列挙された tool として見せる

2026-10-29 の grilling(issue #2695)で決定。本人の Mac で使っている MCP(GitHub・context-vault・context7)と Mac にしか無い道具(Blender、
自作スクリプト)を worker に使わせる形が「VM の中に同じ環境を作る」しか無いように見えた。実測すると Mac 側の MCP はどれも Mac に物理的に
縛られておらず(2本は remote の HTTP、1本は認証なしの stdio)、壁は VM ではなく3つの門 —— MCP 面の宣言(ADR 0108)・worker の資格情報ゼロ
(ADR 0024 決定3)・egress の既定全閉(ADR 0072)—— だった。「worker の MCP は tidepool だけ」を決めた ADR は無く、`MCP_SERVER_NAME` の写し
である。測定の表・schema の欄・`file:line` は #2695 のコメントと派生 issue に置く。

## 決定

1. **worker が盤面の外のサーバに届く形は、盤面が代理する MCP(Proxied server)だけ。** 盤面が自分の名前・資格情報・接続で上流に繋ぎ、
   付与された tool だけを `tools/list` に出し、名前の無い `tools/call` を拒み、spawn 時の `--mcp-config` / `mcp_servers` に tidepool と
   並べて宣言する。`checkToolSurface` の期待集合は「tidepool + その spawn が宣言した代理」に広がり、ADR 0108 決定1 の規則(宣言外が面に
   あれば不成立)は変えない。資格情報は盤面の secrets ファイルにだけ置く(ADR 0024 決定3「効く場所は1箇所」)。本人の PAT を橋渡しする
   形は採らない —— GitHub 上の操作が本人名義になり、ADR 0024 決定2 が消した嘘を戻す。
2. **母屋(Mac)の道具は、Mac 側で動く MCP サーバの列挙された tool としてだけ worker に見せる。** worker から Mac 上で任意の bash を走らせる
   橋は作らない —— ADR 0033 の床の外で process が走り、ADR 0099 決定5 / #465 が macOS worker を止めた回収の問題を戻す。stdio のサーバは
   tidepool 同梱の **host relay**(launchd 常駐、stdio ↔ HTTP の変換、共有 secret で盤面だけが繋ぐ)が起こし、盤面は `host.lima.internal`
   で繋ぐ。Mac に縛られない stdio サーバは VM 内で盤面が起こし、remote の HTTP サーバには盤面が直接繋ぐ。任意コード実行型の tool
   (Blender の `execute_*` 型)は付与できるが、人間の明示確認(`confirm`)を要する危険な値とする。
3. **付与の持ち主は agent 定義で、単位は server × tool 名。** Skill allowlist と同じ agent の frontmatter(ADR 0025 の線)。`*` は確認でも
   買えない(Domain allowlist の裸 `*` と同じ格)—— 上流が tool を増やしても面に出ないのは ADR 0039 の意図した非対称である。付与は task
   type で変えないが、**review 系の面に出るのは人間が `read` / `external_write` と分類した tool だけ**で、分類の既定は最も強い
   `workspace_or_host_write`(fail-closed)。review の書き込み床(ADR 0035)を Mac 側の保存 tool で迂回させないため。運営者が第三者の
   サーバは、workspace 側の受容(Domain allowlist と同型、ADR 0072 決定3「持ち出しの受容単位は workspace」)も要る。付与と分類の門は
   ADR 0061 のとおり人間面の credential と危険な値への `confirm` で、registry の commit ではない。ADR 0013 の「床はデータの状態に
   依存しない」は既定の側の話で、付与が MCP 面を広げるのは `allowed_domains` が egress を開けるのと同じ人間の扉のデータである(ADR 0072)。
4. **サーバ定義(名前・運営者・tool と分類・単一 tenant か)は registry、名前 → URL と資格情報は盤面設定。** registry はホスト非依存
   (ADR 0018)で secret を持たない。**既定は単一 tenant**(同時に1 task にしか渡さない。Blender は1つの scene を持つ1 process で、
   2 task の呼び出しが混ざれば記録からどちらの状態か言えない)。無状態と人間が確かめたサーバだけ `shared` を書く。`tidepool` は予約名。
5. **記録は盤面の DB に1呼び出し1行**(task・spawn・server・tool・引数・応答の逐語)。spawn 時に読んだ上流の `tools/list` も spawn の
   記録に残す(ADR 0325 が skill の scope を残すのと同型)。応答は代理が全文を手元に持つので、ADR 0195 決定4 のとおり予算で切って `next`
   で続きを読ませる。**GitHub だけは wrapper を持つ**: 書き込みの本文末尾に帰属の段落(agent の icon と名前・task id)を決定論で足し、
   盤面自身の PR 本文も同じ段落に揃える。着地と repo 内容の書き込み(merge・PR の close・push・ファイル作成更新削除・branch 作成)の tool は wrapper の
   コード定数で拒み、付与にも `confirm` にも買えない —— 着地の所有は盤面(ADR 0024 決定2、Merge ダイヤル)。
6. **Mac 側の tool が触る workspace は、Mac 側の専用ディレクトリに置いて VM へ書き込み可で mount し、代理が path 引数の接頭辞を写す。**
   Mac の home は mount しない(ADR 0257 決定1 が閉じた理由)。workspace の `.git/` 配下に解決する path は代理が拒む(ADR 0037 の
   file-level denyWrite と同じ穴)。容量は増えない(mount は複製ではない)。writable virtiofs 上の git / bubblewrap / worker 完走は未実測で、
   測定 issue が裁定者。通らなければ Lima の ssh 越しの sshfs に同じ接頭辞の写しで差し替える。
7. **届かない上流は資源の故障。** この盤面に URL / secret が無い(未設定)のは ADR 0116 決定4 の「不在」と同型で、pickup の除外に
   サーバ名を書き、poll ごとに読み直し、question も隔離も無い(Pi と Mac が registry を共有しても Mac だけのサーバを持つ agent が Pi で
   隔離されない)。設定済みだが届かない、または付与した tool が上流の `tools/list` から消えたのは「失効」と同型で、そのサーバを付与された
   agent の行を pickup から外し、サーバの軸で1回の確認型 question を立てる。registry に定義の無いサーバ名を付与した agent だけが
   読み込み時の隔離(静的な不成立)。

## 帰結

- subagent は代理の tool をそのまま継ぐ(既存の hook が subagent に拒むのは盤面 verb だけ —— verb は判断、代理 tool は能力)。Codex は
  代理サーバにも `default_tools_approval_mode="approve"` を書く(ADR 0129 の線の延長。承認は床ではなく、代理の allowlist が床)。
- Mac 側の tool が始めた処理は worker の回収後も走り続ける。受け入れた残余で、人間が登録したサーバの責任である。
- host relay の設定の雛形は版を固定した形(`npx pkg@x.y.z`)で書くが、固定を強制しない。remote のサーバは固定できず、同名のまま挙動が
  変わることは分類では検知できない。
- context-vault は機構が同じでも今は付与しない。呼び出しごとの人間の承認は v1 に入れない(headless の worker を question 待ちで寝かせる)。
- 道具を VM に Linux 版として入れる道は残る。Mac にしか無い道具と、インストールを二重にしたくない痛みに対する答えがこの ADR である。

## 退けた形

- **本人の資格情報を VM へ橋渡しする** — ADR 0024 決定2・3 の反転。
- **Mac で任意コマンドを実行する橋** — 床と回収の外(ADR 0033 / 0099 / 0100 決定2)。
- **MCP の `readOnlyHint` 等の annotation を分類に使う** — サーバの自己申告で、モデルの判断と同じく床に数えない(ADR 0038)。
- **Claude の `permissions.deny` だけで tool を絞る** — 列挙 deny は上流が増やした tool を開いたまま通す(ADR 0039 が退けた極性)。
- **呼び出しごとにファイルを Mac へ写す(staging)** — tool ごとに「どの引数が path か」の宣言が要り、一般解にならない。
