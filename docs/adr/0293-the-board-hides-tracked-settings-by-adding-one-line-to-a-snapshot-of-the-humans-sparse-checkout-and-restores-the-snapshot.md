# 盤面は checkout の sparse-checkout を自分だけのものとして書かず、人間の状態の写しに1行足して隠し、写しどおり戻す

**Status 追記: 決定1〜7 の写し・戻し・印の機構は消えた —— `workspace_state.sparse_snapshot`、起動時の戻し、盤面の行の印の読みは無く、盤面は task の checkout の sparse-checkout に除外の行を書くだけである。Status 追記(#2943)の `sparse.expectFilesOutsideOfPatterns=true` は残る([ADR 0356](0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md) 決定2、2026-11-08、issue #3032)。**

**Status 追記: worker が人間の checkout で走らなくなるので、人間の sparse-checkout の写しは要らず、settings.json は盤面が作った task の checkout で外す([ADR 0356](0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md)、2026-11-07、issue #2956)。**

**Status 追記: Claude worker の Git env には常に `sparse.expectFilesOutsideOfPatterns=true` を載せる —— sandbox の settings stub(ADR 0037 機構2)が、盤面だけでなく人間の sparse の S bit も落とすためである。既存の `GIT_CONFIG_*` の後ろに足し、checkout の config は変えない。決定4 の戻しは Git の成功だけで終えず、`git ls-files -d -- .claude/settings.json` が空であることも確かめ、欠けていれば写しを残して決定6 の quarantine に返す。人間の sparse が外したファイルはこの検査に出ないので決定3 はそのまま(2026-11-06、issue #2943)。**

2026-10-21 の grilling(issue #1024)で決定。ADR 0037 追記 / ADR 0158 は Git 共有された `.claude/settings.json` を Claude worker の
session 中だけ sparse-checkout で実体化から外すが、その書き方は `set` で人間の pattern を**置き換え**、戻しは `add` の1行、
「盤面が隠している最中か」は skip-worktree の S bit で読んでいた。cone の monorepo を登録すると pickup で全体が実体化し、回収後も
人間の pattern と cone モードは戻らない。人間の cone が `.claude` を外していれば、人間が立てた S bit を盤面の除外と誤読して cone が
拒む `add` を撃ち、workspace が quarantine に落ちる。sparse を使わない checkout も、session の後は sparse のまま残る。
実測の表と実装の spec は #1024 のコメントに置く。

## 決定

1. **sparse snapshot(sparse-checkout の写し)を、隠す前に撮る。** 中身は pattern ファイルの内容(無ければ「無い」)と、cone /
   non-cone / 無効の別。**写しが無いときだけ書く** —— 同じ workspace の2本目の pickup が、盤面が触った後の形を人間の状態として
   写す窓を閉じる。写しは戻しが成功した後に消す。「写す→隠す」「戻す→消す」の間で盤面が落ちても、起動時は写しどおり戻すだけで無害。
2. **隠す形は、写しの pattern に `!/.claude/settings.json` を1行足した non-cone。** cone はファイル1枚の除外を書けないので
   non-cone へ移すが、人間の pattern 行はそのまま残す。session 中の worker の見える範囲は人間の sparse-checkout のままで、広げない
   —— 広げればそれ自体が盤面外への上書きである(ADR 0037 追記の「盤面外の human 側は従来どおり」の線)。
3. **「盤面が隠している最中か」の印は写しの有無、写しが無いときは決定2 の1行そのもの。S bit は読まない。** 決定2 の1行
   (`!/.claude/settings.json`、先頭 `/` の non-cone 行)は盤面しか書かないので、写しを失っても checkout に残るその行を盤面の印と
   読む(決定7)。人間が自分の sparse-checkout で `settings.json` を外していれば、無いものとして扱う —— CLI も読まない
   (ADR 0158 決定4 の canary)。この形では決定2 の1行は tree を変えない。人間が同じ綴りの行を自分で書いていた場合だけ、
   1回盤面の行として外される —— 非 cone で、盤面が隠すのと同じ1枚を、同じ綴りで外す形に限られ、起きても settings.json が
   人間の tree に1回現れるだけなので、印を1行のままにする側を取る(`#` のコメント行を添えて対で判定する案は退けた)。
4. **戻しは写しどおり、git 自身にやらせる**(`reapply --cone` など。cone の設定は `.git/config.worktree` に居るので、素の
   `git config` は `.git/config` 側に落ちて影に隠れる —— 実測)。写しが「無効」なら `disable` し、盤面が作った pattern ファイルを
   消す。`disable` が残す worktree config の false 値は受け入れる。
5. **写しの置き場は盤面 DB の `workspace_state`(`ref_snapshot` の隣)。** worker は task branch へ commit するので `.git/` は
   書き込み半径の内にあり、CLI が守るのは `.git/config` と `.git/hooks` だけで `.git/info/` は守られない。worker が書ける場所に
   置けば、盤面は worker の選んだ pattern を人間の checkout へ「復元」する。盤面の状態を worker の半径から外す ADR 0040 の内側に置く。
6. **変えないこと**: 戻しの失敗は従来どおり workspace の quarantine(#1966 の受け入れ行)。Codex worker は無関係。session 中に
   人間が sparse-checkout を変えていても写しで上書きする —— ADR 0064 の「session 中の checkout は盤面の専有領域」の残余で、
   ref と違って検出は置かない。
7. **写しを失った checkout は、残った盤面の行を外して戻す。** 起動時の復元と pickup で DB に写しが無く、`core.sparseCheckout` が
   有効で pattern ファイルに決定2 の1行があれば、その行を外した pattern を non-cone の写しとして読み(次に隠すとき DB に写す)、
   写しどおり戻す。戻るのは tree だけで、cone の旗と「無効だった」事実は戻らない(cone の pattern は non-cone でも同じ範囲を
   指す —— #1024 の実測)。戻したことは log に残し、quarantine で人間を止めない —— 失うものは本 ADR が既に受け入れた残余で、
   `reapply --cone` は人間の1回の手で足りる。`core.sparseCheckout` が無効なら行は死んでいる(人間が `disable` で直した後に
   残るファイル)ので印と読まず、checkout が無い・git repository でない workspace の探りの失敗も「印なし」と読んで起動時に
   quarantine を増やさない。旧い機構の行(`!.claude/settings.json`、先頭 `/` 無し)は印と読まない —— 互換は持たず手直しのまま
   (2026-10-21 の triage、issue #2380)。

## Considered options

- **sparse-checkout が有効な workspace では (claude-code, workspace) の組を止める**(ADR 0259 の形)—— fail-closed で小さいが、
  ADR 0158 が退けた「普通の利用者の repo が最初の pickup で必ず止まる」を sparse を使う monorepo に作り直す。
- **写しを checkout の git dir(`info/` の隣)に置く** —— 盤面が死んでいる間も人間が見られるが、決定5 のとおり worker が書ける。
  盤面の作り直しで DB の写しが消える弱点は、決定2 が人間の行を checkout に残し、残った盤面の行を印に戻す(決定7)ので、失うのは
  cone の旗と「無効だった」事実だけ —— 決定7 が無いと盤面の行も残り、人間の settings.json は人間が手で直すまで隠れたままになる
  (#2380 の実測)。
- **写しを失った checkout は workspace を quarantine し、手直しの手順を理由に書いて人間に差し戻す** —— 失うのが上の残余だけなので
  盤面を止めるほどではなく、決定7 で戻して log に残す側を取った。

## 帰結

- 今の機構で既に sparse 化された checkout は、3行の non-cone が人間の状態として写される。全実体化と等価で害が無いので修理は足さない。
- #1969 が「`add` を自然に失敗させる形」とした「cone が `.claude` を外す checkout」は、決定3 で失敗しなくなる。
