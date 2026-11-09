# 盤面は worker の `.git` をリポジトリとして開かない —— regular file だけを盤面所有の repo に写し、tip はそこから fetch する

2026-11-09 の grilling(issue #3097、#3084 のレビューの派生)で決定。ADR 0360 決定2 の後も、盤面が worker の repo に撃つ手が1つ残っていた ——
解放・完了の門・出題の写しが tip を引く `ls-remote` / `fetch` で、local path への fetch は送り側の `upload-pack` を **worker の `.git` の中で、
非 sandbox の盤面ユーザーとして**走らせる。ADR 0356 決定3 が保証したのは `upload-pack` の入力のうち config 1つ(protected config)で、git が
「この `.git` は何か」を解く残りの入力 —— **リポジトリ定義**: `.git` が dir か `gitdir:` file か symlink か、`objects/` と `refs/` と ref file が
regular か symlink か、`objects/info/alternates`、`packed-refs` —— は全部 worker が書ける(work の床は `.git` = write、ADR 0033)。worker が
ポインタを書けば、盤面ユーザーの `upload-pack` がそれを辿り、盤面が読めて worker が読めない object store(他 workspace の名前の場所・registry
clone・盤面自身の repo)の object を名前の場所へ送り、`cat-file -e` が通るので外部 sha が `task/<id>` として記録され merge back が祖先へ運ぶ
(Mac の一時 repo で alternates 追記・`gitdir:`・ref symlink の3形とも成立)。読み取り隔離だけでなく記録の信頼に当たる。書き手側で閉じる形は
ポインタ3種だけを拒む denylist で(worker の `git commit` は `objects/` と `refs/` を書かねばならない)、symlink の作成は path では拒めない。
実測の表・盤面が checkout の `.git` に触る箇所の棚卸し・`file:line` は #3097 のコメントに置く。

## 決定

1. **盤面は spawn の後、task の checkout の `.git` を git にリポジトリとして開かせない。** 読むのは allowlist の regular file だけ(`lstat` で
   regular を確かめ、symlink を辿らずに開く): `refs/heads/task/<id>` の file、無ければ `packed-refs` の行(worker の `gc` は正当に pack する)、
   `objects/[0-9a-f]{2}/` の loose、`objects/pack/` の `.pack` / `.idx`。盤面所有の使い捨ての `.git` に写し、その alternates を名前の場所の
   objects に向け、**名前の場所が fetch する元は盤面所有の repo**にする(fetch の検証と旗は今日のまま)。symref・symlink・`.git` が dir でない
   形・写した object と名前の場所で tip が解けない形は worker の repo の故障。不変条件: **記録に入る object は、名前の場所に既にあるか、
   worker が自分の checkout の `objects/` に regular file として書いたもののみ**。4つの役(work・review・root・受験者)とも同じ1つの手で、
   複製で走る Interview の2役は履歴全部の写しになるが面接室は小さい(ADR 0356 決定2)。「checkout が消えた」の述語も同じ線で `.git` が
   dir であることを `lstat` で見る。tip が fork 元と無関係な commit でもよいのは今日どおり —— worker が読める object だけで作れる。
2. **帰責は段で分ける。** checkout の file を盤面の repo に写し tip が解けることを確かめる段の失敗は worker の repo の故障(決着していない
   task なら task の失敗、`done` なら ADR 0359 決定3 の観測)。盤面の repo から名前の場所へ fetch し ref を書く段の失敗は名前の場所の側
   (解放なら quarantine、verb なら ADR 0359 決定4 の拒むだけ)。#3061 の「読めたのに書けない」が worker の故障になる共通 catch はこの
   分割で消える。ADR 0357 決定2 の上限超過は worker の repo の故障のまま。
3. **有界の対象は path の持ち主でなく byte の出所。** ADR 0357 決定1 の「cwd か引数が task の checkout の git」は、決定1 の後は「worker が
   書いた byte を読む git」—— 盤面所有の写しからの fetch(`index-pack` が噛む pack は worker の byte)を含む。file の写しは `lstat` 先行で
   FIFO を open せず、サイズの上限は置かない(worker が自分の disk で既に占めている量の2倍で有界)。

## 退けた形

- **ポインタ3種を sandbox / permission で拒む** —— ADR 0356 が退けた「層の行ごとに reset」と同じ denylist で、symlink の作成は path で拒めない。
- **`upload-pack` を worker の sandbox の中で走らせる**(読み手の目で読む)—— Harness ごとの機構に依り、#3061 の帰責は解けない。
- **fetch の前にリポジトリ定義を検査する** —— ポインタの種類の denylist で、検査と fetch の間に窓が残る。
- **実 worker の Lima 測定を待つ** —— 直す形が測定結果で変わらない。釘は Git 境界の harness で3形に外部 object が届かないこと。

## 派生

- Status 追記: ADR 0356 決定3、ADR 0357 決定1・2、ADR 0360 決定2。GLOSSARY.md: 「task の checkout」の盤面が撃つ手の行を直す。
- #3061 は決定2 に畳む(別 ADR を立てない)。#895(人間が書く名前の場所の `.git` symlink)は持ち主が違うので畳まない。実装は1 slice、
  #3097 のコメントが spec。
