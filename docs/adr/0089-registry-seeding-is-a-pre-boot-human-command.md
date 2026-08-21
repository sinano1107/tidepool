# 空の盤面への registry の種まきは boot 前の人間の一発コマンド — 初回起動時の自動作成はしない

issue #365 のグリリング(2026-08-19)で決定。友人テスト(#364)では、空の registry から既定 agent / authority
profile / auditor / workspace を作らないと何も動かないが、それらを作る人間面の動詞は WebUI にしかなく、WebUI は
boot した盤面を要る。一方で盤面は boot 時に既定 workspace を registry から eager に解決するので、空のリモートを
指す盤面は起動できない — **鶏と卵**であり、何らかの盤面外の種まきが必須である。

## 決定

1. **種まき(seed)は人間が boot 前に走らせる一発のコマンドであり、盤面が初回起動時に自動で作ることはしない。**
   ADR 0052 では内容はリモートの main に載って初めて「効いた」なので、初回起動時の自動作成は boot 時の push を
   意味する。その時点で盤面の GitHub 身元(ADR 0024)は未設定でありえ、設定済みでも人間の新規 registry repo へ
   誰の資格情報で押すかは #364 の未決の問いそのもの。盤面は registry の remote URL も人間固有の workspace も
   発明できない。リモート repo を作るのも押すのも人間自身の資格情報である(ADR 0066 の「リポジトリを用意する
   のは常に人間」と同じ側)。
2. **雛形はリポジトリ内の実ファイル(テストが `loadRegistry` で読める形)で持ち、コマンドは boot と同じ env
   だけを読む** — 種まきと boot の既定は同じ定数から出るので食い違わない。引き受けるのは「空のリモートに最初の
   registry を作る」1回だけで、空でないリモートは拒む(直す道具にはしない)。既定 workspace の checkout は
   pickup 時に branch discipline が実際に git を打つので、コマンドが `git init` + 初期コミットまで作る
   (deploy-pi first-time-setup と同じ罠の手当て)。
3. **既定 agent の雛形本文は空のまま**(ADR 0017)**で、「何を書くべきか」の案内も置かない** — 長期記憶(ADR 0083)
   は配布段階に無く、決定12の分類を先に見せると齟齬になる。自由に書かせて思いがけない使い方が生まれる方を取る。
4. **auditor ポインタの既定名は `fugu`** — 命名(ADR 0017、海の生き物)を雛形が最初に破らず、env を1つ減らす。
5. 既定 agent の profile は `assignable_to: ["*"]` / `allowed_workspaces: ["*"]` / `merge: escalate`(WebUI で
   workspace を足すたびに profile を触らせない。明示の `*` は ADR 0079 が求める綴り)。auditor の profile は
   全部空のまま — review タスクは固定の reviewer profile で走り(ADR 0013)、registry 側は読まれない。

## 先送り

**初回起動セットアップモード**(空 registry を許容して boot し、WebUI ウィザードが既存動詞を束ねてリモートへ
載せる) — 「初回起動時に自動で」を正しくやるならこの形だが、eager 解決の緩和が要り、友人テストの30分目標には重い。
痛みが観測されてから。

## Considered options

- **GitHub template repo + doc だけ** — 盤面コード0だが、workspace checkout の `git init` と env の整合を人間の手に
  残す。雛形の中身はこの形にも流用できるよう実ファイルで持つ(決定2)。
- **初回起動時の自動作成** — 上記のとおり資格情報と発明できない値の問題で退ける。

## 追記(2026-08-21): auditor の雛形本文も空

当初の雛形は auditor に観点5行(距離が価値 / 完了基準で判断 / 出典を示す / 未検証は言う / 所見なしは言う)を
載せていた。本文空と5行を同じルート review 3本で比べたところ(`docs/experiments/fugu-body-ab/`)、検出・引用・
餌の非所見化・clean での「所見なし」はどちらも守られ、破られた条項(仕様外の所見の製造)はどちらでも破られた ——
本文は測定上何も変えなかった。効いている証拠のない散文を種に焼き込むと、template から registry を再構成する
たびにその含意ごと引き継ぐので、決定3 と同じ線で auditor の本文も空にする。fugu が tako と違う点は frontmatter
(authority / skills / icon / description)が運ぶ。
