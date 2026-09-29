# 直接の置き換えは畳む・定義の書き直し・移動が持ち、無効化は後継なしで落とすだけで、後継は種別の線の内側に限る

2026-09-27 の grilling(issue #1033)で決定。ADR 0160 は提案の op を「置き換える(`consolidate`)」と「落とす(`invalidate`)」で
分けたが、直接適用の側は `fold_memory` が新しく書く後継、`invalidate_memory` の `superseded` が既にある後継を受け持ち、
境界が後継の出どころで引かれたままだった。加えて `superseded` の後継は approved・未無効化かだけを見て種別を見ず、
candidate の Behavior を Knowledge で置き換えられた。コードの調査は #1033 のコメントに置く。

## 決定

1. **`superseded` の後継は種別の線の内側に限る。** Behavior と Exemplar は互いに置き換えられ(どちらも判断を運び、違いは
   表現だけ — ADR 0153 決定2)、Knowledge と Definition はそれぞれ同じ種別だけ。**記憶のモデルの不変条件**で、書き手
   (人間・meta-review・提案の承認・`define_memory`)を問わない。`path_moved` は本文が同じなので同じ種別だけ。
2. **meta-review の直接適用は置き換える verb と落とす verb に分かれる。** 置き換えるのは:
   - `fold_memory` — replaces を1つの後継に畳む。後継は新しく書く Knowledge(`text`、出所は `based_on_decision`)か、既にある
     approved・未無効化のエントリ(`successor_id`)のどちらか一方。既にある後継は Knowledge → Knowledge、Definition →
     Definition(枝の統合)、candidate の Behavior / Exemplar → approved の Behavior / Exemplar。
   - `define_memory` の `supersedes` — 置き換える Definition の path は問わない(`fold_memory` の `text` と同じ形)。
   - `move_memory` — 変えない。
   `invalidate_memory` は後継なしで落とす理由だけを受け、`superseded` を受けない。approved の Behavior / Exemplar の置き換えは
   従来どおり `consolidate` の提案(ADR 0160)。
3. **昇格規則に5つ目の行き先を足す。** 既にある approved の Behavior / Exemplar が同じことを言っている candidate は、
   `fold_memory` でそれに畳む。
4. **人間の面も同じ軸に揃える。** N 件を新しく書くか既にあるものへ1回で置き換える「畳む」と、盤面が本文を写す「移動」を
   作り、`path_moved` を生むのは移動だけにする。無効化は後継なしで落とすだけ。建設は派生 issue。

## なぜ種別の線を人間にも掛けるのか

承認の線は書き手で分かれるが、これは承認ではなく記録の意味の線である。種別を跨ぐ置き換えは、誰が書いても注入・一覧・
meta-review の履歴読みに同じ崩れとして届く。人間が本当に種別を変えたいときは、新しい種別で書いて旧を落とす2手で言える。

## なぜ candidate を既にある approved へ畳むのは直接適用か

candidate の無効化は既に meta-review の権限にある(ADR 0160 決定1)。`rejected` で引退させると「何が覆っていたか」が消えるが、
meta-review は superseded になった candidate の後継を読んで人間の修正を学ぶので、後継は読み手のいる記録である。

## なぜ人間の面を観測を待たずに揃えるのか

今の人間の N→1 は「新しく書く → 旧を1件ずつ開き `superseded` と後継 id を打つ」の N+1 手で、途中で止まれば半端が残る。
既存挙動の構造的な欠陥なので、痛みの観測を条件にしない。

## 退けた案

- **meta-review にだけ種別の線を掛ける** — 決定1の理由で、線は書き手の権限でなく記録の意味。
- **Behavior と Exemplar も同じ種別だけ** — 提案の `consolidate` が既に跨いでおり、同じ重複を言える経路が分かれる。
- **既にある approved に覆われた candidate は `rejected`** — 覆っていたものの記録が消える。
- **`define_memory` の `supersedes` を同じ path に限る** — 文言を直しながらの枝の改名が2手になる。
- **人間の口は据え置き、種別の線だけ掛ける** — 人間の畳みが N+1 手のまま残る。

## 追記(2026-09-28 の grilling、issue #1033 / #1037 —— #1038 の見直しを受けて)

5. **既にある後継を名指す `consolidate` の replaces は approved だけ。** candidate を既にある approved へ寄せるのは決定3 の
   `fold_memory` だけで、同じ置き換えを提案と直接の2本で言えるようにしない。新しい candidate を書く `consolidate` は今までどおり
   candidate も replaces に取る(ADR 0153)。ADR 0160 決定2 の「replaces の種別を問わない」はそのままで、状態の線が加わる。
6. **直接の畳みは後継が replaces を覆うときだけ。** 覆う = 種別の線の内側で、後継の scope が盤面全体か replaces と同じ、
   後継の宛先が全員か replaces と同じ(宛先は Behavior / Exemplar)。`fold_memory` の既にある後継(`successor_id`)にも
   新しく書く Knowledge(`text`)にも掛ける —— scope の違う畳みは置き場の変更なので移動の側。提案の経路と人間の畳み
   (ADR 0162)には掛けない。狭める判断は人間に残る。

### なぜ replaces の状態の線を提案の側に掛けるのか

経路が2本あると、question で承認された candidate が「invalidated_by が question・後継は人間の文言」の形になり、meta-review の
purpose が人間の修正(修正つき承認)と読む形と区別が付かない。決定3 で直接の経路を作った時点で提案の側は要らない。

### なぜ覆いの門を直接適用にだけ掛けるのか

種別の線は記録の意味なので書き手を問わなかったが、覆う範囲を狭めるのは判断で、承認の線の側にある。提案は detail に
replaces ごとの scope と宛先を載せて人間が見比べる。直接適用に人間の目は無いので、決定3 の「同じことを言っている」を
盤面が言える範囲で定義する。

### 退けた案

- **2本の経路を残して purpose の文だけ狭める** —— 読み分けの文が増えるだけで、形が同じ記録は残る。
- **覆いを description で meta-review に任せる** —— 直接適用の門は盤面の不変条件として置く(ADR 0107)。
- **覆いの門を Behavior / Exemplar にだけ掛ける** —— workspace の Knowledge を別 workspace の Knowledge に畳めば元の
  workspace の注入から消えるので狭まりは同じ。盤面全体の Definition は workspace を影として覆うので同じ規則で言える。


## 追記(2026-09-29 の triage、issue #1131)

7. **`define_memory` の `supersedes` にも覆いの門を掛ける。** 新しい定義の scope が盤面全体か、置き換える各定義の scope と同じときだけ
   置き換えられる(Definition は宛先を持たないので門は scope だけ)。path は問わないまま(決定2)。門は meta-review の口にだけ掛け、
   人間の面が呼ぶ `defineMemoryBranch` そのものには置かない(追記6 と同じ線)。

### なぜ `define_memory` の `supersedes` も直接の畳みなのか

書き込みの `supersedes` は新しく書く後継への畳みそのもの(ADR 0162 決定1)で、決定2 は `define_memory` の `supersedes` を
`fold_memory` の `text` と同じ形と置いた。追記6 が verb を列挙したとき `define_memory` が漏れただけで、除く判断は無かった。
狭める置き換えは要らない —— 同じ path に workspace と盤面全体の定義が並べば INDEX は workspace を採るので、workspace 向けの
定義は `supersedes` なしで書けば影として覆え、盤面全体の定義は他の workspace に残る。`supersedes` で盤面全体を workspace の
定義に置き換えるのは、他の workspace から定義を消す操作であり、それは人間の判断。

### 退けた案

- **`define_memory` は門の外に置き、`fold_memory` の `text` と扱いを分ける** —— 分ける理由を挙げられず、決定2 の「同じ形」と
  食い違ったまま残る。
