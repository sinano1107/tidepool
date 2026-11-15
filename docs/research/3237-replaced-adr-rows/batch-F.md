# バッチ F: #3233 / #3234 / #3235 / #3236 / #3238 / #3239 が置き換える ADR の行

読んだ時点: main `3e2447ac`(2026-11-15)。ADR は `docs/adr/NNNN-*.md`、表の `NNNN:行` はその file の行番号。
URL の略記: `#N-c<id>` = `https://github.com/sinano1107/tidepool/issues/N#issuecomment-<id>`。

comment の索引:

| 略記 | 中身 |
|---|---|
| [#3233-res](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875805890) | #3233 resolution |
| [#3233-訂正](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875932383) | #3233 訂正(決定4 改) |
| [#3233-漏](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875961664) | #3233 記載漏れ(終点で照合する ADR の一覧) |
| [#3234-res](https://github.com/sinano1107/tidepool/issues/3234#issuecomment-6876347585) | #3234 resolution |
| [#3234-上書き](https://github.com/sinano1107/tidepool/issues/3234#issuecomment-6877948004) | #3238 から #3234 への上書き(決定は全部当たらない) |
| [#3235-res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933) | #3235 resolution |
| [#3235-漏](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877276653) | #3235 記載漏れ |
| [#3236-res](https://github.com/sinano1107/tidepool/issues/3236#issuecomment-6877476951) | #3236 resolution |
| [#3236-訂正](https://github.com/sinano1107/tidepool/issues/3236#issuecomment-6877505291) | #3236 訂正と記載漏れ |
| [#3236-訂正2](https://github.com/sinano1107/tidepool/issues/3236#issuecomment-6877685880) | #3236 訂正と記載漏れ 2 |
| [#3238-漏0](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6876377492) | #3238 記載漏れ(resolution の前、#3234 の session から) |
| [#3238-res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) | #3238 resolution |
| [#3238-訂正](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877985910) | #3238 訂正と記載漏れ |
| [#3238-漏2](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6878032122) | #3238 記載漏れ 2 |
| [#3239-res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763) | #3239 resolution |
| [#3239-上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240) | #3239 訂正と上書き(決定3 改・決定4 取り下げ・決定10) |
| [#3239-追加2](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879709414) | #3239 追加の決定と訂正 2(決定11・12) |

## 1. ADR の行

### 1-1. #3233(origin に PR の無い `task/<root>`)

ticket の動詞は全部「終点で照合する」([#3233-漏](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875961664) の最後の項、map :191)。判定は私が ADR 本文と突き合わせて付けた。

| ADR | 決定/追記/節 | ticket と comment URL | 動詞 | ticket 側の決定(1〜2文) | ADR 側の該当文(引用、file:line) | ADR の Status | 純効果 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 0241 | 決定4(push の手順) | #3233 [res](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875805890) 決定2・3、[漏](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875961664) | 照合する | PR が見つからないとき、盤面は push の前に origin の `task/<root>` の head を毎回読む。「読めて、無い」は今どおり push して PR を作り、「読めなかった」は push しない。 | 「**PR は、作る前に同じタスクブランチの PR を探す。** あれば作らず、その番号を記録する。」(0241:24–25) | 0241:3 に Status 追記(決定3・7 ← ADR 0370 決定1)、0241:5 に Status(帰結 ← ADR 0289)。決定4 への追記は無い | 効いている | **足すだけ** —— 「探す → 無ければ origin の head を読む → push」と段が1つ入る。決定4 の文は真のまま。決定5(0241:27–28「retry は…収束を1回待ち、その根の verdict で回答を受けるか拒むかを決める」)は決定4(改)の「`retry` は毎回拒む」が乗る形で、矛盾しない |
| 0242 | 決定2 | #3233 [res](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875805890) 決定2・5・6 | 照合する | PR が無い・未記録のときの「最後に push した値」は写し `refs/remotes/origin/task/<root>` から読む。push する条件は「GitHub の head が push する sha の祖先、かつ head が最後に push した値を祖先に持つ(または値が読めない)」の1つ。 | 「**収束(push の判定と push 後の読み直し、ADR 0241 決定7)は、盤面が最後に push した head と比べる。** …その一次の綴りは盤面自身の記録(`pr_opened` / `pr_branch_pushed`)である。GitHub も写しも読まない。」(0242:18–20) | 0242:3 Status 追記(決定1・4 ← ADR 0370 決定1・7)、0242:5 Status(決定1 ← ADR 0289)。決定2 への追記は無い | 効いている | **一部置き換える** —— 「GitHub も写しも読まない」が偽になる(push の判定が origin の head と写しを読む)。「一次の綴りは盤面自身の記録」は PR が記録済みの根に残る(写しに寄せるかは ticket が未決 = spec、map :188)。PR が在る場面で GitHub の head を読むのは #3203(別バッチ)の決定。Considered options は写しの使い方を2つ退けている —— 「**refspec を明示して写しを fetch し直し、GitHub の head と一致するときだけ比べる** — fetch と読みの間に head が動く窓が残り、写しという ref を1本余計に書く」「**写しのまま更新の契機を足す** — 契機を足すたびに別の issue が出る」(0242:33–35)。どちらも写しを GitHub の head の鏡として読む形で、決定5 は写しを fetch せず「盤面が最後に push した値」として読む(書き手は `authedPush` だけ)ので、退けた形の再採用ではない。終点はこの違いを書く必要がある |
| 0242 | 決定4 | #3233 [訂正](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875932383) 決定4(改)、[res](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875805890) 決定10 | 照合する | PR が無い・未記録の巻き戻しは push を止め、`retry` は毎回拒む —— 同意は origin への操作(落とされた commit を push し直すか、ブランチを消す)で表す。PR が記録済みの書き換え・巻き戻しは変えない。 | 「**盤面の外の push が内容を落とした head は、キューを外して推奨 hold の merge question に倒す。** 最後に push した head には全部載っているのに GitHub の head に無いとき、盤面には運ぶ手が無い。」(0242:23–24)/「push は non-fast-forward で拒まれるか、origin が祖先へ巻き戻されていれば fast-forward で修理を戻す(#1868 の実測)」(0242:27–28) | 0242:3 Status 追記が既に決定4 の文面と「捨てる」手順を ADR 0370 決定1・7 で直すと書いている | 効いている(resolution の決定4 の「`retry` の回答が同意になる」は [訂正](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875932383) で取り消し済み) | **足すだけ** —— 決定4 はキューに居る(PR 記録済みの)場面で、ticket 決定10 が「変えない」と書く。PR が無い・未記録の巻き戻しの受け方が新しく足される。0242:27–28 の「巻き戻されていれば fast-forward で修理を戻す」は git の挙動の記述で偽にはならないが、PR が無い・未記録の場面では盤面がその push を撃たなくなる。Considered options の「**外の push が落とした head を失敗 question に倒す** — retry は収束を走らせるが、収束は「push 済み」と答えて何も変えず、question だけ閉じる。」(0242:38–39)は、PR が無い・未記録の巻き戻しを失敗 question(`pr_promotion_retry`)の上で受ける決定4(改)と同じ乗り物に当たる。退けた理由(retry が question だけ閉じる)は「`retry` は毎回拒む」で起きなくなるが、ticket はこの退けた形と照合していない |
| 0105 | 決定2(追いつきの順) | #3233 [res](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875805890) 決定1、「他の決定への上書き」の #3203 の項 | 照合する | 盤面は外の commit を自分では merge しない。順は「人間の tip の取り込み → 追いつき → push」。 | 「**fork 元に先立たれた根は、保護ブランチを Tidepool 名義で merge して追いついてから PR を開く。**」(0105:23)/「合わなければ PR は開かず、既存の PR 昇格失敗 question に落ちる…retry は同じ経路を再走するので、人間がセッション外で手で解決すれば通る。」(0105:29–30) | 0105:3 Status 追記(決定2 の「手で解決すれば通る」← ADR 0370 決定1・7)、0105:5 Status(決定4 ← ADR 0217) | 効いている | **足すだけ** —— 決定2 は外の push との順を述べておらず、追いつき(保護ブランチの merge)は盤面が撃つまま。追いつきの前に取り込みの段が入る。「人間がセッション外で手で解決」の手を作業台に替えるのは入口の ticket(#3182、別バッチ)で、この ticket ではない |
| 0243 | 決定2・決定6(写しの読み手) | #3233 [res](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875805890) 決定5、[漏](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875961664) | 照合する(ticket は「ADR 0243 / ADR 0052 Status 追記」と書き、決定番号は言わない) | 写し `refs/remotes/origin/task/<root>` を「最後に push した値」として読む(publish の push も拾える)。 | 「窓で worker が偽造して通るのは盤面が書こうとした値そのものだけで、どの箇所でも無害(タスクブランチの写しは誰も読まず — ADR 0242、…)」(0243:23–25)/「**タスクブランチの写しは見張りから外さない。** 読み手はゼロになった(ADR 0242)が、窓そのものが消えるので外す動機が無く」(0243:44–45) | 0243:3・:5・:7・:9 に Status 追記(決定4・5 と Considered options へ)。決定2・6 への追記は無い | 効いている | **一部置き換える** —— 「タスクブランチの写しは誰も読まず」「読み手はゼロになった」の2句が偽になる。決定6 の結論(見張りから外さない)と決定2 の畳みの規則は真のまま。決定2 が「無害」の根拠に置いた写しの分は書き直しが要る(読み手ができる)。0243 の Status 追記4本に写しを述べる文は無いので、当たるのは本文の決定2・6 |
| 0052 | Status 追記(0052:9、ADR 0339 決定5 由来) | #3233 [res](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875805890) 決定5、[漏](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875961664) | 照合する | 写しは `authedPush` が push の成功の後に書く(`src/github-auth.ts:324`)ので、「最後に push した値」として読める。 | 「写しは push の成功を見て盤面が ADR 0243 の口の中で `update-ref` で書く —— 「効いた」の定義は変わらない(push の成功)が、写しを動かす手は git の副作用でなく盤面の書き込みになる。」(0052:9) | この行自体が Status 追記(2026-11-01、issue #2827)。0052 には他に Status 追記が3本(:3・:5・:7、決定7 / §7)あり、写しを述べるのは :9 だけ | 効いている | **矛盾しない** —— ticket の決定5 はこの文に乗る。ADR は写しを「読む」ことを述べていないので、読み手を足す側は上の 0243・0242 の行 |
| 0240 | 決定2 | #3233 [訂正](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875932383)、[漏](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875961664) | 照合する(決定4 改の根拠) | 答えていない `pr_promotion_retry` がある根を収束は撃たないので、盤面が origin の head を最初に読むのは `retry` の回答の中。巻き戻しを見つけた `retry` は毎回拒み、印も event も足さない。 | 「昇格失敗 question が開いている根と、昇格の断念を記録した根も外す。人間がまだ答えていない、または答えた断念の選択を、盤面が先回りして潰さない(ADR 0225 と同じ線)。」(0240:22–24) | 0240:3・:5・:7 に Status 追記(3本とも決定4 へ)。決定2 への追記は無い | 効いている | **矛盾しない**(揃う)。ADR の文は ticket が引いたとおり |
| 0330 | 決定1 と「決めないこと・帰結」 | #3233 [res](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875805890) 決定2、map :187 | 頼る(spec へ)。ticket は「本文は ADR 0330 の決定の見出ししか読んでいない」([漏](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875961664)) | origin の head を読む手段(`gh` か `ls-remote` か)は spec が決める。 | 「**GitHub API 面(`gh`)の往復は盤面の実行を止めない。** `gh` は非同期の子 process として撃ち」(0330:16)/「probe(fetch / ls-remote)の同期・有界 30 秒の凍結は受容する」(0330:47) | 0330:3 Status 追記(ADR 0357)、0330:5 Status 追記(決定2・3 の上限の読み ← ADR 0334) | 効いている | **矛盾しない** —— ticket の要約は本文と合う。ticket が読んでいない部分: `gh` を選ぶと決定1 の規則「await を挟んで行う行為を縛る local の読みは、行為と同じ同期の区間で取る」(0330:19)が push の判定に掛かる。これは spec の制約で、決定の置き換えではない |

### 1-2. #3234(registry clone の口の改名)—— 決定は全部取り消し

map の #3234 の block(:196–198)に `ADR / GLOSSARY:` の行は無い。ticket が名指す ADR は1つ。

| ADR | 決定/追記/節 | ticket と comment URL | 動詞 | ticket 側の決定(1〜2文) | ADR 側の該当文(引用、file:line) | ADR の Status | 純効果 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 0351 | 決定7 | #3234 [res](https://github.com/sinano1107/tidepool/issues/3234#issuecomment-6876347585)「確かめたこと」 | 頼る(「旧い名前の行は残る(ADR 0351 決定7)」) | fallback は進む先の commit の名前の行にだけ予告し、その名前に行が無ければ予告なしで書く。fail-closed にしない(決定1〜3)。 | 「**行の寿命は workspace の寿命である。** 削除の扉が行を消す(今日の扉は registry のエントリしか消さない)。」(0351:43) | 0351:3 Status 追記(決定7 の「次の pickup で1枚の question が立ち」← ADR 0370 決定1) | **取り消された** → [#3234-上書き](https://github.com/sinano1107/tidepool/issues/3234#issuecomment-6877948004)(#3238 が口の束ねを消し、「決定は全部当たらなくなる」) | **矛盾しない** —— ADR は「扉が消す」と言うだけで、「手編集で消えた名前の行は残る」はその帰結の読み。同じ読みは #3239 が引き継ぐ(1-5)。#3234 から ADR に書くものは無い |

### 1-3. #3235(作業台・取り込みの名前)

| ADR | 決定/追記/節 | ticket と comment URL | 動詞 | ticket 側の決定(1〜2文) | ADR 側の該当文(引用、file:line) | ADR の Status | 純効果 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 0356 | 題と背景の地の文 | #3235 [res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933) 限界、[漏](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877276653)、map :204 | 確かめる(「置き換える ADR の範囲を確定するときに読み方を確かめる」) | 盤面が人間のために開く checkout を **作業台(Workbench)** の1語で呼ぶ。「作業台」単独は人間の側の語になる。 | 「# worker の作業台と盤面の記録は別の `.git` である」(0356:1)/「worker の作業台(index・`info/`・config・hooks・objects)を**同じ `.git`** に置いていた」(0356:27)。ADR 0356 の中の「作業台」はこの2箇所だけ | 0356:3〜:21 に Status 追記が9本(全部 決定2・3 へ)。題への追記は無い | 効いている | **矛盾しない** —— ADR の文は偽にならない。2箇所とも「worker の」が付き、指すのは task の checkout の `.git` の層。当たるのは語の衝突だけで、決定の置き換えは無い。読み替えの注を足すかは終点が決める(`GLOSSARY.md:569` の直しと同じ向き)。file 名の英語は `the-workers-bench` |
| 0066 / 0067 / 0131 | 地の文の「取り込み」 | #3235 [res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933) 限界 | 読んだ(「地の文で出るだけで、名前の付いた意味は無い」) | 盤面が作業台の tip を読み、検査し、包む commit を作って書く先の ref を書く行為を **取り込み(Intake)** と呼ぶ。 | 「org を「取り込みの門」にする」(0066:111)、「`clone` モードで取り込む一本にする」(0066:112)、「外部の repo を workspace として取り込むには」(0067:13)、「外部 repo の取り込みが完結するための必要条件」(0067:99)、「read 目的の取り込みを塞がない」(0067:116)、「取り込みまで止め」(0131:20) | 該当なし(どれも決定の文ではない) | 効いている | **矛盾しない**。ただし ticket の列挙は漏れている —— `grep -l 取り込 docs/adr/` は 0052(:162「merge を取り込む fetch + ff」)・0055(:27)・0276(:24「gitlink として取り込む」)にも当たる。3つとも地の文の動詞で、結論は変わらない |

### 1-4. #3238(registry clone を workspace にしない)

「終点で書き直す ADR」の一覧は [#3238-res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) の末尾と map :229。ticket は「0020 / 0040 / 0052 / 0064 / 0066 / 0081 / 0087 / 0243 / 0277 / 0339 / 0351 は sub-agent の通読、0040 L17–19・0052 L71–73・0064 L109–115 は読み直した」と書く。純効果は全行「効いている」(後から付いた #3254 のコメントは「この ticket の決定は変わらない」)。

| ADR | 決定/追記/節 | ticket と comment URL | 動詞 | ticket 側の決定(1〜2文) | ADR 側の該当文(引用、file:line) | ADR の Status | 純効果 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 0040 | 節「保護対象は…5点」の後の段落(決定番号なし) | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) 決定1・4 | 書き直す(「対象外の反転」) | registry clone と交差する path の entry は workspace として認めない。registry clone を固定点に足し、「registryDir は意図的に対象外」を反転する。 | 「**registryDir は意図的に対象外**。registry clone は v1 唯一の保護 workspace としてむしろ設計上 workspace であり、「盤面はコミット済み main しか読まない」(ADR 0020)+ branch discipline + 保護 workspace マーカーが既にその重なりを受け止めている。」(0040:17) | 0040:3 Status 追記(「workspace の中」は worker の読み書きの半径で、検査は task の checkout の番地に当たる ← ADR 0356) | 効いている | **置き換える** —— 段落ごと偽になる |
| 0040 | 節の題と数(決定番号なし) | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) 決定4(「6つ目の固定点」) | 書き直す(ticket の一覧は「対象外の反転」としか言わない) | registry clone を6つ目の固定点にする。「解決する」より広く、中の path と外側を包む path も拒む。 | 「## 保護対象は盤面プロセスに固定の5点」(0040:7)/「検査は「固定5点 × workspace パス(registry から live)」の総当たりである。」(0040:15) | 同上 | 効いている | **一部置き換える** —— 「5点」の数が偽になる。双方向の包含(0040:39)は今の5点と同じ規則で、registry clone にそのまま掛かる(足すだけ) |
| 0040 | Status 追記(0040:3)と節「執行」 | #3238 [訂正](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877985910) | 揃う(訂正の根拠)+ 足す | 「既存の4箇所がそのまま拒む」は3箇所だった —— spawn の交差の検査が見るのは task の checkout(ADR 0040 の Status 追記どおり)。pickup の側に名前の場所の交差の検査を1つ足す。 | 「**床のガードは pickup/spawn 時** — タスクの workspace を解決した瞬間に重なりを検査し」(0040:25)/「registry-edit PR 経由の登録は門を通らないが、pickup 側が必ず捕まえる」(0040:27) | 同上 | 効いている | **足すだけ** —— Status 追記と合う。ticket の読み(コードの読み。私は src を開いていない)では、Status 追記の後は 0040:27 の「pickup 側が必ず捕まえる」が名前の場所について成り立っておらず、足す検査がそれを再び真にする。終点は :25・:27 と Status 追記の関係を書き分ける必要がある |
| 0052 | 決定3(§3) | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) 決定1、「消える機構」 | 書き直す(「宣言は1つ」) | registry clone は基準の行も `task/<id>` も持たない。2つの宣言の突き合わせ(`assertRegistryRoleAgrees`)は消える。 | 「registry clone は上の2つの役を**両方**持つため2つの宣言を持ち、その食い違いも `resolvesToRegistryClone`(`src/workspace.ts:276`)で pickup 時に突き合わせて quarantine する。」(0052:71–73) | 0052:3・:5・:7・:9 に Status 追記(決定7・§7・決定1)。決定3 への追記は無い | 効いている | **一部置き換える** —— この1文。決定3 の残り(remote 正本の有無は宣言する、推測しない、ずれは quarantine)は真のまま。別バッチの #3254 も決定3 を書き直す(map :326「突き合わせは有無だけ」)。#3254 は map :321 で ADR 0066 決定5・0087・0351 も照合の対象に挙げる |
| 0052 | 決定3(`repo` 欄) | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) 決定6 | 揃う(頼る) | 保護の判定で比べるのは entry の `repo` でなく checkout の origin(「`repo` は ADR 0052 決定3 が照合しないと決めた欄」)。 | 「`workspaces.yaml` の `repo` を機械が読むフィールドへ**昇格**させる。`repo` あり = remote 正本を持つ。…盤面が checkout の `origin` URL を読んで焼く。」(0052:67–69)/「宣言と実態のずれ(宣言はあるのに remote が無い、逆も同様)は quarantine。」(0052:71) | 同上 | 効いている | **ADR の文言は ticket の言い方と一致しない** —— 0052 決定3 に「照合しない」と決めた文は無い(書いてあるのは有無のずれを quarantine にする、まで)。「綴りを照合しない人間向けの provenance」と言うのは ADR 0339 決定4(0339:39–40)の読み。ticket の決定の向き(`repo` を鍵にしない)とは矛盾しない |
| 0052 | Considered options(退けた案) | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162)「根拠にした事実」 | 揃う(頼る) | 守られているのは「agent が registry を編集できること」で、別の clone で成り立つ。purely-local の Registry には worker が registry を書く道を持たない(決定2)。 | 「**agent 発の registry-edit タスクという経路自体を撤回し、registry の変更を WebUI 一本にする** — 穴は消えるが…Condensation の主要経路を失う。」(0052:165–167) | 同上 | 効いている | **矛盾しない** —— remote-backed では経路が残る。purely-local で道を持たないことは、退けた案(経路そのものの撤回)の一部に当たるが、ticket は「purely-local の Registry は本番に無い(test の構成だけ)」を根拠に置く |
| 0064 | 決定4 の表の registry の3行 | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162)「消える機構」・末尾の一覧 | 書き直す | registry の fetch / push / `update-ref` を workspace の基準に束ねる口(`registryRefWriter`)と fallback が消える。 | 「\| `src/registry.ts` registry の fetch(registry 読み取りのたび) \| `refs/remotes/*` \| registry clone が workspace 登録されている \|」「\| `src/registry-write.ts` push(remote-backed の registry 着地) \| `refs/remotes/*` \| 同上 \|」「\| `src/registry-write.ts` `update-ref`(purely-local の registry 着地) \| `refs/heads/<REGISTRY_BRANCH>` \| 同上 \|」(0064:99–101) | 0064:11 Status 追記が既に決定4 の「書いた後に撮り直す」「成功したときにしか撮り直さない」を ADR 0243 で置き換え済み。他に :3・:5・:7・:9・:13・:15(決定1・2・3・5・6・7 へ) | 効いている | **置き換える** —— 3行とも条件「registry clone が workspace 登録されている」が起きなくなり、行ごと消える |
| 0064 | 決定4 の論拠 | 同上(一覧の「呼び忘れは registry の fetch で即座に露見する」の論拠) | 書き直す | 同上。 | 「しかも最も起きやすいのが registry clone(人間面からの registry 編集が `refreshRegistryForWrite` を撃つ)であり、**唯一の保護 workspace で不変条件が最も弱くなる**。」(0064:112–113)/「再基準化の**呼び忘れは静かに壊れない** —— 忘れた経路は誤検知として quarantine を立て、registry の fetch は読み取りのたびに走るので即座に露見する。」(0064:132–134) | 同上 | 効いている | **一部置き換える** —— 「registry の fetch は…即座に露見する」の論拠が無くなり、「唯一の保護 workspace」も偽になる。「呼び忘れは誤検知として quarantine を立てる」は残る。0064:114 の「registry の fetch は `REGISTRY_BRANCH` だけ、`update-ref` は `refs/heads/<REGISTRY_BRANCH>` だけ」も同じ行と一緒に落ちる |
| 0066 | 決定5 の2項目目 | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162)「消える機構」、[訂正](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877985910) | 書き直す | `RegistrySelfPublishError` は消える。手編集で入った交差 entry の publish は、remote-backed では `CheckoutHasOriginError` が止める読み。purely-local の Registry では止めるものが無い(spec で確かめる)。 | 「**registry clone 自身**(`resolvesToRegistryClone` — `src/workspace.ts:276`)。purely-local な盤面でこれを通すと、workspace エントリは remote-backed を宣言し合成 root は purely-local を宣言する。**ADR 0052 が quarantine と定めた「2つの宣言の食い違い」を人間の扉が製造する**ことになる。`RegistrySelfUnprotectError`(ADR 0013)と同じ形の、確認では買えない拒否である。」(0066:54) | 0066:3 Status 追記(別の文 ← ADR 0351 決定2)。決定5 への追記は無い | 効いている | **置き換える** —— 項目ごと消える。題「`publish` は4つを拒み」(0066:51)は3つになる。4項目目(0066:56「checkout に既に `origin` が在る workspace」)は残り、remote-backed の交差 entry を止める役を持つ |
| 0087 | 決定3 の registry clone の項目 | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162)「消える機構」・末尾の一覧 | 書き直す | `RegistrySelfDeleteError` は消える(registry clone は workspace でない)。 | 「**消せない資源**: 盤面自身の registry clone(保護剥奪と同じく永久に拒む)、盤面の既定 agent と既定 workspace(既定はポインタなので、指し先を消せば未指定タスク全部が止まる)。」(0087:23–24) | Status の行は無い(0087:25 に決定3 の訂正、0087:48 に追記 = 組み込み agent の例外) | 効いている | **一部置き換える** —— registry clone の項目だけ。既定 agent / 既定 workspace / Auditor の規則は残る。#3239 が同じ決定に拒否の理由を足す(1-5)ので、決定3 には2つの ticket が当たる |
| 0243 | 決定3 | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) 末尾の一覧、map :226(「registry の fetch・push・`update-ref` はどの workspace の基準にも予告しない」) | 書き直す | 同上。 | 「**fetch は値を先に知る形に分ける。** `ls-remote` で sha を知って予告し、その sha を fetch し(`refs/` には書かない)、`update-ref` で写しを書く。…対象は registry の fetch、収束の保護ブランチの fetch、registry 到達性 quarantine の受理検査の fetch。」(0243:30–32) | 0243:3・:5・:7・:9 に Status 追記(決定4・5 と Considered options へ)。決定3 への追記は無い | 効いている | **一部置き換える** —— 対象の列挙から registry の fetch 2つが外れる(予告する基準が無い)。registry の fetch に「`ls-remote` → sha の fetch → `update-ref`」の形を残すかは ticket が言っておらず、その部分は**判定できない** |
| 0243 | 決定4 | #3238 [漏2](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6878032122)(「対象は名前の場所に限ると書き直す」) | 書き直す | `WritableRegistry.writeRef` と `refreshRegistry` の `writeRef` 引数は束ねる先が無くなり素通しになる。 | 「**口は1つで、新しい値を引数に要求する。** 盤面の ref の書き込みは**すべて**この口を通る —— push・fetch・ff / merge・fork 元への追いつき・publish・registry の `update-ref`・後始末と quarantine 受理の merge back。」(0243:33–34) | 0243:3 Status 追記(決定4 の走行中 / 休止中の2形は消える ← ADR 0356)、0243:5(口を通る書き込みが加わる ← ADR 0351 決定3)、0243:7(HEAD の移動が加わる ← ADR 0345 決定2) | 効いている | **一部置き換える** —— 「すべて」と列挙の「registry の `update-ref`」 |
| 0020 | 決定1 の最後の文(「行き先」) | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) 決定5 | 書き直す | registry の default branch の検査(H14)は registry の到達性の検査へ移し、`origin/HEAD` が `origin/main` を指さなければ盤面全体の停止にする。 | 「origin/HEAD と main の不一致を検出したら既存の workspace quarantine に落とす。」(0020:11) | 0020:3・:5 に Status 追記(決定3 と追記へ)。決定1 への追記は無い | 効いている | **一部置き換える** —— この1文の行き先。決定1 の残り(コミット済み main に固定、main はコード定数)は真のまま。ADR 0052 の「origin の main を読む」との関係は ticket が触れていない |
| 0013 | 第3段落(決定番号なし) | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) 決定3・6 | 書き直す(「床の鍵」) | 床の鍵を path から repo の同一性に替える。保護 = entry の `protected` が true、または checkout の origin が registry clone の origin と同じ `owner/name`。 | 「対で、registry 自身は**保護 workspace** とする: 保護 workspace を名指しする子登録は登録者の profile に関係なく無条件で承認 question に変換され、そこへの PR は merge ダイヤルに関係なく常に人間が merge する。」(0013:7) | Status の行は無い(追記は :11・:13・:15、どれも reviewer profile の話)。決定に番号が無い | 効いている | **一部置き換える** —— 「registry 自身は保護 workspace」が「registry と同じ repo を origin に持つ workspace の全部」になる。**ADR 0013 に「鍵は path」と書いた文は無い** —— それは ticket のコードの読み(`RegistrySelf*` が `resolvesToRegistryClone` を通る)で、ADR が言うのは「registry 自身」まで。0013:5 の「床をデータの状態に依存させない」と、判定を checkout の origin の計算にすることの関係は ticket が照合していない。床の直しは #3246 が単独で先に入れられる(申し送り)ので、この行を書くのが map の spec か #3246 かは実装の順で決まる |
| 0351 | 決定3 | #3238 [漏0](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6876377492)(「ADR 0243 決定4・ADR 0351 決定3(口)は grep に当たらないが関係する」) | 関係する(動詞なし。終点の一覧には入っていない) | 口の束ねが消える。 | 「**盤面の書き込みはすべて口(ADR 0243 決定4)を通る —— pickup の fetch・park・タスクブランチの作成・checkout、release の merge back の fetch、読む場所の fetch・park も。**」(0351:30–31) | 0351:5 Status 追記(決定1・3・4・6・7 は残る ← ADR 0356) | 効いている | **矛盾しない** —— 列挙は checkout(名前の場所)の書き込みで、registry は入っていない。「すべて」の読みは 0243 決定4 の書き直しに従う |
| 0081 | 経緯と帰結の地の文 | #3238 本文・[res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162)(sub-agent の通読、「兼ねる理由を書いた ADR は無い」) | 通読した(書き直すとは言っていない) | 二役をやめる。`guardRegistryDefaultBranch` の検査は決定5 の場所へ移る。 | 「「registry clone を workspace として使う」かつ「セッション中に人間が registry を編集する」が同時に成立した次の解放で、誤検知の quarantine として発火する状態だった。」(0081:9–10)/「付け替えは registry clone に限れば `guardRegistryDefaultBranch` が独立に捕まえていたが」(0081:38–39) | 0081:3(← ADR 0351 決定2)、0081:5(← ADR 0345 決定2) | 効いている | **矛盾しない** —— どちらも経緯と当時の検出力の記述で、決定(symref は指し先で数える)は二役に依らない |
| 0277 | 退けた形 | 同上 | 通読した | registry clone との path の比較は固定点の比較として残る(決定4)。 | 「呼び手の残り(registry clone の比較、MCP の `real_environment`)は生 path の fallback が正しく」(0277:60) | 0277:3 Status 追記(追記 決定2 の出口 ← ADR 0361) | 効いている | **矛盾しない** |
| 0339 | 決定4 | 同上 | 通読した | 保護の判定は checkout の origin と registry clone の origin を比べる(決定6)。 | 「URL の元を registry の `repo` 宣言にしないのは、ADR 0052 決定3 がそれを綴りを照合しない人間向けの provenance と置き、registry clone 自身に宣言の行が無いからである。」(0339:39–40) | 0339:3 Status 追記(local の git の転送は `file` だけ、issue #2861) | 効いている | **矛盾しない** —— 「registry clone 自身に宣言の行が無い」は二役をやめた後、常に真になる。決定4 を書き直すのは #3254(別バッチ、map :326) |

### 1-5. #3239(workspaces.yaml の手編集の改名)

ticket 側の決定の最終形: 決定3 は [上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240) で改、決定4 は取り下げ、決定3(改)の1項目目(引けない名前の知らせ方)は [追加2](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879709414) の決定12 が上書き、決定7 は「止まる場合だけ守られる」に訂正。決定1・2・5・6・8・9・10・11 は効いている。

| ADR | 決定/追記/節 | ticket と comment URL | 動詞 | ticket 側の決定(1〜2文) | ADR 側の該当文(引用、file:line) | ADR の Status | 純効果 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 0351 | 決定2 | #3239 [res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763)「決め直す ADR」、[上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240) 決定3(改)、[追加2](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879709414) 決定11・12、map :250 | 決め直す(最初の撮りの条件を足す) | registry から引く名前の最初の撮りの前に、基準の行を持つ workspace が全部、resolver で引けて全 ref が基準と同じであることを確かめる。1つでも欠ければ撮らない。面接室の最初の撮りは今どおり。 | 「**基準は切れない。** 全撮りは、盤面がこの checkout をまだ持ったことがない開き(行が無いか NULL の pickup と、読む場所の最初の開き —— 決定6)と quarantine の受理(決定4)だけが撮る。」(0351:24–25) | 0351:3 Status 追記(決定2 の比較の置き場所に着地が加わり、行が無い workspace では着地も最初の撮りをする ← ADR 0370 決定1)、0351:5(release 側の比較の対象 ← ADR 0356) | 効いている(resolution の決定3・4 の形は [上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240) で取り下げ。「最初の撮りに来た名前で Quarantine が立つ」は [追加2](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879709414) 決定12 で取り消し → 引けない名前は既存の `unknown workspace: <名前>` をその名前で立てる) | **一部置き換える** —— 「行が無いか NULL の pickup」を「まだ持ったことがない開き」と等置して無条件に撮る読みが偽になる(行が無い名前でも、他の行が欠ければ撮らない)。「読む場所の最初の開き」は決定11 で今どおり。受理の全撮りを消すのは #3185(別バッチ) |
| 0351 | 決定7 | #3239 [res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763) 決定1(「基準の寿命は登録から削除まで(ADR 0351 決定7 のまま)」)・「決め直す ADR」(「行の寿命 —— 扉を経ない消え方は止める」)、[追加2](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879709414) 記載漏れ(「盤面は消さない」) | 変えない + 決め直す(足す) | 削除の扉 → 再登録の全撮りは基準の寿命の終わりとして認める。扉を経ずに registry から消えた名前の行は盤面が消さず、残っている間は registry から引く名前の最初の撮りを止める。出口は名前を registry に戻すことだけ。 | 「**行の寿命は workspace の寿命である。** 削除の扉が行を消す(今日の扉は registry のエントリしか消さない)。path だけ差し替えた登録は次の pickup で1枚の question が立ち、回答が受理する。」(0351:43–44) | 0351:3 Status 追記(決定7 の「次の pickup で1枚の question が立ち」は着地の比較が先に立てる ← ADR 0370 決定1) | 効いている | **足すだけ** —— 寿命の文は真のまま。扉を経ない消え方の扱い(行は残る、最初の撮りを止める)と守る線(決定10)が足される。「path だけ差し替えた登録…回答が受理する」は #3185(別バッチ)の範囲 |
| 0087 | 決定2 | #3239 [res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763) 決定6・「決め直す ADR」(「ADR 0087 決定2 / 3(削除の拒否の理由に決定6 を足す)」) | 決め直す(足す) | 削除の扉は、その名前を名指す Quarantine(workspace、(claude, workspace)、(codex, workspace))が開いていて、かつその名前が基準の行を持つとき拒む。行を持たない名前の削除は通し、開いていた Quarantine は削除が閉じて event に残す。 | 「**参照中のリソースは扉で拒否する。** 未決着タスクが assignee / workspace として参照している agent / workspace は消せない(参照している件数を返す —— 先に cancel か再割当が筋)。」(0087:16–17)/「人間面の扉は事故を作らない門である。」(0087:21–22) | Status の行は無い | 効いている | **足すだけ** —— 拒否の理由が1つ増える。「事故を作らない門」の線と同じ向き |
| 0087 | 決定3 | 同上(ticket は「決定2 / 3」とまとめて名指し、どちらに足すかは言わない) | 決め直す(足す) | 同上。 | 「**消せない資源**: 盤面自身の registry clone(保護剥奪と同じく永久に拒む)、盤面の既定 agent と既定 workspace」(0087:23–24) | Status の行は無い | 効いている | **足すだけ** —— 決定3 は「消せない資源」(盤面のポインタが指す先、0087:25 の訂正)の規則で、決定6 は状態による拒否なので、形は決定2 の側に近い。registry clone の項目は #3238 が消す(1-4)。決定6 の「entry そのものが間違っている Quarantine の出口は削除」(path が registry clone と重なる entry)は、#3238 が registry clone の entry の永久の拒否を消すことに依る |
| 0370 | 決定1(行そのものが無い workspace の項) | #3239 [res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763) 決定9・限界、[上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240)(「決定9 は決定3(改)を掛ける」「#3166 にコメントを置いた。#3166 の実装は変わらない」)、map :249–250 | 決め直す。出口は「読んでいない」(照合していない) | 着地と「書き始める」が持つ最初の撮りにも決定3(改)の確認を掛ける。止めたときの出口は spec で決める。 | 「基準の行そのものが無い workspace(…)では、着地が pickup と同じ手続きで最初の撮りをする(ADR 0351 決定2)。違反として止めると出口が無い: 受理は行を作らず、pickup は収束の後にしか来ない。再登録した checkout をそのまま信じるのは最初の pickup と同じで」(0370:31–33) | Status の行は無い(2026-11-12 の ADR。spec は #3166、ticket の時点で未着手) | 効いている | **一部置き換える** —— 無条件の「最初の撮りをする」が条件つきになる。止めた場合の出口は**判定できない**: ADR は「止めると出口が無い」を理由に撮らせており、決定9 はその場面で止める。決定5・12 の出口(名前を registry に戻す / その名前の Quarantine の選択肢)がこの場面に届くかは、両方の文からは決まらない —— ticket 自身が「読んでいない」「spec で決める」と書く。同じ文の写しが Status 追記に2つある(0064:3、0351:3)ので、一緒に直る |

### 1-6. #3236(prototype を置くか)

ADR の行は無い。ticket は ADR を上書きも照合もしていない。ADR に触れる文は「#3194: …ADR の決定番号は 0243 以外コメントからの写し」([#3236-res](https://github.com/sinano1107/tidepool/issues/3236#issuecomment-6877476951) の「走らせる種類でない未確認」)の1つだけで、申し送りに置いた。

### 1-7. ticket が名指していないが、同じ決定が当たる箇所(私の grep。ticket の主張ではない)

行にはしていない。終点で拾うかどうかの材料。

- **ADR 0291 決定の地の文(0291:40)** 「registry workspace に registry-edit の work タスクを立て PR と人間 merge の門(ADR 0019)に乗せる形で」—— #3238 の後は「registry の repo の別の clone を workspace にした」registry-edit タスク。`GLOSSARY.md:66` と同じ直し。`grep -F 'registry workspace' docs/adr/` は 0081 と 0291 だけ。
- **ADR 0052 決定5(0052:89「レジストリ到達性は封じ込め能力の兄弟であり、盤面全体を止める」)** —— #3238 決定5 が default branch の検査をこの検査へ移す。ticket の一覧は 0052 決定3 だけを挙げる。足すだけの形に見える。
- **ADR 0064:3 と ADR 0351:3 の Status 追記** —— どちらも ADR 0370 決定1 の「行が無い workspace で着地が違反として止めると出口が無い」を写している。#3239 決定9 が当たる。
- **ADR 0087 決定4(0087:31「workspace の削除は registry エントリだけ。」)** —— ADR 0351 決定7 で削除の扉は基準の行も消すようになっているが、0087 に Status 追記が無い(今ある食い違い)。#3239 決定7 は sparse の pin も行ごと消えることに頼る。
- **ADR 0087 決定6(0087:39「記録は registry の commit のみ」)** —— #3239 決定6 は「開いていた Quarantine は削除が閉じて event に残す」。削除そのものの記録は commit のままと読めば矛盾しないが、ticket は照合していない。
- **ADR 0064 Considered options(0064:225–227、:233–235)** —— 「**荷重のある ref だけを列挙する**…誤検知面がほぼ無く、人間のスクラッチブランチも registry clone の衝突も起きない。」は退けた案の利点に registry clone の衝突を数えている(#3238 の後は衝突そのものが無い。退けた理由 = 決定1 と ADR 0023 は変わらない)。「**セッション中は盤面自身の書き込みを直列化する**…slot=1 で常に何かが走っている以上、registry 編集がしょっちゅう拒まれる。」は退けた理由が registry の書き込みと workspace の ref の束ねに依っていて、#3238 の後は registry 編集がどの workspace の ref も書かないので、この理由は当たらなくなる(案を採り直すかは別の問い)。
- **ADR 0066 決定5・ADR 0087・ADR 0351 は #3254(別バッチ)も「照合する」に挙げている**(map :321。ADR 0093・0067 と `GLOSSARY.md` 451行・645行も)。#3238・#3239 の行と同じ決定に重なる。
- **ADR 0052 の根拠の節**(0052:130–131・:172 の `guardRegistryDefaultBranch`、:150–153 の Pi の `registry` エントリ)—— 当時の実測と経緯の記述。
- `grep -F` の結果: `唯一の保護 workspace` は 0040・0064、`RegistrySelf` は 0066、`resolvesToRegistryClone` は 0052・0066、`guardRegistryDefaultBranch` は 0052・0081、`registry clone` は 0040・0052・0064・0066・0081・0087・0277・0339 の8本(ticket 本文の「8本」と一致)。

## 2. GLOSSARY.md の行

行番号は main `3e2447ac` の `GLOSSARY.md`(742行)で確かめた。

| 語(見出し) | GLOSSARY.md の行番号と今の文 | 直す内容 | ticket と comment URL |
|---|---|---|---|
| (新規)作業台(Workbench)/ 取り込み(Intake)/ 書き始める(Start work) | 見出しは無い。「書き始め」「取り込」は 0 件、「作業台」は L569 の1件だけ | 3語を足す。定義は resolution の「語」1〜3。「ref の event を持つ H」は「タスクブランチを持つ H」と書く(述語は `task_branch_created` がある、のまま) | #3235 [res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933)、map :204 |
| task の checkout(L567) | L569「名前の場所(面接室を含む)は盤面だけが書く記録で、worker の作業台と盤面の記録は別の `.git` である。」 | 「worker の作業台 = task の checkout」と読める形に直す | #3235 [res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933) 決定1 |
| Decompose(L84) | L94「自分の human タスクは着手した後でも決着まで割ってよい — human タスクは slot に入らないので、着手しても `todo` のまま」 | 人間担当の work の「着手」を「書き始める」に当てるかを確かめる(直すとは決めていない) | #3235 [res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933)「並走する issue への申し送り」 |
| Workspace(L643) | L645「人間用の checkout は盤面の checkout と分ける」/「人間はホスト上でそれを覗くが、書かない — 人間が ref を動かせば…quarantine が立ち」 | 人間が書く場所として作業台を指す形に直す | #3235 [漏](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877276653) |
| (直さない。語を採らなかった根拠)「人間の checkout」「人間用の checkout」 | L387「人間の checkout の ignored は繰り返し消えない」、L631「人間の checkout の origin が ssh 綴りでも」(同じ行にもう1回)、L645「人間用の checkout は盤面の checkout と分ける」、L653「旧・worker が人間の checkout で走っていた頃」 | 直さない。ticket の `GLOSSARY.md:387, 631, 645, 653` と一致 | #3235 [res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933) 決定1 |
| 記録された場所(L577) | 見出し「## 記録された場所(Recorded place)」 | 作業台は入らない(消さない場所の語。作業台は鍵ごとに消える)。今の文を変える指示は無い | #3235 [res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933) 決定1、map :204 |
| Review flag(L76) | L78「**非ルートの子を、統合点を待たず個別に完了時レビューへ出す**ためのタスク単位の opt-in」 | 直さない(「個別にレビューに出す」= `review_flag` と一致、と ticket が読んだ) | #3235 [res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933) 限界 |
| (未決)「書く先」「運ぶ側」「包む commit」 | 見出しは無い | `GLOSSARY.md` の語にするかは決めていない。終点で確かめる | #3235 [漏](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877276653) |
| Registry(L633) | L635「v1 唯一の保護 workspace。」 | 書き直す(registry clone は workspace でない。保護は registry と同じ repo を origin に持つ workspace に計算で掛かる) | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) 末尾 |
| Workspace(L643) | L645「registry clone だけは Registry の正本としての宣言も併せ持つため宣言が2つあり、その食い違いも同じく quarantine に落ちる。」 | 消す(宣言は1つ) | 同上 |
| Quarantine(L449) | L451「registry clone が持つ**2つの宣言**が食い違っていること(registry の正本としての役と workspace としての役を1つの checkout が兼ねるため宣言も2つあり、1本化はできない — …」 | 消す(契機そのものが無くなる) | 同上 |
| 危険な値(L252)—— ticket は「保護剥奪の」と書く | L262「**確認で買えないものが1つある** — registry workspace 自身の保護剥奪(ADR 0013)。」 | 鍵を替える(`RegistrySelfUnprotectError` は残り、対象は registry と同じ repo を origin に持つ workspace)。名前と文面は spec | #3238 [res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) 末尾・「消える機構」 |
| Review(L56) | L66「システムへの改善提案は registry を workspace とする registry-edit タスクの decompose として現れ」 | 「registry の repo の clone を workspace とする」に読める形へ | #3238 [漏2](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6878032122) |
| Registry(L633)の削除の段 | L639「人間面の削除の扉は事故を作らない門であり、未決着タスクが参照している agent / workspace(…)、いずれかの agent が参照している profile、盤面自身の registry clone、盤面のポインタが指す先(…)は消せない。」 | 削除の拒否の理由に決定6(その名前を名指す Quarantine が開いていて、行を持つ)を足す | #3239 [res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763)「決め直す ADR」、map :250 |
| Registry(L633)の「帯域外の手編集」 | L635「帯域外の手編集はリモートに載らない限り無効。」 | resolution の一覧に在るが、何を直すかは書かれていない。決定2 はこの文に頼る側(「remote に載った変更は効く」)で、足すなら「扉を経ずに名前が消えた workspace は違反として捕まえる」。map :250 は「Registry(削除の段)」だけで、この句を落としている | #3239 [res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763) |
| Workspace(L643)の単射 | L649「「workspace 名 → リポジトリ」の対応が単射であること…は、registry を組む人間が守る前提であり、盤面は強制しない」 | **取り消された**(直さない)—— 決定4 を取り下げたので、盤面は今どおり強制しない → [#3239-上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240) | #3239 [res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763) → [上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240) |

ticket が名指していないが当たる行(私の grep):

- L639「盤面自身の registry clone」(削除の扉が消せないものの列挙)—— #3238 が `RegistrySelfDeleteError` を消すので、ADR 0087 決定3 と一緒に落ちる。#3238 の GLOSSARY の一覧には無い。
- L651「**保護 workspace(protected)**: 感度を資源側に張り付けるマーカー。」—— #3238 決定6 で保護は flag と計算の和になる。
- L453「workspace は「registry に存在し、ツリーがクリーンで、`.git` がディレクトリで、かつ盤面自身の状態パスと重ならない」(ADR 0040 / ADR 0146)」—— #3238 決定4 で固定点に registry clone が足される(受理の検査は固定点の一覧を読むので、文は真のまま)。
- L451「registry に存在しない workspace 名への遭遇(観測者は走る前なら pickup の門、…)」—— #3239 決定12 が、最初の撮りの前の確認を観測者に足す(既存の `unknown workspace` の器を使う)。

## 3. 申し送り

#3237(置き換える ADR の範囲を確定する)と終点へ:

- 「`GLOSSARY.md` と ADR は map の Notes どおり終点で書く。」—— [#3235-res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933)
- 「ADR 0356 は題で「worker の作業台」と言う —— 決定1 と同じ向きだが、「作業台」単独が人間の側の語になるので、置き換える ADR の範囲を確定するときに読み方を確かめる。」—— [#3235-漏](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877276653)
- 「「書く先」「運ぶ側」「包む commit」は…`GLOSSARY.md` の語にするかは決めていない。終点で確かめる。」—— [#3235-漏](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877276653)
- 「`GLOSSARY.md` の Decompose(94行)は人間タスクに「着手」を使っている。終点で、人間担当の work の「着手」を「書き始める」に当てるかを確かめる。」—— [#3235-res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933)
- 「4本とも `wayfinder:task`(AFK)で、互いに独立。全部が「置き換える ADR の範囲を確定する」(#3237)を塞ぐ。」—— [#3236-res](https://github.com/sinano1107/tidepool/issues/3236#issuecomment-6877476951) 決定4
- 「task は測るだけで決め直さない。決定を覆す結果が出たら grilling の ticket を足して #3237 を塞ぐ。」—— [#3236-res](https://github.com/sinano1107/tidepool/issues/3236#issuecomment-6877476951) 決定5
- 「1 session に収まらなかった行はそう書かず、残りを新しい task に切って #3237 を塞ぐ。」—— [#3236-訂正](https://github.com/sinano1107/tidepool/issues/3236#issuecomment-6877505291)
- 「#3194: 予告なしの2経路が実際に起きた例。ADR の決定番号は 0243 以外コメントからの写し。」—— [#3236-res](https://github.com/sinano1107/tidepool/issues/3236#issuecomment-6877476951)(#3194 が引く ADR の決定番号は本文と照合されていない、という申告)
- 「終点で照合する ADR。ADR 0241(push の手順、決定4 の「作る前に PR を探す」)、ADR 0242 決定2・4…、ADR 0105 決定2(追いつきの順)、ADR 0243 / ADR 0052 Status 追記…、ADR 0240 決定2…。本文は ADR 0330 の決定の見出ししか読んでいない。」—— [#3233-漏](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875961664)
- 「### 終点で書き直す ADR / GLOSSARY —— ADR 0040(対象外の反転)、0052 決定3(宣言は1つ)、0064 決定4 の表の registry の3行と「呼び忘れは registry の fetch で即座に露見する」の論拠、0066 決定5 の2項目目、0087 決定3 の registry clone の項目、0243 決定3・4 の registry の書き込み、0020 決定1 の行き先、0013(床の鍵)。」—— [#3238-res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162)
- 「ADR 0243 決定4「盤面の ref の書き込みはすべて口を通る」の対象は名前の場所に限ると書き直す(終点の ADR の一覧に既にある)。」—— [#3238-漏2](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6878032122)
- 「0020 / 0040 / 0052 / 0064 / 0066 / 0081 / 0087 / 0243 / 0277 / 0339 / 0351 は sub-agent の通読、0040 L17–19・0052 L71–73・0064 L109–115 は読み直した。」—— [#3238-res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162)(map :231 も「ADR 11本は sub-agent の通読」)
- 「### 決め直す ADR(終点でまとめて書く)—— ADR 0351 決定2(最初の撮りの条件に決定3・4 を足す)・決定7(行の寿命 —— 扉を経ない消え方は止める)、ADR 0087 決定2 / 3(削除の拒否の理由に決定6 を足す)、ADR 0370 決定1(着地の最初の撮り)。」—— [#3239-res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763)(「決定3・4」は [上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240) の決定3(改)と読み替える。map :250 は「守る線(決定10)を書く」を足している)
- 「ADR 0370 決定1 に条件を足す件は #3166(未着手)にコメントを置いた。#3166 の実装は変わらない。」「「決め直す ADR」の `GLOSSARY.md` Workspace(単射)は取り消す」—— [#3239-上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240)
- 「決定9 の着地の側: 着地の最初の撮りを止めたときの出口は読んでいない(ADR 0370 決定1 は「止めると出口が無い」を理由に着地に最初の撮りをさせている)。」—— [#3239-res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763) 限界
- 「前提: registry を共有する盤面は1つ。…共有を決めた ADR は grep の範囲に無かった。」—— [#3239-res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763) 限界(map :251 も同じ)

#1796・#3246 との関係(誰がどの ADR を書くか):

- 「床の穴は main に今ある(registry と同じ repo の別の clone を保護なしで登録できる)。決定3・6 は map の spec を待たずに単独で入れられるので、#3246 に出した(`priority:high`、走らせていない)。」—— [#3238-訂正](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877985910)。map :227 は「床の直し(保護の判定の計算)は #3246 が単独で先に入れられる。spec は入っていなければ持つ。」—— ADR 0013 の書き直し(床の鍵)を誰が書くかは #3246 が先に入るかで変わる。ticket は書き手を明言していない。

- 「#1796 は `task_branch_created` に当たる event を先に実装する(open、未着手、PR なし —— 2026-11-14 に確認)。名前をそちらにコメントした。」—— [#3235-res](https://github.com/sinano1107/tidepool/issues/3235#issuecomment-6877213933)。このバッチで #1796 に触れるのはこの1文だけで、ADR の書き手は言っていない(「列と系譜の ADR は #1796 の spec の session が書く」は #3213 の block、map :150、別バッチ)。

バッチの外へ出した上書き(他バッチの純効果に効く):

- #3233 → #3203: 決定3・12 と決定10 の1句を取り消す、決定11 と訂正の表は決定6 の1行に畳む、決定1 の「足しただけ → 取り込み」を読み替える。→ #3190: 訂正の「扉ができた後は外からの push でも解ける」を取り消す(追加の決定5 は残る)。→ #3191: 上書きコメントの理由が当たらなくなり、本文が2つ足される。#3232・#3210・#3235 にもコメント。出所は [#3233-res](https://github.com/sinano1107/tidepool/issues/3233#issuecomment-6875805890) の「他の決定への上書き」。
- #3238 → #3234(全部)、#3196(「registry clone の口の fallback は進む先の commit から名前を引いて予告する」と #2980 の直しを取り消す)、#3184(「registry clone に当たる workspace は拒む」は該当なし)、#3205(決定6「registry clone も除外しない」は該当なし)、map の Out of scope の H14 を spec へ戻す。#3200・#2470・#3087・#3243・#3245・#3239・#3242 にコメント。出所は [#3238-res](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162) と [漏2](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6878032122)。
- #3239 → #3185(決定3 の「行が無い名前は比べずに通す」に条件が足される、削除の扉が開いている Quarantine を見る)、#3183(「削除の扉 → 再登録」は、行を持つ名前に Quarantine が開いている間は通らない)、#3166、#3240。出所は [#3239-res](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879521763) の申し送りと [上書き](https://github.com/sinano1107/tidepool/issues/3239#issuecomment-6879644240)。
- #3235 → #3216(未決「既定の refspec で fetch できる名前に置くか」を「置く」で閉じる)、#3191(決定3 の「名前が未定なので path だけで指す」は前提が消えた)、#1796。ADR には当たらない。

## 4. 読んだ範囲

ticket(`gh issue view <n> --json title,body,comments`、本文と全コメントを全文で読んだ):

- #3233: コメント 4/4。
- #3234: コメント 3/3。
- #3235: コメント 3/3。
- #3236: コメント 3/3。
- #3238: コメント 7/7。
- #3239: コメント 6/6。
- map の写し: 冒頭〜:71(Destination・Notes・Decisions so far)、:186–232、:245–252、:341–360(Out of scope の後半)を全文、:74–340 の残りは見出しと `ADR / GLOSSARY` の行だけ。

読んでいないもの:

- 他の ticket に置かれた上書きコメントの本文(#3203・#3190・#3191・#3196・#3184・#3205・#3185・#3183・#3166・#3240・#3210・#3232)は開いていない。このバッチの ticket の側の記述だけで「置いた」と書いた。
- #3254 の resolution は開いていない(#3238 に付いたコメントと map :326 の要約だけ)。
- src は開いていない。ticket の `file:line` とコードの読み(spawn の検査が task の checkout を見る、床の鍵が path、など)は確かめていない。

ADR(全部開けた。開けなかったものは無い)。表の「ADR の Status」の列は、行番号と「どの決定が何で置き換わったか」の要約で、Status 追記の文の逐語の写しではない:

- 全文: 0013、0020、0040、0087、0241、0242、0243、0351。
- 一部: 0052(:1–127、:140–187。:128–139 は grep に当たった行だけ)、0064(:1–15 の Status と見出し、:93–135、:219–240。決定1〜3・5〜7 の本文は見出しだけ)、0066(:1–10、:51–59、「registry」「取り込」に当たった行)、0105(:1–40)、0240(:1–40)、0330(:1–51)、0356(:1–40 と「作業台」の grep)、0370(:1–45)、0081(:1–12、:34–40)、0277(:1–9、:58–61)、0339(:1–9、:34–42)、0291(:1–3、:39–40)。
- grep だけ: 0067・0131・0055・0276 の「取り込」の行。
- `GLOSSARY.md`: 句ごとの grep で行番号と前後の文を確かめた。行の全文は読んでいない(L645 は 4,614 字、L451 は 4,451 字)。
