# 盤面は worker に届くものを記録(tip の tree)で判定し、checkout は自分の隠しの検証にだけ読む —— 隠せない形は書き手の軸で止める

**Status 追記: 決定2 の view の sparse policy(と #3075 の追記で足した鍵 `sparse.expectFilesOutsideOfPatterns=true`)は pathspec 除外に置き換わる —— 「worker に読ませない」(task の checkout の sparse)と「盤面が運ばない」(view)は目的が違い、sparse の seed は hidden path にディレクトリがあると `add -A` が throw し `status` が配下を名指した。view は sparse で seed せず、運ばない path(記録の tip から導く hidden settings と ADR 0069 の shadow 残骸)を1つの関数で作り、`add` と `status` の両方に `:(exclude,literal)<path>` で渡す。その path が無い・ディレクトリ・0 byte の stub・書き換えられた中身のどれでも、tree には seed の blob が残り status に出ない。Codex の pickup で hidden settings を含めない分岐(決定1・2)は残す。ADR 0069 の既知パスは `settingsDenyWrite` の2 path も含む —— tip に無い settings の path の 0 byte の stub も運ばず名指さない。task の checkout の sparse と worker の git env の鍵、名前の場所の `boardReadTree` は変えない(2026-11-10、issue #3111)。**

**Status 追記: 決定2 の sparse policy で seed する view(完了の門・退避・完了後の観測・出題の写し)は、worker の git env と同じ鍵 `sparse.expectFilesOutsideOfPatterns=true` で hidden path を読む —— 既定の検査では sandbox の stub(background の Bash が生きている間 host に見える 0 byte のファイル)や worker の中身で S bit が落ち、門はその path を名指すのに退避の `add -A` は運ばず、worker からは commit するものが無い。隠した entry は誰がバイトを置いても運ばない。policy の無い view(Codex の pickup、settings の無い tree)と名前の場所の `boardReadTree` は変えない(2026-11-09、issue #3075)。**

**Status 追記: 決定2 の「盤面が worker の repo に撃つのは tip の fetch とこの検証だけ」の fetch も消える —— tip の fetch は worker の `.git` の中で upload-pack を走らせていた。盤面は regular file だけを写し、盤面所有の repo から fetch する([ADR 0364](0364-the-board-never-opens-the-workers-git-as-a-repository-and-fetches-the-tip-from-a-board-owned-copy-of-its-regular-files.md)、2026-11-09、issue #3097)。**

**Status 追記: 派生の行(worker が settings の blob を変えた tip が landing 後に人間の CLI に届く)は [ADR 0362](0362-the-workspaces-claude-settings-are-human-only-paths-in-the-record-and-the-completion-gate-rejects-a-tip-whose-entries-differ-from-the-fork-source.md) で決着 —— 2 path は記録の中で人間しか書けず、完了の門が fork 元との merge-base と entry を比べて拒む。決定4 と同じ「直して commit し直せ」の型で、決定3 の spawn 時の停止は足さない(2026-11-09、issue #3078)。**

2026-11-08 の grilling(issue #3074、#3032 のレビューの派生)で決定。盤面が「worker の CLI に settings が届くか / 自分が隠したか」を
決める3箇所(spawn 前の組の検査、退避と完了の門の board view、組の question の回答時)が、判定の持ち主である記録(名前の場所の
`task/<id>` の tip の tree)ではなく派生物である task の checkout の状態 —— fs の `lstat`、checkout の index(`ls-files`)、worker が書ける
`.git/info/sparse-checkout` —— を読んでいた。しかも fs の鍵(中間の symlink を辿る)と git path の鍵が混ざり、`.claude` を symlink として
commit した tree では `lstat` は在ると言い index は無いと言う。固定版 2.1.286 の実測で、symlink の `.claude` 越しの `settings.json` の
`env` は worker の CLI に届き、盤面の行 `!/.claude/settings.json` はその symlink に効かない。「記録を読む」に置き換えるだけでも
`ls-tree tip -- .claude/settings.json` は空なので fail-open になる。実測の表と `file:line` は #3074 のコメントに置く。

## 決定

1. **判定の入力は記録だけ。** 名前の場所で tip の tree を `ls-tree` し、`.claude/settings.json` / `.claude/settings.local.json` の entry が
   あれば種類を問わず sparse で worker session 中だけ外す。祖先 `.claude` が tree object でない(symlink・gitlink・blob)tree は盤面が隠せない
   形として止める。ADR 0346 決定2 の tracked / untracked / 読めない の分類は消える —— fetch した checkout に Git 共有されていないものは無い。
2. **checkout は盤面自身の実体化の検証にだけ読む。** spawn の前に `.claude/settings.json` / `settings.local.json` が `lstat` で無いことを、
   隠したか否かに依らず常に確かめる —— 決定1 の tree の模型が見落とした形を fail-closed に受ける最後の行で、当たれば盤面自身の実体化の
   失敗(今日と同じ workspace の quarantine)。task の checkout の `.git` は判定の入力にしない —— index も `info/sparse-checkout` も
   alternates の存在も読まず、盤面が worker の repo に撃つのは tip の fetch(ADR 0356 決定3)とこの検証だけ。view の sparse policy は
   「tip の tree に entry がある」から、sandbox の読み path は Interview の役から導く。
3. **止める軸は書き手。** 隠せない形が保護ブランチの tree にあれば (claude-code, workspace) の組の停止で、回答時の撃ち直しは名前の場所の
   保護ブランチを `ls-tree` する(ADR 0259 決定5 の読む tree)。task branch の tree にだけあれば worker(plumbing で disk に無い symlink も
   commit できる)の仕業なので task の失敗 —— ADR 0118 の族の failure question に path と形を名指し、**推奨は abandon**(ADR 0118 決定4 の
   retry 推奨は一過性の fs / git の失敗の線で、同じ tree を読む pickup には当たらない)。親が形を commit して decompose した子の branch は
   全部その形を継ぐが、question は1枚で足りる —— failure question の held は同じ分解判断の兄弟に及び、abandon はその範囲を倒す
   (ADR 0048)。面接室には人間の書き手が居ないので、root・受験者の形は常に task の失敗。
4. **完了の門は隠せない形の tip を拒み、path を名指す**(ADR 0359 決定1 の門、「commit せよ」と同じ型)。非完了の解放は tip をそのまま記録へ
   引き、子は決定3 で止まる。
5. **登録の門は保護ブランチの `ls-tree` で隠せない形を live-checkout 信号として提示する**(拒まない —— ADR 0352 / 0354 決定3 の線)。

## 退けた形

- **symlink の `.claude` を `!/.claude` で丸ごと外して走らせる**(実測では消えて届かなくなる)—— skills・agents・commands が道連れになり、
  人間が置いた定義を worker が黙って持たない session になる。止めて名指すほうが fail-closed で説明も1行。
- **判定の入力を index から tree に替えるだけ** —— 祖先の型を見ないので symlink の形で fail-open。
- **task branch だけの形も組の停止** —— 同じ workspace の clean な branch を巻き込み、人間が名前の場所で直せるものが無い。

## 派生

- Status 追記: ADR 0346 決定2、0356 決定3、0259 決定5、0293 追記。GLOSSARY.md: Workspace containment の Claude の契機、task の checkout。
- worker が `.claude/settings*.json` の blob を plumbing で変えた tip は worker には隠れるが landing 後に人間の CLI に届く —— worker の
  封じ込めの外(review / landing の門)なので派生 issue。実装は複数 slice(`/to-spec` → `/to-tickets`)。
