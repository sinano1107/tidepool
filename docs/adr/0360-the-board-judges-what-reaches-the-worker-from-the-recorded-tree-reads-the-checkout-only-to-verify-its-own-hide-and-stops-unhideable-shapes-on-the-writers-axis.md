# 盤面は worker に届くものを記録(tip の tree)で判定し、checkout は自分の隠しの検証にだけ読む —— 隠せない形は書き手の軸で止める

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
2. **checkout は盤面自身の実体化の検証にだけ読む。** 隠した後に `lstat` で消えたことを確かめる手は残し、task の checkout の `.git` は
   何も読まない —— index も `info/sparse-checkout` も alternates の存在も判定に使わない(ADR 0356 決定3 の「GIT_DIR にしない」を
   「読まない」へ)。view の sparse policy は「tip の tree に entry がある」から、sandbox の読み path は Interview の役から導く。
3. **止める軸は書き手。** 隠せない形が保護ブランチの tree にあれば (claude-code, workspace) の組の停止で、回答時の撃ち直しは名前の場所の
   保護ブランチを `ls-tree` する(ADR 0259 決定5 の読む tree)。task branch の tree にだけあれば worker(plumbing で disk に無い symlink も
   commit できる)の仕業なので task の失敗 —— ADR 0118 の族の failure question に path と形を名指し、branch が変わるまで retry は同じ理由で
   失敗すると書く。面接室には人間の書き手が居ないので、root・受験者の形は常に task の失敗。
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
