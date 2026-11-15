# map #3178 が置き換える ADR の行 —— B(#3181・#3182・#3183・#3184)

読んだ時点: main `3e2447ac`(2026-11-15)。ADR は `docs/adr/NNNN-*.md` を開いて照合した。何も走らせていない。

読み方:

- `cN` は `gh issue view <n> --json comments` の 0 始まりの添字。URL は末尾の参照定義にある。
- 「ADR 側の該当文」の `0351:35–36` は `docs/adr/0351-*.md` の 35〜36 行。ADR ごとの完全な file 名と Status 行の原文は 1-c に置いた。
- 「動詞」は ticket の言い方のまま(決め直す / 広がる / 結論だけ残る / 足す …)。ticket が ADR を根拠・日付・材料として引いただけの行は「引く」と書いた。
- 「判定」は ADR の本文を開いて、ticket の決定と文を突き合わせた私の読み。「置き換える」は ADR の文が偽になる、「一部」はどの文かを書いた、「足すだけ」は ADR の文は真のまま広がる。
- 新しく書く文は map の語(作業台・取り込み)で書いた。引用は元の語のまま。

## 1. ADR の行

### 1-a. ticket が名指した行

| ADR | 決定/追記/節 | ticket と comment URL | 動詞 | ticket 側の決定(1〜2文) | ADR 側の該当文(引用、file:line) | ADR の Status | 純効果(効いている / 取り消された → URL) | 判定 |
|---|---|---|---|---|---|---|---|---|
| 0351 | 決定4(「verb は作らない」とその理由) | [#3182 本文][82]、[c2][82c2] 決定1、[c5][82c5] 限界 | 決め直す →「結論だけ残り、理由(同じ回答で受理される)は消える」 | 入口は今と同じ回答で、verb も新しい選択肢も作らない。人間は作業台で merge を書き、回答が tip を取り込む(名前の場所に手で書いたものを受理が飲む形ではなくなる)。 | 「ADR 0239 帰結の手の `merge -s ours` は quarantine 中の checkout で行い、同じ回答で受理されるので verb は作らない。」(`0351:35–36`) | Status 追記×3(L3・L5・L7)。L3「決定4 の受理は変えていない: Quarantine が開いている間に動いた ref を見せないまま受け入れる穴は実測済みで、直し方は人間の内容の扉の設計(#3158)に渡した」。L5「決定1・3・4・6・7 は残る」 | 効いている。conflict の入口(H1 / H5 / H6 / H7 / H3)については決定1 のまま。別の入口が後から足された —— #3184 決定1・4(workspace の操作 + question、[c3][84c3])、完了の扉と「完了を伴わない取り込みの操作」(#3214 から [c9][82c9])。c9 は決定1 を上書きしたとは書いていない。[c10][82c10](#3216)は決定5 だけを取り消す | 一部置き換える —— 「quarantine 中の checkout で行い、同じ回答で受理されるので」の句が偽になる(書く場所は作業台、受理は取り込み)。「verb は作らない」は残る |
| 0351 | 決定4(「verb は作らない」) | [#3184 c3][84c3] 決定1・限界 | 「契機についてだけ決め直す」 | purely-local の保護ブランチ向けに、人間が始める workspace の操作を1つ足す。操作は作業台と question を立てるだけで、取り込む入口はその回答。 | 同上(`0351:35–36`) | 同上 | 効いている。名前は #3235 が付けた(map の要約: `open_workbench` と question `intake`)。remote-backed は拒む(決定4・14)。決定12(registry clone を拒む)は [c15][84c15] で該当なしになった | 足すだけ —— `0351:35–36` の「verb は作らない」は ADR 0239 帰結の修理について言う文で、足す操作は契機だけを持つので文は偽にならない。上の #3182 の行と合わせて1回で書き直す箇所 |
| 0351 | 決定1 | [#3184 c3][84c3] 限界(「決め直す ADR(0351 決定1・4 …)」) | 決め直す(どの文かは ticket に書かれていない) | 同上(決定1・2・4)。H18 は封じ込めの Quarantine の回答が取り込む。 | 「人間の変更は verb か question の回答を通ってだけ基準に入る。」「『人間は盤面の checkout に書かない』(人間用の checkout を分ける運用、#2842 の前提)に置き換わる」(`0351:21–23`) | 同上。L5「決定1・3・4・6・7 は残る」 | 効いている | 足すだけ —— 取り込みは question の回答なので L21 の文は真のまま。「人間用の checkout を分ける運用」の中身が作業台(と、#3216 以後は自前の clone から作業台への push)になる。ticket がどの文を偽と見たかは本文から読み取れなかった |
| 0240 | 決定4 | [#3182 c2][82c2] 冒頭・決定11、[c5][82c5] 限界(「0240 決定4 の広がり」) | 「広がる」/冒頭では「『手で解く』を決めた」ADR として問い直す | H5 は `pr_promotion_retry` の `retry` が merge back を撃ち直す。範囲はその root の分解ツリーだけ、条件は受理と同じ。 | 「**merge back は、workspace の quarantine の受理の検査の中でやり直す。**」(`0240:27`)「conflict すれば merge を取り消して回答を拒む。拒否文には出口を2つ示す。手で merge を解くか、捨てるなら `git merge -s ours` で記録するかである(ADR 0239 帰結)。」(`0240:29–30`) | Status 追記×3。L3(→ADR 0370)帯域外の quarantine が着地からも立つ。L5(→ADR 0369)「受理の検査の中でやり直す」ものに済まなかった解放が加わる。L7(→ADR 0243)merge-tree で先に作る形。「やり直す場所・拒否文の2つの出口・休止位置へ戻すことはそのまま」 | 効いている。撃ち手の最終形: 後始末、Quarantine の受理(既存)、`retry`(決定11)、人間の完了の扉(H の1件だけ、#3214 から [c9][82c9])。[c8][82c8](#3207): 決定11 の発生源とした「人間の完了の扉で `done` になったブランチ持ちの work」は今のコードでは生じず、#3207 の実装後に生じる。決定11 は残る。「人間が解く必要があるか」の問い直しは #3188 で「要る」に落ち、worker に寄せる形は #3189(map の外) | 足すだけ(撃ち手が増える。`0240:27` は真のまま、唯一の場所ではなくなる)。`0240:29–30` の「手で merge を解く」は場所が作業台に変わる —— 場所を言う文は 0240 でなく 0351 決定4 と 0239 の Status 追記 L3 にある |
| 0105 | 決定2 | [#3182 c2][82c2] 冒頭、[c5][82c5] 限界 | 決め直す(「手で解く」を決めた ADR) | H6(追いつきの conflict): 盤面が拒むその操作の中で (workspace, `task/<id>`) の作業台を開き、人間の tip が書く先の今の値と `origin/<保護>` を祖先に持つことを確かめて `retry` が取り込む。 | 「合わなければ PR は開かず、既存の PR 昇格失敗 question に落ちる…retry は同じ経路を再走するので、人間がセッション外で手で解決すれば通る。」(`0105:29–30`) | Status 追記 L3(→ADR 0370 決定1・7)「解決が名前の場所の ref を動かすので、retry が着地の比較に当たって workspace の Quarantine を1枚経てから、もう一度 retry で通る」。Status L5(決定4 → ADR 0217) | 効いている。#3190 が「worker の task に寄せない」と決め、H6 は人間の入口のまま(map の要約: 回答は1回、昇格の失敗の時点で作業台を開く)。#3233 が、外の commit があるときも同じ形(作業台 → `retry`)に乗せた(map の要約) | 一部置き換える —— `0105:30` の「人間がセッション外で手で解決すれば通る」(解く場所が作業台になり、`retry` は再走の前に取り込む)。Status 追記 L3 の「Quarantine を1枚経てから」は偽になる |
| 0103 | 決定4 | [#3182 c2][82c2] 冒頭、[c5][82c5] 限界 | 決め直す(「手で解く」を決めた ADR) | H7(local 着地の conflict): `local_merge` の `merge` の拒否の中で (workspace, 保護ブランチ) の作業台を開き、次の `merge` が取り込む。 | 「**snapshot 一致下の merge 失敗(コンフリクト含む)は回答拒否であって quarantine ではない。**…エラーは回答者にそのまま返り、question は開いたまま残る。」(`0103:33–35`) | Status 追記×4。L3(→ADR 0370 決定1・7)「決定4 の回答拒否に従った手の解決は ref を動かすので、次の回答はこの比較に当たって Quarantine を1枚経る」。L9「決定1・2・4・5 はそのまま」 | 効いている。#3190 が H7 を人間の入口のままと決めた(map の要約: 回答は2回、最初の `merge` の拒否で開く)。#3184 決定9 が同じ作業台を「取り込む」と共有させる | 足すだけ —— **ADR の決定4 の本文は「手で解く」と書いていない**(回答拒否であって quarantine ではない、まで)。手の解決を言うのは Status 追記 L3 で、その末文(Quarantine を1枚経る)が偽になる。決定4 の本文は真のまま、拒否が作業台を開く点が足される |
| 0356 | (番号なし) | [#3182 c2][82c2] 冒頭 | 引く(日付の基準:「どれも ADR 0356 より前」) | — | 0356 は 2026-11-07(`0356:23`)。0240 は 2026-10-12、0105 は 2026-08-29、0103 は 2026-08-27 | Status 追記×10(L3〜L21、この行に関係しない) | — | 矛盾しない(日付は ticket の言うとおり)。map L204 は「ADR 0356 の題の『worker の作業台』の読み方」を #3235 の持ち分として挙げている —— この4 ticket の中にその指摘は無い |
| 0359 | 決定1 | [#3182 c2][82c2] 決定3 | 引く(「その順を決めた ADR は見つからず(ADR 0359 決定1 は `done` ⇔ tip が記録にある、だけ)」)。完了の門の順は「借りない」 | 入口は検査を盤面所有の写しの中で済ませ、全部通ってから名前の場所の ref を書く。 | 「完了の門は、worker の tip が名前の場所の `task/<id>` になるまで `done` にしない。…`done` ⇔ tip が記録にある。」(`0359:18–20`) | Status 追記×3(L3・L5・L7、決定1 には触れない) | 効いている | 矛盾しない —— 決定1 は門の順(ref を書いてから検査)を決めていない。「順を決めた ADR は見つからず」の網羅は確かめていない(0359 以外は開いていない) |
| 0364 | (番号なし) | [#3181 c0][81c0] 理由 | 「ADR 0364 の読み方が当たる」 | 扉の無い3セルは作業台で書く。盤面が作れば path と形を盤面が知っているので、入口は path も sha も運ばない。 | 下の #3182 の行と同じ文(`0364:22`、`0364:31–32`) | Status 追記×3(L3 →0367、L5・L7 →0365) | 効いている。[c5][81c5](#3216): 決定1 の「持ち込みは受けない」は「入口は自前の clone の path も sha も受けない」に狭まる —— 盤面が読むのは作業台の tip だけ、は変わらない | 足すだけ(下の #3182 の行と同じ判定。読み方の中身を決めたのは #3182 決定7) |
| 0364 | (番号なし) | [#3182 c2][82c2] 決定7 | 「読み方は ADR 0364 と同じ手」 | 入口は ADR 0364 の読み方で作業台の tip を読む(`readWorkerTip` の branch 名 —— `task/<呼んだ task の id>` 固定 —— を引数にする)。 | 「**盤面は spawn の後、task の checkout の `.git` を git にリポジトリとして開かせない。** 読むのは allowlist の regular file だけ」(`0364:22`)「不変条件: **記録に入る object は、名前の場所に既にあるか、worker が自分の checkout の `objects/` に regular file として書いたもののみ**。4つの役とも同じ1つの手。」(`0364:31–32`) | Status 追記×3(L3 →0367、L5・L7 →0365) | 効いている。[c10][82c10](#3216): 入口は今どおり path も sha も受けず、盤面が作った作業台の tip だけを読む | 足すだけ —— ただし `0364:31–32` の不変条件の列挙(「worker が自分の checkout に書いたもののみ」「4つの役」)は、人間が作業台に書いた object と盤面が作る包む commit が入るので、項が足りなくなる。ticket はこの文を名指していない |
| 0364 | 決定1(「門は祖先を確かめない」) | [#3182 c3][82c3] | 「採否は…決め直す」(条件つき: 完了の門で worker に帰り先へ追いつかせる形を採るなら) | — | 「tip が fork 元と無関係な commit でもよいのは今日どおり」(`0364:33`) | 同上 | **この map では置き換えない** —— [c5][82c5] の 1.「完了の門で worker に帰り先を merge させる形は、この map で決めない。#3189 に出した」 | 矛盾しない(map は決めていない) |
| 0053 | 決定2(非 ff の merge back の根拠) | [#3182 c3][82c3] | 「採否は…決め直す」(同じ条件つき) | — | 「**ff-only では撃たない。** 正当な非 ff が起きる」(`0053:89`) | Status×2(L3: 決定3 → ADR 0289。L5: 決定1 の着地判定 → ADR 0105、決定3・4 → ADR 0103)。決定2 には触れない | **この map では置き換えない** —— 同上(#3189) | 矛盾しない(map は決めていない) |
| 0359 | 決定4 | [#3182 c4][82c4] | 引く(#3189 の材料:「門は verb で、基準と比べない」) | — | 「ref の門(`writeBoardRefs`)は verb では基準を比較せず、人間の ref の移動は解放の基準比較(ADR 0351)が今日どおり名前の場所の quarantine にする。」(`0359:30–31`) | Status 追記 L7(→ADR 0363 決定2)決定4 が drift にも広がる | 置き換えない(#3189 の材料)。#3185 の resolution は「ADR 0359 決定4 は変えない」と書いている(該当行だけ読んだ) | 矛盾しない |
| 0369 | (番号なし) | [#3182 c4][82c4]、[c5][82c5] 申し送り | 引く(「ADR 0369(未実装)は merge back の手前に『運ぶ』のやり直しを置く」) | H1 の取り込みは受理の `redoMergeBacks` の中に入る。受理の順のどこに置くかは #3185 へ申し送り。 | 「**名前の場所の事情で済まなかった解放は、その workspace の Quarantine の受理の検査の中でやり直す。**」(`0369:15`) | Status 追記 L3(→ADR 0370)「決定3 の『受理そのものの範囲は #3151』は、人間の内容の扉の設計(#3158)に移った」 | 申し送り先の #3185 が受理の順を決めた(決定15、map の要約)。「未実装」は古い —— map の Notes では main `3e2447ac` で3本のうち2本(#3153・#3154)が入っている | 矛盾しない(#3182 は 0369 を変えない)。0369 決定3・決定7 の末文の置き換えは #3185 の持ち分 |
| 0053 | 決定1 | [#3182 c6][82c6] | 引く(「帰り先は `done` の祖先でもありうる」) | 決定8(人間しか書けない path を一律に拒む)の軸は「書く先の task が未決着か」。決定は一律なので結論は変わらない。 | 「A が未決着(統合幹として今も使われる)、または `rev-list --count <今の候補>..task/A` > 0(候補へ未着地の独自コミットを持つ)なら 候補 = task/A。」(`0053:34–36`) | Status L5「決定1 の着地判定(`rev-list` による履歴の収束)は ADR 0105 で『内容で測る』に置き換え済み」 | — | 矛盾しない(ADR は ticket の言うとおり)。map L150 は 0053 決定1・3 の書き直しを #3213 の持ち分として挙げている |
| 0100 | (番号なし) | [#3181 c0][81c0] 理由 | 引く(「purely-local では host をまたぐ道が無い(盤面は Linux VM の中、ADR 0100)」) | 自前の clone からの持ち込みは受けない。 | 「**本人の Mac 上の盤面は、Mac 上の systemd を持つ Linux VM の中で動かす。**」(`0100:14`) | Status 行なし | 理由は取り消された → [#3181 c5][81c5](#3216):「『purely-local では host をまたぐ道が無い』は実測で偽だった」。決定1 は「入口は自前の clone の path も sha も受けない」に狭まり、自前の clone から作業台への push は正規の道 | 矛盾しない —— ADR 0100 は「VM の中で動く」までで、「host をまたぐ道が無い」とは書いていない。偽になったのは ticket の推論で、ADR は無傷 |
| 0052 | (番号なし。該当は決定1) | [#3181 c0][81c0] 理由・決定2 | 引く(「remote-backed の保護ブランチは origin が正本」) | remote-backed の保護ブランチ向け(H18・H19・N1)は origin 経由のまま。 | 「盤面が読むのは `refs/remotes/origin/<protected>` であり、ローカルの同名ブランチではない。ホスト上の clone は正本ではなく読み取りキャッシュに格下げされる。」(`0052:37–38`) | Status 追記×4。決定1 に触れるのは L9(→ADR 0339 決定5): 写しは push の成功を見て盤面が口の中で `update-ref` で書く | 効いている。[c1][81c1] が Claude の H18 だけに狭め、[c3][81c3](#3205)と [c4][81c4](#3206)で H19・N1 も origin 経由に確定。[c2][81c2](#3195)は「`refreshProtectedBranch` で引く」を pickup では `fetchBranchCopy` と訂正(コードの読みで、ADR の文ではない) | 矛盾しない(揃う) |
| 0362 | (番号なし) | [#3181 c1][81c1] 訂正2 | 引く(「ADR 0362 は人間がどこに書くかを言わず、この場面には question も受理も無い」) | remote-backed の H19 の扉は未検証(#3181 の時点)。 | 決定1「**worker は workspace の Claude settings の書き手になれない。**」(`0362:19–21`)—— 人間の書く場所を言う文は決定1〜3 に無い | Status 追記×3(L3: 列は形で決まる、L5: Codex の形も持つ、L7: 人間の FS の解決で読む) | 決まった → [c3][81c3](#3205): remote-backed の H19 は扉を作らず origin 経由。purely-local は #3184 決定1・4 | 矛盾しない —— ADR は書き手の場所を決めていない(ticket の言うとおり) |
| 0362 | (番号なし) | [#3184 本文][84] | 引く(「人間しか書けない path の検査(ADR 0362)は author を見ず、path の形だけで拒む」) | H18 / H19 の内容を通すには、入口が「人間が渡した」ことを何で知るかを決める(→ 決定5: 場所と面で担保し、身元の検査は足さない)。 | 決定2「**完了の門は、tip の2 path の entry(mode と blob、在る↔無いを含む)が fork 元との merge-base と違えば path を名指して拒む**」(`0362:22`) | 同上 | 効いている(決定5 を上書きするコメントは無い。[c14][84c14](#3216)は「決定5…は変わらない」) | 矛盾しない —— 門は entry を比べるだけで author を読まない(ticket の言うとおり) |
| 0362 | 決定1(「書き手の道」) | [#3184 c3][84c3] 確かめたこと・限界 | 決め直す(「0362 決定1 の書き手の道」) | 人間しか書けない path は、purely-local では「取り込む」と H18 の封じ込めの回答が通す(決定6 の表)。conflict の入口は拒む(#3182 決定8)。 | 「**worker は workspace の Claude settings の書き手になれない。** 記録の中で `.claude/settings.json` と `.claude/settings.local.json` は人間しか書けない path であり、これは記録の軸の決定で Harness に依らない。」(`0362:19–20`) | 同上 | 効いている。remote-backed は origin 経由(#3205)。[c11][84c11]: remote-backed を拒む文は出口の4要素を言う | 足すだけ —— 決定1 は真のまま、人間の書く道(場所と入口)が足される。決定2(門が拒む)に「conflict の入口と完了の扉の取り込みも同じ path を拒む」が足される(#3182 決定8、[c9][82c9])—— ticket は決定2 を名指していない |
| 0239 | 帰結(+ Considered options の4つ目) | [#3183 本文][83]、[c1][83c1] 決定1・限界 | 決め直す →「結論が残り、『git の側で表せる』の場所だけが盤面の開く checkout に変わる」 | 「修理を捨てる」選択肢は足さない。捨てるのは作業台で片側の tree を採る merge を commit して同じ回答。 | 「人間が修理を捨てるなら、workspace で着地するタスクのブランチへ修理のブランチを `git merge -s ours` で記録し、そのブランチを push する…か、盤面の外で merge する」(`0239:42–44`)。退けた扉は帰結でなく Considered options:「**『この修理は運ばない』と答える扉を足す** — 捨てる判断は観測されておらず、git の側で表せる(帰結)。」(`0239:36`) | Status 追記 L3(→ADR 0351 決定1・4)「quarantine 中の checkout で行い、同じ question の回答で受理される(受理が基準を撮り直す)」。Status L5(決定1 の candidate → ADR 0242) | 効いている。[c2][83c2] が採る側を訂正(H2 は `git merge -s ours <子>` で足り、H4 は GitHub の head の tree を採る commit が要る —— H4 は 0242 の行)。手順の文は #3191 | 一部置き換える —— `0239:42–43` の「workspace で…記録し、そのブランチを push する」(場所は作業台、ref を書くのも push も盤面)と Status 追記 L3 の全文。`0239:36` の結論は残る。**ticket は退けた扉を「帰結」に置いているが、本文では Considered options にある** |
| 0064 | 決定3 | [#3183 本文][83](「戻す扉は無い」)、[c1][83c1] 決定3(「盤面は巻き戻さない」)・限界 | 決め直す | workspace の Quarantine に常設の「基準へ戻す」を足す。選ぶと盤面が口を通して、基準と違う ref を全部基準の値へ書き戻す。 | 「誤検知のコストは低い。確認 question は1択で、動いた ref が並ぶ。踏んだ人間は自分がやったと即座に分かり30秒で答えて解除でき、作った ref は消えない(盤面は検知するだけで巻き戻さない)。」(`0064:89–90`) | Status 追記×7。決定3 に触れるのは L7(→ADR 0351)「決定3 の『セッション中』の範囲と窓の短さを根拠にした誤検知コスト…は ADR 0351 で変わった」と L11「決定1〜3・5〜7 はそのまま」(→ADR 0243 の時点) | 効いている。前提「基準 = 盤面が最後に書いた正しい状態」は #3194 が偽と確かめ、#3196 が「残す。意味は『最後に受理した状態へ戻す』」と決め直した(map の要約。#3196 のスレッドは読んでいない)。決定4 の「退避の仕組みは作らない」は #3196 決定4(`refs/keep-around/<sha>`)が上書き。決定6 の「全部拒む」は「基準へ戻す」に限る([c5][83c5]、#3185 決定9) | 一部置き換える —— `0064:89–90`(1択、30秒で解除、作った ref は消えない、巻き戻さない)。見出しの「ホスト上の人間の手作業も違反として扱う」(`0064:79`)は残る |
| 0064 | 決定7 | [#3183 c1][83c1] 決定3(「ref の復旧を要求しない」)・限界 | 決め直す | `repaired by hand` は、基準と違う ref があれば名指しして拒む。 | 「ref が元へ戻っていることは要求しない。」(`0064:185`)「復旧を要求すると、人間の正当な修理が『**動いた ref のほうが正しいので、そのまま受け入れる**』であるケースを塞ぐ。」(`0064:190–191`)。Considered options「**quarantine の解除に ref の復旧を要求する** —— 決定7 の理由で退けた。」(`0064:238`) | L7(→ADR 0351)「決定7 の『次の pickup が常に新しい基準を取る』は ADR 0351 で変わった」 | 効いている。#3185 が同じ向きで確定(決定1「『動いた ref を見せたうえで受け入れる』選択肢は作らない」、決定8 全撮りを消す。該当行だけ読んだ)。例外が1つ: 3つ目の選択肢「失われた ref を諦めて基準へ戻す」は、戻す先の object が無い ref だけ今の値で基準に入れる([c5][83c5]) | 置き換える —— 決定7 の主文(`0064:185`)と理由(`0064:190–191`)が偽になり、`0064:238` で退けた形を採る |
| 0351 | 決定7 | [#3183 c1][83c1] 決定10・限界、[c2][83c2]、[c3][83c3] | 決め直す(「受理は差し替えを受け入れない」) | path の差し替え(H13)は削除の扉 → 再登録だけ。registry の `path` の手編集は Quarantine を立て、出口は path を戻すこと。 | 「path だけ差し替えた登録は次の pickup で1枚の question が立ち、回答が受理する。」(`0351:43–44`) | L3(→ADR 0370)「決定7 の『次の pickup で1枚の question が立ち』は、着地の候補があれば着地の比較が先に立てる」。L5「決定1・3・4・6・7 は残る」 | 狭まった → [c5][83c5](#3185 決定9・10): 3つ目の選択肢「失われた ref を諦めて基準へ戻す」なら、disk ごと失われた checkout と無関係な repo への差し替えが通る。`repaired by hand` と「基準へ戻す」は受け入れないまま。→ [c7][83c7](#3239): 削除の扉 → 再登録の道は残るが、その名前を名指す Quarantine が開いていて行を持つ間は削除の扉が拒む | 一部置き換える —— `0351:43–44` の「回答が受理する」は、名指しの3つ目の選択肢に限って真。「削除の扉が行を消す」(`0351:43`)は残る。[c2][83c2] の「退けた形に、差し替えを受理しない形を退けた記述は無い」は ADR で確かめた(`0351:46–52` の3項にその形は無い)。map L250(#3239 の block)と #3185 の resolution も 0351 決定7 の書き直しを挙げている |
| 0277 | 追記(2026-10-29)決定2 | [#3183 c1][83c1] 決定11・限界、[c2][83c2] | 決め直す(c2:「決め直すのは『手で作る』の部分だけ」) | 出題前に消えた面接室(H15)は、面接室の Quarantine に常設の「空の面接室で走らせる」を足し、盤面が `git init` する。在り処に repo が残っているか出題済みなら回答時に拒む。 | 「**event が残る在り処のディレクトリが無い面接室の名前への回答は拒む。盤面は作り直さない。** 『記録が無いのに採点する』を盤面が既定で許さない(fail-closed)。出口は人間が在り処を復元するか、root を cancel するか、空の面接室で走らせると決めて手で作ること —— その手の操作と回答が記録になる。」(`0277:48–50`) | Status 追記 L3(→ADR 0361 決定1)「出口『空の面接室で走らせると決めて手で作る(`git init`)』は、面接室の root がまだ出題していない間だけ予告し受理する」。本文の追記(`0277:65–67`、ADR 0329)が追記 決定2 の3分岐を2分岐に置き換え済み | 効いている。選択肢は4つになった([c5][83c5])。#3196 が「面接室の基準の行を消してから `git init`」、#3185 決定18 が「比較を飛ばす」と足した(map の要約)。「`reopenUnbornRoom` は要らなくなる」は推論([c2][83c2]) | 一部置き換える —— 「盤面は作り直さない」(`0277:48`)と「手で作る」(`0277:49`)。fail-closed の理由は、名指しの選択肢への回答が記録になるので食い違わない(c2 の読みは ADR の文と合う)。退けた案「回答時に盤面が空の repo を作り直す —— 同じく既定で記録の欠落を埋めて走らせる形」(`0277:59`)は「既定で」の形で、名指しの選択肢とは別 |
| 0242 | 決定4 | [#3183 c1][83c1] 決定8・限界、[c2][83c2] | 決め直す(限界の一覧)。c2 は「決定8 の文面に効く事実」として引く | 外の push が落とした内容(H3 / H4)は盤面が自分では戻さない。`merge` の拒否で作業台が開き、人間が merge を commit し、次の `merge` が取り込んで `task/<id>` を origin へ push する。clean でも人間が書く。 | 「盤面には運ぶ手が無い。question は届いていない子孫のブランチを名指しし、直す手段を2つ書く(内容をブランチに戻す / 捨てるなら workspace のタスクブランチを GitHub の head に合わせてから `merge -s ours` を記録して push する)。」(`0242:24–26`)「ここでは修理がすでに merge back 済みで、`merge -s ours` が何も記録しないからである」(`0242:26–27`)「『merge』の回答は積み残しが残る間は拒まれたまま」(`0242:28`) | Status 追記 L3(→ADR 0370 決定1・7)「決定4 の文面に従った手の書き込みは名前の場所の ref を動かすので…Quarantine を1枚経る…『捨てる』手順(`git reset --hard origin/task/<id>`)は…文面を直すときに手順ごと直す」。Status L5(決定1 → ADR 0289) | 効いている。#3182 決定12 を上書きした([#3182 c7][82c7])。広がった → [c6][83c6](#3203): 盤面に未 push の修理がある場面にも及び、書き換え・巻き戻しでは収束が push しない。[c2][83c2]: origin が祖先へ巻き戻されただけなら commit は要らない(推論)。#3233 が「clean でも人間が merge を書く」を PR の無い場面へ広げた(map の要約) | 一部置き換える —— `0242:24–26` の「盤面には運ぶ手が無い」と直す手段の2つ(場所は作業台、push は盤面、捨てる側は GitHub の head の tree を採る commit)、`0242:28` の「拒まれたまま」(2回目の `merge` は取り込みと push を済ませてから CI 待ちで拒む)。「キューを外して推奨 hold の merge question に倒す」は残る。c2 の言い換え(「local の tree が残り、戻す側になる」)は ADR の「何も記録しない」「fast-forward で修理を戻す」の読み替えで、逐語ではない |
| 0052 | §7(= 決定7「slot 解放の『クリーンに戻す』に休止位置を含める」) | [#3183 c3][83c3] | 決め直す(一覧の漏れとして足した。「決定9 は ADR 0052 §7(保護ブランチを手で origin へ巻き戻すか push する)」) | 「origin に揃える」は足さない(H9)。出口は人間が自前の clone から origin へ push すること。squash で分岐が残る場合は cancel → 削除の扉 → 手で直して再登録。 | 「ff できない = 帯域外の手作業でローカルが分岐している場合は quarantine。」(`0052:117–118`)。pickup でも撃つ追記(`0052:120–122`) | Status 追記 L3(→ADR 0356)「決定7 の休止位置へ『戻す』手は無くなる」、L5(→ADR 0352)、L7(§7 追記 → ADR 0329 追記 決定11) | 効いている(後から上書きするコメントは #3183 に無い) | 矛盾しない —— **ADR §7 の本文に「手で origin へ巻き戻すか push する」に当たる文は無い**(`巻き戻`・`reset --hard`・`手で` は file 全体で 0 件)。§7 は quarantine に落とすまでを決め、出口の手順を書いていない。直す対象は文面(コードの文)の側と読める —— 文の在り処は確かめていない |
| 0146 | (番号なし。該当は決定2) | [#3183 c3][83c3] | 決め直す(ただし同じコメントが「grilling で問うていない…ユーザーに確かめた決定ではない」と書く) | `.git` の形(H13 の前半)を直した後の ref が基準と同じなら通り、違えば差し替えと同じ扱い —— 決定10 の帰結として読める、まで。 | 「**門は pickup 側の workspace quarantine で、回答受理の検証と登録の門にも同じ条件を置く。**…修理確認の回答は同じ条件を再検査してから受理する」(`0146:10`) | Status 追記 L3(→ADR 0356)「決定1・3 の『`.git` が directory』の理由のうち sandbox の cwd の側は消える」 | #3183 では未確定 → #3185 決定17 がユーザー確認つきで確定([#3185 の c9](https://github.com/sinano1107/tidepool/issues/3185#issuecomment-6848732769):「直した後の ref が基準と同じなら通り、違えば ref の違いとして同じ文で拒まれる。専用の扱いは作らない」) | 足すだけ —— `0146:10` は真のまま、受理に「基準と同じ」が加わる。書き直しの持ち主は #3185(その resolution の訂正が 0146 を一覧に足している) |
| 0084 | 決定1 | [#3184 c3][84c3] 決定3・確かめたこと、[c13][84c13] | 変えない(「採ると ADR 0084 決定1 と着地の除外を決め直し、H20 を引き込む」ので採らない)→ c13 で「そこ(#3207)で決め直す」 | 人間担当の work task は H19 / H21 の乗り物にしない。 | 「人間タスクの完了はワークスペースを持たず、コミットを求める相手もいない。」(`0084:35–36`) | Status 追記×4(L3・L5・L7・L9、どれも決定2) | 決定3 の「H20 は霧のまま」は上書きされた → [c13][84c13](#3207): 人間担当の work も `task/<id>` を持つ。H19 / H21 の乗り物が workspace の操作であること(決定1・4)は変わらない | #3184 自身は置き換えない。`0084:35–36` を偽にするのは #3207(と #3213・#3214)—— map L129・L150・L161 がそちらの持ち分として挙げている |
| 0360 | 決定3(「直し方」) | [#3184 c3][84c3] 限界 | 決め直す(「0360 決定3 の直し方」) | H18 は、作業台の tip を封じ込めの Quarantine の回答が入口と同じ手順で取り込む(purely-local だけ。remote-backed は今どおり origin から引く、[c9][84c9])。取り込んだ後の tree に隠せない形が残るなら書く前に拒む(決定15)。 | 「隠せない形が保護ブランチの tree にあれば (claude-code, workspace) の組の停止で、回答時の撃ち直しは名前の場所の保護ブランチを `ls-tree` する(ADR 0259 決定5 の読む tree)。」(`0360:29–30`) | Status 追記×4(L3・L5・L7 は決定2、L9 は派生の行 → ADR 0362) | 効いている。[c7][84c7] 決定13: 取り込むものが無ければ今の検査だけを通す。[c12][84c12](#3206): Codex の組も同じ1手 | 足すだけ —— **決定3 の本文に人間の直し方は書かれていない**。「名前の場所で直す」を言うのは退けた形の1句だけ(「人間が名前の場所で直せるものが無い」`0360:44`)。`0360:29–30` は真のまま(取り込みの後に同じ `ls-tree`)。map L126 は 0360 決定3 に Codex の組を足すのを #3206 の持ち分として挙げている |
| 0259 | 決定5 | [#3184 c7][84c7] | 足す(「決め直す ADR に ADR 0259 決定5 を足す。封じ込めの回答が『同じ検査を撃ち直す』だけでなく取り込みも行う」) | 同上(決定2・13・15)。 | 「**組の question への回答は、その組の検査をもう一度走らせて成立したときだけ受理する。**」(`0259:37`) | Status 追記 L3(→ADR 0360)「決定5 の撃ち直しが読むのは名前の場所の working tree でなく保護ブランチの tree(`ls-tree`)」。L5・L7 は決定2・3 と追記 | 効いている。Codex の部分は書き換わった → [c12][84c12](#3206): purely-local の Codex の修理(N1)も H18 と同じ1手で、回答時の検査は local の保護ブランチの tip を使い捨ての checkout に展開して読む(c7 の「取り込む → 回答」の2手と、[c8][84c8] の「作業ツリーも進むので届く」に依らなくなる) | 足すだけ —— `0259:37` は真のまま、回答が検査の前に取り込む。map L126 が Codex の組の追記を #3206 の持ち分として挙げている |
| 0040 | (番号なし) | [#3184 c15][84c15](#3238 からの上書き) | 引く(「registry clone と交差する entry は ADR 0040 の検査が登録の扉と Quarantine で拒む」) | 決定12(足す操作は registry clone に当たる workspace を拒む)は該当が無くなり、専用の拒否は要らない。 | 今の本文は逆:「**registryDir は意図的に対象外**。registry clone は v1 唯一の保護 workspace としてむしろ設計上 workspace であり」(`0040:17`) | Status 追記 L3(→ADR 0356)「決定の『workspace の中』は worker の読み書きの半径で…」 | 決定12 は取り消された → [c15][84c15] | #3184 の行ではない —— c15 の文は #3238 が 0040 を書き直した後の姿を言っている(今の `0040:17` とは食い違う)。0040 の反転は #3238 の持ち分(map L229) |

### 1-b. ticket が名指していないが、同じ決定が偽にする文(照合の途中で見つけたもの)

ticket の主張ではなく私の読み。#3237 の表に入れるかは判断を任せる。

| ADR | 決定/追記/節 | 偽にする決定(ticket と comment URL) | ADR 側の該当文(引用、file:line) | 名指している ticket |
|---|---|---|---|---|
| 0351 | 決定4(前半: 受理が基準を撮り直す) | [#3183 c1][83c1] 決定3(`repaired by hand` は違いがあれば拒む) | 「**quarantine の受理が基準を撮り直す。** 受理の検査(clean・後半・merge back のやり直し)の後に全撮りをする。回答は『動いた ref のほうが正しい』の受理(ADR 0064 決定7 の修理の線)」(`0351:33–34`) | #3185 の resolution が「ADR 0351…決定4(全撮りと受理の順)」として名指している(該当行だけ読んだ)。#3183 は 0064 決定7 だけを名指す |
| 0364 | 決定1 の不変条件 | [#3182 c2][82c2] 決定4・6・7(作業台の tip を同じ手で読み、盤面が包む commit を作る) | 「記録に入る object は、名前の場所に既にあるか、worker が自分の checkout の `objects/` に regular file として書いたもののみ。4つの役とも同じ1つの手。」(`0364:31–32`) | 見つけた範囲では無い |
| 0362 | 決定2(拒む場所) | [#3182 c5][82c5] の 2.(決定8 を一律に残す)、[c9][82c9] | 「**完了の門は、tip の2 path の entry…が fork 元との merge-base と違えば path を名指して拒む**」(`0362:22`)—— 偽にはならず、拒む場所が増える。比べる相手は入口では「入力の2つの tip のどちらとも違う entry」で、merge-base ではない | 見つけた範囲では無い |

### 1-c. ADR の file 名と Status 行の原文

file から機械的に写した(`**Status` で始まる行の全部)。

#### ADR 0040 —— `docs/adr/0040-board-state-paths-cannot-overlap-workspaces.md`

- L3: **Status 追記: 決定の「workspace の中」は worker の読み書きの半径で、worker は task の checkout で走るので重なりの検査はその番地に当たる([ADR 0356](0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md)、2026-11-07、issue #2956)。**

#### ADR 0052 —— `docs/adr/0052-registry-source-of-truth-is-the-remote-main.md`

- L3: **Status 追記: 決定7 の休止位置へ「戻す」手は無くなる —— 名前の場所の HEAD は保護ブランチを離れず、残るのはリモートへの追従と worktree の追従([ADR 0356](0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md)、2026-11-07、issue #2956)。**
- L5: **Status 追記: 決定7 の「クリーンに戻す」は、タスクブランチが無視していたファイルを休止位置へ動かす前に消すことまで含む —— 休止位置の tree は head と一致する([ADR 0352](0352-files-the-task-branch-ignores-are-removed-when-the-board-moves-head-off-it.md)、2026-11-02、issue #2912)。**
- L7: **Status 追記: §7 追記(pickup の休止位置)の「読む場所は remote 正本を持つものだけ」は外れ、purely-local の読む場所も休止させる(ADR 0329 追記 決定11、2026-11-01、issue #2730)。**
- L9: **Status 追記: 決定1 の「push 成功時にローカルの remote-tracking ref が更新されるので『push が通った』と『盤面に効いた』が同じ 1 つの事実」は、push が checkout の中で走ることに乗っていた。盤面の網に出る git は checkout の外の盤面所有 repo で走る([ADR 0339](0339-the-boards-github-children-run-in-a-built-env-and-only-the-injected-identity-reaches-the-network.md) 決定5、2026-11-01、issue #2827)ので、写しは push の成功を見て盤面が ADR 0243 の口の中で `update-ref` で書く —— 「効いた」の定義は変わらない(push の成功)が、写しを動かす手は git の副作用でなく盤面の書き込みになる。**

#### ADR 0053 —— `docs/adr/0053-task-branch-forks-from-its-lineage-and-work-returns-where-it-was-cut.md`

- L3: **Status: 決定3 の hold(恒久の「着地しない」)は ADR 0289 で改められた —— hold が断るのはその時点の内容で、内容が変われば question を立て直す。merge の執行は根に記録する**
- L5: **Status: 決定1 の着地判定(`rev-list` による履歴の収束)は ADR 0105 で「内容で測る」に置き換え済み。決定3 の ff-only 着地と決定4 の事後検知の一点は ADR 0103 で置き換え済み** — 「ff できない = 帯域外の手作業」の前提は、盤面自身の着地が保護ブランチを進める直列運用(issue #468)で破れた。帯域外の判定は ff の成否ではなく盤面自身の ref snapshot との一致で行い、一致下の非 ff は Tidepool 名義の merge で追いつかせる。merge question を通る着地の形と「人間の手は分解ツリー1本につき1回」の線は維持される。

#### ADR 0064 —— `docs/adr/0064-the-task-branch-is-the-workers-only-mutable-ref.md`

- L3: **Status 追記: 決定6 の「未設定に分岐は書かない」は、ADR 0351 で pickup が、行そのものが無い場合を「まだ持ったことがない」と読んで最初の撮りをする形に変わっていた。着地も同じ側に立つ —— 行そのものが無い workspace で着地が違反として止めると出口が無い(受理は行を作らず、pickup は収束の後にしか来ない)。release での行無しは今日どおり違反([ADR 0370](0370-landing-compares-every-ref-of-the-named-place-against-the-baseline-before-it-carries-or-records-and-the-acceptance-hole-goes-to-the-door-design.md) 決定1、2026-11-12、issue #3151)。**
- L5: **Status 追記: 基準を持つのは名前の場所だけで、見張る相手は人間と盤面自身になる(worker は task の checkout で走り、盤面が読むのは `task/<id>` 1本)([ADR 0356](0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md)、2026-11-07、issue #2956)。**
- L7: **Status 追記: 決定3 の「セッション中」の範囲と窓の短さを根拠にした誤検知コスト、決定5 の全撮りの位置(pickup の最後)、決定6 の「未設定に分岐は書かない」(pickup でだけ、行が無い / NULL を「まだ持ったことがない」と読んで最初の撮りをする —— release では今日どおり違反)、決定7 の「次の pickup が常に新しい基準を取る」は [ADR 0351](0351-the-checkout-is-the-boards-territory-from-the-first-pickup-and-the-ref-baseline-never-breaks.md) で変わった(2026-11-02、issue #2911)—— checkout は最初の pickup 以降、休止中も盤面の専有領域で、基準は切れない。全撮りは盤面がその checkout をまだ持ったことがない開き(行の無い pickup・読む場所の最初の開き)と quarantine の受理だけが撮り、以後の pickup は比較する。**
- L9: **Status 追記: 決定1 の「見張るのは `refs/*` 全部」に、HEAD の行(指し先)が加わる([ADR 0345](0345-a-teardown-step-is-idempotent-or-skipped-from-the-record-and-the-boards-own-head-move-goes-through-the-ref-gate.md) 決定2、2026-11-01、issue #2889)—— 盤面が休止位置や merge back の帰り先へ checkout を動かすときは同じ口で予告し、畳む。worker が終わりに自分のブランチに居ない違反は今日どおり tree rule の HEAD 検査が先に捕まえる。**
- L11: **Status 追記: 決定4 の「書いた後に撮り直す」と「成功したときにしか撮り直さない」は [ADR 0243](0243-the-boards-own-ref-write-is-announced-in-the-baseline-before-the-write-and-folded-after-it.md) で「書く前に基準へ予告し、書いた後に2択で畳む」に置き換わった(2026-10-13)。決定1〜3・5〜7 はそのまま。**
- L13: **Status 追記: 決定2 の「タスクブランチは決着後も削除されない」は、決着した pin の子のブランチについて [ADR 0263](0263-an-interview-examinee-reads-what-production-work-reads-except-what-reveals-the-measurement-or-unevens-the-targets.md) 決定5 が例外を置いた(2026-10-15)—— 盤面が後から走る pin の子の pickup の準備で、全 ref のスナップショットの前に外し、head を記録に残す。worker による削除が違反であることは変わらない。**
- L15: **Status 追記: 上の ADR 0263 決定5 の例外は [ADR 0276](0276-an-interview-examinee-solves-in-its-own-checkout-fetched-from-the-posed-head-and-a-settled-examinees-checkout-stays-as-the-record.md) で消えた(2026-10-19)—— 決着した受験者の checkout は残り、タスクブランチは決着後も削除されない、に戻る。ref snapshot の鍵は受験者の checkout ごとになる。**

#### ADR 0084 —— `docs/adr/0084-completion-requires-the-workers-own-commit.md`

- L3: **Status 追記: 決定2 の「workspace が解決できない → 門をスキップ」も task の checkout には掛からない —— 名前の場所の解決は門の一部で、解けなければ ADR 0359 決定1 の拒否([ADR 0363](0363-drift-is-observed-by-the-pickup-gate-before-running-and-by-teardown-after-and-the-completion-gate-rejects-an-unresolvable-name.md) 決定1、2026-11-09、issue #3094)。**
- L5: **Status 追記: 決定2 の「ツリーを観測できないタスクは素通し」は task の checkout には掛からない —— 完了の門は worker の tip が名前の場所の `task/<id>` になるまで `done` にせず、名前の場所の側で書けなければ拒む([ADR 0359](0359-the-completion-gate-lands-the-tip-in-the-record-before-done-and-a-completed-release-carries-only-the-recorded-tip.md) 決定1、2026-11-08、issue #3053)。**
- L7: **Status 追記: 決定2 の「観測に失敗したら `false`」は git が即座に失敗した場合に限る —— 盤面の view の git が上限で止まった手は観測の失敗ではなく worker の repo の故障で、門は開かず session を倒す([ADR 0357](0357-the-boards-git-on-a-workers-tree-is-bounded-and-expiry-is-a-worker-repo-failure.md)、2026-11-07、issue #2966)。**
- L9: **Status 追記: 決定2 の「quarantine 中のタスク — 門をスキップ」は ADR 0350 決定1 で覆った —— 門の述語は task の種別だけを読み、workspace の Quarantine 中でも掛かる(2026-11-02、issue #2910)。**

#### ADR 0100 —— `docs/adr/0100-a-board-on-its-owners-mac-runs-inside-a-linux-vm-and-host-form-is-orthogonal-to-platform.md`

Status 行なし。

#### ADR 0103 —— `docs/adr/0103-landing-out-of-band-is-judged-by-the-boards-own-record-and-legitimate-divergence-lands-by-merge.md`

- L3: **Status 追記: 決定1 の「着地経路で quarantine するのはこれだけ」は広がる —— 着地の回答は ref を読む同期区間の頭で全 ref を基準と比べ、保護ブランチ以外の ref の帯域外の移動も workspace の Quarantine に落ちる。同じ比較は、着地が ref を読んで運ぶか書き込みを決めるところ(収束、PR の merge の回答、無人 merge の tick)からも立つ。「snapshot に保護ブランチの行が無いときも不一致」は、基準はあるがその ref の行が無い場合に限り、基準の行そのものが無ければ着地が最初の撮りをする(今は止まる回答が通るようになる)。決定4 の回答拒否に従った手の解決は ref を動かすので、次の回答はこの比較に当たって Quarantine を1枚経る —— 文面はそれを告げる([ADR 0370](0370-landing-compares-every-ref-of-the-named-place-against-the-baseline-before-it-carries-or-records-and-the-acceptance-hole-goes-to-the-door-design.md) 決定1・7、2026-11-12、issue #3151)。**
- L5: **Status 追記: 決定3 の「走行中は checkout を動かさない」の分岐は消え、保護ブランチの ref の書き込みは常に worktree の追従と対の plumbing([ADR 0356](0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md)、2026-11-07、issue #2956)。**
- L7: **Status 追記: 決定1 が読む基準は次の pickup の全撮りで作り直されなくなった([ADR 0351](0351-the-checkout-is-the-boards-territory-from-the-first-pickup-and-the-ref-baseline-never-breaks.md) 決定2、2026-11-02、issue #2911)—— 旧・休止中に保護ブランチが動いたとき、着地の回答が次の pickup より前なら quarantine、後なら通っていた。決定1 の文はそのまま。**
- L9: **Status 追記: 決定3 の「綴りは今日どおり2つ」と Considered options の「plumbing への一本化」は [ADR 0243](0243-the-boards-own-ref-write-is-announced-in-the-baseline-before-the-write-and-folded-after-it.md) 決定4 で「merge の計算は走行中も休止中も plumbing の1つ、ref の動かし方だけが `update-ref` / `merge --ff-only` の2つ」に置き換わった(2026-10-13、#1871)。決定1・2・4・5 はそのまま。**

#### ADR 0105 —— `docs/adr/0105-landed-is-measured-by-content-and-a-root-that-outlived-its-fork-source-catches-up-by-merge.md`

- L3: **Status 追記: 決定2 の「人間がセッション外で手で解決すれば通る」は、解決が名前の場所の ref を動かすので、retry が着地の比較に当たって workspace の Quarantine を1枚経てから、もう一度 retry で通る —— 文面はそれを告げる([ADR 0370](0370-landing-compares-every-ref-of-the-named-place-against-the-baseline-before-it-carries-or-records-and-the-acceptance-hole-goes-to-the-door-design.md) 決定1・7、2026-11-12、issue #3151)。**
- L5: **Status: 決定4 は ADR 0217 で広げられた — merge の瞬間には門に加えて着地の面(保護・ダイヤル・risk flag)も読み直し、面が変わった PR はキューから外れる**

#### ADR 0146 —— `docs/adr/0146-a-workspace-checkout-has-a-git-directory-and-linked-worktrees-and-submodules-are-not-workspaces.md`

- L3: **Status 追記: 決定1・3 の「`.git` が directory」の理由のうち sandbox の cwd の側は消える(worker は task の checkout で走る)。盤面が branch を書く側の理由は残る([ADR 0356](0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md)、2026-11-07、issue #2956)。**

#### ADR 0239 —— `docs/adr/0239-content-left-behind-is-measured-against-the-head-the-merge-takes-not-the-teardown-mark.md`

- L3: **Status 追記: 帰結の「人間が修理を捨てるなら workspace で `git merge -s ours` で記録する」は、[ADR 0351](0351-the-checkout-is-the-boards-territory-from-the-first-pickup-and-the-ref-baseline-never-breaks.md) 決定1・4 の下では quarantine 中の checkout で行い、同じ question の回答で受理される(受理が基準を撮り直す)—— 休止中の盤面の checkout への手の書き込みは、それ以外では違反になる(2026-11-02、issue #2911)。**
- L5: **Status: 決定1 の candidate(「盤面が読む origin 側のタスクブランチ」= 手元の remote-tracking ref)は ADR 0242 で改められた — merge の門では GitHub が報告した head、収束では盤面が最後に push した head と比べる**

#### ADR 0240 —— `docs/adr/0240-a-landing-that-was-never-fired-is-derived-from-rows-and-content-and-fired-again.md`

- L3: **Status 追記: 決定4 が引く「ADR 0103 の帯域外の quarantine は人間の回答から立ち」は、着地が ref を読んで運ぶか書き込みを決めるところ(収束、PR の merge の回答、無人 merge の tick)からも立つようになる —— 走っている session を止めないことは変わらない([ADR 0370](0370-landing-compares-every-ref-of-the-named-place-against-the-baseline-before-it-carries-or-records-and-the-acceptance-hole-goes-to-the-door-design.md) 決定1、2026-11-12、issue #3151)。**
- L5: **Status 追記: 決定4 の「受理の検査の中でやり直す」ものに、名前の場所の事情で済まなかった解放(task の checkout の退避と削除)が加わる —— 運ぶだけをやり直し、merge back の手前で撃つ([ADR 0369](0369-a-release-the-named-place-kept-from-finishing-is-redone-by-the-acceptance-of-its-quarantine-and-a-task-that-owes-one-is-not-picked-up.md) 決定1〜3、2026-11-11、issue #3147)。**
- L7: **Status 追記: 決定4 の「帰り先を checkout して merge し」「conflict すれば merge を取り消して」は、[ADR 0243](0243-the-boards-own-ref-write-is-announced-in-the-baseline-before-the-write-and-folded-after-it.md) 決定4 で「merge commit を merge-tree で先に作り、口を通して `merge --ff-only` で進める。conflict は merge-tree の段階で分かり、取り消す merge は始まらない」に置き換わった(2026-10-22、#1874)。やり直す場所・拒否文の2つの出口・休止位置へ戻すことはそのまま。**

#### ADR 0242 —— `docs/adr/0242-content-left-behind-is-measured-against-the-head-github-reports-at-the-merge-gate-and-the-head-the-board-last-pushed-in-convergence.md`

- L3: **Status 追記: 決定1 の「GitHub が報告した PR の head と比べる」のうち、GitHub の head そのものはローカルの ref ではないので着地の比較の対象でなく、比べる相手のローカルのブランチの読みは、同じ同期区間の頭で全 ref を基準と比べた後に読む。決定4 の文面に従った手の書き込みは名前の場所の ref を動かすので、回答し直しはこの比較に当たり、workspace の Quarantine を1枚経る —— 文面はそれを告げる。「捨てる」手順(`git reset --hard origin/task/<id>`)は、名前の場所の HEAD が保護ブランチに居る今はローカルの保護ブランチを動かすので、文面を直すときに手順ごと直す([ADR 0370](0370-landing-compares-every-ref-of-the-named-place-against-the-baseline-before-it-carries-or-records-and-the-acceptance-hole-goes-to-the-door-design.md) 決定1・7、2026-11-12、issue #3151)。**
- L5: **Status: 決定1 はローカル着地の merge 回答にも及ぶ(ADR 0289)—— 比べる head は着地の面が merge する head で、ローカルではローカルのタスクブランチ**

#### ADR 0259 —— `docs/adr/0259-harness-specific-checkout-properties-stop-only-the-harness-workspace-pair-and-codex-enumerates-its-own-skills.md`

- L3: **Status 追記: 決定5 の撃ち直しが読むのは名前の場所の working tree でなく保護ブランチの tree(`ls-tree`)—— Claude の組の停止は保護ブランチの tree にある形だけが立て、task branch にだけある形は task の失敗([ADR 0360](0360-the-board-judges-what-reaches-the-worker-from-the-recorded-tree-reads-the-checkout-only-to-verify-its-own-hide-and-stops-unhideable-shapes-on-the-writers-axis.md)、2026-11-08、issue #3074)。**
- L5: **Status 追記: 決定3 の「すべて `enabled: false`」は ADR 0337 決定3 で「盤面が閉じた path がすべて `enabled: false`」に** —— allowlist が開いた path は封じ込めの性質に数えない。決定2 の「Codex 自身に列挙させる」は不変で、翻訳は同じ列挙の `scope` から引く(2026-11-01、issue #2689)。
- L7: **Status 追記: 2026-10-21 の追記の developer 指示の marker への差し替えは ADR 0326 決定3 の配置に追随する** —— skill の観測は本文に依らず同じ設定を当てる線を保ち、盤面の文が developer 層に載ることを worker の要件にしない(2026-10-29、issue #2692)。

#### ADR 0277 —— `docs/adr/0277-an-interview-rooms-place-is-derived-from-the-convention-the-opened-event-records-the-real-spelling-and-a-place-with-no-repo-is-no-checkout-to-tear-down.md`

- L3: **Status 追記: 追記 決定2 の出口「空の面接室で走らせると決めて手で作る(`git init`)」は、面接室の root がまだ出題していない間だけ予告し受理する。出題済みの面接室は読み手が出題の head を fetch する([ADR 0361](0361-interview-readers-read-a-checkout-of-the-posed-head-not-the-rooms-git-and-the-answers-stay-in-the-room.md) 決定1)ので、その head が面接室で引けることが面接室の pickup の項に並び、出口は復元か cancel だけになる(2026-11-10、issue #3105 の実装レビュー)。**

#### ADR 0351 —— `docs/adr/0351-the-checkout-is-the-boards-territory-from-the-first-pickup-and-the-ref-baseline-never-breaks.md`

- L3: **Status 追記: 決定2 の比較の置き場所に着地が加わる —— 着地が名前の場所の ref を読んで運ぶか記録を決めるときは、同じ同期区間の頭で全 ref を基準と比べ、基準の行そのものが無い workspace では着地も pickup と同じ手続きで最初の撮りをする。決定7 の「次の pickup で1枚の question が立ち」は、着地の候補があれば着地の比較が先に立てる。決定4 の受理は変えていない: Quarantine が開いている間に動いた ref を見せないまま受け入れる穴は実測済みで、直し方は人間の内容の扉の設計(#3158)に渡した([ADR 0370](0370-landing-compares-every-ref-of-the-named-place-against-the-baseline-before-it-carries-or-records-and-the-acceptance-hole-goes-to-the-door-design.md) 決定1、2026-11-12、issue #3151)。**
- L5: **Status 追記: 決定2 の release 側の比較と task branch の行の畳み、決定5 の pickup の clean 検査の対象は、worker が書かない名前の場所だけになる。決定1・3・4・6・7 は残る([ADR 0356](0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md)、2026-11-07、issue #2956)。**
- L7: **Status 追記: 決定5 の「dirty は休止後に書かれた」は、タスクブランチだけが無視するファイルを盤面が HEAD を動かす手で消すこと([ADR 0352](0352-files-the-task-branch-ignores-are-removed-when-the-board-moves-head-off-it.md))に乗って成り立つ —— 述語は HEAD の branch の ignore 規則に相対である(2026-11-02、issue #2912)。**

#### ADR 0356 —— `docs/adr/0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md`

Status 追記が 10 行(L3・L5・L7・L9・L11・L13・L15・L17・L19・L21)。この表の行は 0356 を日付の基準に引くだけなので、原文は写していない。

#### ADR 0359 —— `docs/adr/0359-the-completion-gate-lands-the-tip-in-the-record-before-done-and-a-completed-release-carries-only-the-recorded-tip.md`

- L3: **Status 追記: 決定5 の「`done` の task では観測」は、門の掛からない完了済みの解放の WIP の退避にも当たる —— worktree を stage する段の失敗は種類を問わず「読めない」観測で、名前の場所は quarantine しない([ADR 0367](0367-the-wip-evacuation-is-attributed-by-stage-the-worktree-is-staged-in-a-board-owned-repo-and-fetched-into-the-named-place.md) 決定3、2026-11-10、issue #3141)。**
- L5: **Status 追記: 決定2・5 の「完了済みの解放」は門の掛かる work の解放を指す —— review と Interview の役は門を持たないので、完了済みでも解放の fetch が初回の転送を担い、その失敗の帰責は写す段 / fetch する段 / host の3段([ADR 0364](0364-the-board-never-opens-the-workers-git-as-a-repository-and-fetches-the-tip-from-a-board-owned-copy-of-its-regular-files.md) 決定2、2026-11-09、issue #3097)。**
- L7: **Status 追記: 決定4 の「verb の時点の名前の場所の失敗は資源の停止を登録せず拒むだけ」は、署名を持つ drift(名前が解けない)にも広がる —— 後始末が一歩あとに同じ drift を観測するので verb で登録しても止まるものが無い([ADR 0363](0363-drift-is-observed-by-the-pickup-gate-before-running-and-by-teardown-after-and-the-completion-gate-rejects-an-unresolvable-name.md) 決定2、2026-11-09、issue #3094)。**

#### ADR 0360 —— `docs/adr/0360-the-board-judges-what-reaches-the-worker-from-the-recorded-tree-reads-the-checkout-only-to-verify-its-own-hide-and-stops-unhideable-shapes-on-the-writers-axis.md`

- L3: **Status 追記: 決定2 の view の sparse policy(と #3075 の追記で足した鍵 `sparse.expectFilesOutsideOfPatterns=true`)は pathspec 除外に置き換わる —— 「worker に読ませない」(task の checkout の sparse)と「盤面が運ばない」(view)は目的が違い、sparse の seed は hidden path にディレクトリがあると `add -A` が throw し `status` が配下を名指した。view は sparse で seed せず、運ばない path(記録の tip から導く hidden settings と ADR 0069 の shadow 残骸)を1つの関数で作り、`add` と `status` の両方に `:(exclude,literal)<path>` で渡す。その path が無い・ディレクトリ・0 byte の stub・書き換えられた中身のどれでも、tree には seed の blob が残り status に出ない。Codex の pickup で hidden settings を含めない分岐(決定1・2)は残す。ADR 0069 の既知パスは `settingsDenyWrite` の2 path も含む —— tip に無い settings の path の 0 byte の stub も運ばず名指さない。task の checkout の sparse と worker の git env の鍵、名前の場所の `boardReadTree` は変えない(2026-11-10、issue #3111)。**
- L5: **Status 追記: 決定2 の sparse policy で seed する view(完了の門・退避・完了後の観測・出題の写し)は、worker の git env と同じ鍵 `sparse.expectFilesOutsideOfPatterns=true` で hidden path を読む —— 既定の検査では sandbox の stub(background の Bash が生きている間 host に見える 0 byte のファイル)や worker の中身で S bit が落ち、門はその path を名指すのに退避の `add -A` は運ばず、worker からは commit するものが無い。隠した entry は誰がバイトを置いても運ばない。policy の無い view(Codex の pickup、settings の無い tree)と名前の場所の `boardReadTree` は変えない(2026-11-09、issue #3075)。**
- L7: **Status 追記: 決定2 の「盤面が worker の repo に撃つのは tip の fetch とこの検証だけ」の fetch も消える —— tip の fetch は worker の `.git` の中で upload-pack を走らせていた。盤面は regular file だけを写し、盤面所有の repo から fetch する([ADR 0364](0364-the-board-never-opens-the-workers-git-as-a-repository-and-fetches-the-tip-from-a-board-owned-copy-of-its-regular-files.md)、2026-11-09、issue #3097)。**
- L9: **Status 追記: 派生の行(worker が settings の blob を変えた tip が landing 後に人間の CLI に届く)は [ADR 0362](0362-the-workspaces-claude-settings-are-human-only-paths-in-the-record-and-the-completion-gate-rejects-a-tip-whose-entries-differ-from-the-fork-source.md) で決着 —— 2 path は記録の中で人間しか書けず、完了の門が fork 元との merge-base と entry を比べて拒む。決定4 と同じ「直して commit し直せ」の型で、決定3 の spawn 時の停止は足さない(2026-11-09、issue #3078)。**

#### ADR 0362 —— `docs/adr/0362-the-workspaces-claude-settings-are-human-only-paths-in-the-record-and-the-completion-gate-rejects-a-tip-whose-entries-differ-from-the-fork-source.md`

- L3: **Status 追記: 決定3 の列は2 path ではなく形で決まる —— 人間の Claude CLI(2.1.319)は cwd を基点に読む。人間しか書けない形は、basename が `.claude/settings.json` / `.claude/settings.local.json` / `.mcp.json` の path(深さを問わない)と、tree でない `.claude` entry(深さを問わない —— symlink の `.claude` は先の `settings.json` を読ませ、先の path は basename に当たらない)。完了の門は決定2 の比較をこの集合で行い、集合は1つの関数が持つ。`.mcp.json` が軸に乗る理由: `-p` は trust も承認も問わず project server を起動し、対話の承認は server の名前で`settings.local.json` の `enabledMcpjsonServers` に記録されるので、承認済みの名前の command を変えると問わずに起動する。`settings*.json` は cwd の `.claude` だけが読まれ、root のものは subdir の cwd では読まれない。射程の境界に1行足す: 人間が以前に commit した symlink の先の中身を worker が変える形は path の比較に見えず、`scripts/*` と同じ線で review の仕事。盤面の pin(2.1.286)と git root より上の祖先は未測定。実測の表は #3107 のコメント(2026-11-09、issue #3107)。**
- L5: **Status 追記: 列は Codex の形も持つ —— 人間の Codex(0.161.0)は trust 済みの project で、root から cwd までの各 `.codex/config.toml` を重ね、`mcp_servers` を承認なしに起動し、`sandbox_mode` / `approval_policy` を人間の user config より優先して適用する(trust は path 単位で、値を変えても問い直さない)。`.codex/rules/*.rules` の `allow` は問わずに sandbox の外で実行させる。人間しか書けない形に、`.codex/config.toml` の path・`.codex/rules` 以下の path・tree でない `.codex` / `.codex/rules` entry(どれも深さを問わない)を足す。`.codex/hooks.json` は hook の hash ごとの review で守られ(docs の読み、実測ではない)、`.codex/agents/*.toml` は起動時に読まれず(toml の `mcp_servers` は起動しなかった)model が選んだときに効くので、`.claude/agents` と同じく review の主題 —— tidepool 自身がどちらも tracked で持つ。Codex は `.mcp.json` を読まない。ログイン後の TUI・Codex app は未測定。実測の表は #3108 のコメント(2026-11-09、issue #3108)。**
- L7: **Status 追記: 「basename が当たる」は綴りの照合ではなく、人間の FS が同じ file に解決するかで読む —— 大文字小文字を区別しない FS(macOS の APFS)では `.claude/SETTINGS.json`・`ſettings.json`・`.codex/conﬁg.toml` が本物の file に解決する(#3078 の ponytail-review の実測、Node の `readFileSync`。CLI が開くことは未測定)。門は path を大文字に畳んで(`ſ` → `S`、`ﬁ` → `FI`)照らす。人間しか書けない形の集合は変えない。worker 側の隠しの判定(ADR 0360 決定1)の同じ穴は #3114(2026-11-09、PR #3115)。**

#### ADR 0364 —— `docs/adr/0364-the-board-never-opens-the-workers-git-as-a-repository-and-fetches-the-tip-from-a-board-owned-copy-of-its-regular-files.md`

- L3: **Status 追記: 決定2 の3段の帰責は tip の転送だけでなく WIP の退避にも当たる —— view は worktree を盤面所有の repo に stage し、名前の場所へは同じ fetch で運ぶ([ADR 0367](0367-the-wip-evacuation-is-attributed-by-stage-the-worktree-is-staged-in-a-board-owned-repo-and-fetched-into-the-named-place.md) 決定1・5、2026-11-10、issue #3141)。**
- L5: **Status 追記: 決定1 の閉包の検証(到達可能性)は gitlink の参照先を見ない —— git の到達可能性は gitlink を辿らないので、参照先がどこにも無い gitlink でも閉包は解ける。記録の外を指す entry は完了の門が fork 元との差で拒み、入れ子の repo の中身は運ばない([ADR 0365](0365-the-record-closes-within-one-repo-and-the-completion-gate-rejects-a-tip-that-adds-or-advances-a-gitlink-from-the-fork-source.md)、2026-11-09、issue #3052)。**
- L7: **Status 追記: 入れ子の `.git` も worker が書いたリポジトリ定義で、view の `add -A` / `status` は gitlink の値を決めるためにそれを開いていた(#3097 の棚卸しが「変更なし」とした行)。view は入れ子の repo を除き、gitlink の値は記録から読む([ADR 0365](0365-the-record-closes-within-one-repo-and-the-completion-gate-rejects-a-tip-that-adds-or-advances-a-gitlink-from-the-fork-source.md) 決定3、2026-11-09、issue #3117)。**

#### ADR 0369 —— `docs/adr/0369-a-release-the-named-place-kept-from-finishing-is-redone-by-the-acceptance-of-its-quarantine-and-a-task-that-owes-one-is-not-picked-up.md`

- L3: **Status 追記: 決定3 の「受理そのものの範囲は #3151」は、人間の内容の扉の設計(#3158)に移った —— 受理が見せていない移動を受け入れる穴は実測済みで、受理は変えていない([ADR 0370](0370-landing-compares-every-ref-of-the-named-place-against-the-baseline-before-it-carries-or-records-and-the-acceptance-hole-goes-to-the-door-design.md)、2026-11-12、issue #3151)。**


[82]: https://github.com/sinano1107/tidepool/issues/3182
[83]: https://github.com/sinano1107/tidepool/issues/3183
[84]: https://github.com/sinano1107/tidepool/issues/3184
[81c0]: https://github.com/sinano1107/tidepool/issues/3181#issuecomment-6826259420
[81c1]: https://github.com/sinano1107/tidepool/issues/3181#issuecomment-6826340420
[81c2]: https://github.com/sinano1107/tidepool/issues/3181#issuecomment-6829835510
[81c3]: https://github.com/sinano1107/tidepool/issues/3181#issuecomment-6852773733
[81c4]: https://github.com/sinano1107/tidepool/issues/3181#issuecomment-6855255656
[81c5]: https://github.com/sinano1107/tidepool/issues/3181#issuecomment-6875111340
[82c2]: https://github.com/sinano1107/tidepool/issues/3182#issuecomment-6827240907
[82c3]: https://github.com/sinano1107/tidepool/issues/3182#issuecomment-6827759969
[82c4]: https://github.com/sinano1107/tidepool/issues/3182#issuecomment-6827814268
[82c5]: https://github.com/sinano1107/tidepool/issues/3182#issuecomment-6828147925
[82c6]: https://github.com/sinano1107/tidepool/issues/3182#issuecomment-6828216166
[82c7]: https://github.com/sinano1107/tidepool/issues/3182#issuecomment-6828663593
[82c8]: https://github.com/sinano1107/tidepool/issues/3182#issuecomment-6856859129
[82c9]: https://github.com/sinano1107/tidepool/issues/3182#issuecomment-6871462074
[82c10]: https://github.com/sinano1107/tidepool/issues/3182#issuecomment-6875111064
[83c1]: https://github.com/sinano1107/tidepool/issues/3183#issuecomment-6828652428
[83c2]: https://github.com/sinano1107/tidepool/issues/3183#issuecomment-6828731426
[83c3]: https://github.com/sinano1107/tidepool/issues/3183#issuecomment-6828786717
[83c4]: https://github.com/sinano1107/tidepool/issues/3183#issuecomment-6846771824
[83c5]: https://github.com/sinano1107/tidepool/issues/3183#issuecomment-6848677818
[83c6]: https://github.com/sinano1107/tidepool/issues/3183#issuecomment-6849166706
[83c7]: https://github.com/sinano1107/tidepool/issues/3183#issuecomment-6879645366
[84c3]: https://github.com/sinano1107/tidepool/issues/3184#issuecomment-6829342407
[84c7]: https://github.com/sinano1107/tidepool/issues/3184#issuecomment-6829996105
[84c8]: https://github.com/sinano1107/tidepool/issues/3184#issuecomment-6830036116
[84c9]: https://github.com/sinano1107/tidepool/issues/3184#issuecomment-6830213993
[84c11]: https://github.com/sinano1107/tidepool/issues/3184#issuecomment-6853023364
[84c12]: https://github.com/sinano1107/tidepool/issues/3184#issuecomment-6855256343
[84c13]: https://github.com/sinano1107/tidepool/issues/3184#issuecomment-6856858516
[84c14]: https://github.com/sinano1107/tidepool/issues/3184#issuecomment-6875118212
[84c15]: https://github.com/sinano1107/tidepool/issues/3184#issuecomment-6877948462

## 2. GLOSSARY.md の行

### 2-a. ticket が語を名指した行

| 語(見出し) | GLOSSARY.md の行番号と今の文 | 直す内容 | ticket と comment URL |
|---|---|---|---|
| 「人間の checkout」(見出し語ではない。Slot-release tree rule・GitHub identity・Workspace の本文に出る句) | `GLOSSARY.md:387`「人間の hooks は走らず、人間の checkout の ignored は繰り返し消えない」/ `:631`(2箇所)「人間の checkout の origin が ssh 綴りでも盤面は自分の https で出る」「網に出る git は人間の checkout の中では走らず」/ `:653`「旧・worker が人間の checkout で走っていた頃」 | 直す指示ではない —— この句は既に別の意味(人間が持つ checkout)で使われているので、新しい checkout の名前に使わない、という制約。「名前は終点で付ける。それまで『盤面が人間のために開く checkout』と呼ぶ」。名前は #3235 が **作業台(Workbench)** と決めた(map の Notes L16 と L50。語を足す行は map L204 = #3235 の持ち分)。4箇所とも今の GLOSSARY.md に在ることを確かめた | [#3181 c0][81c0] 決定4 |

### 2-b. ticket は語を名指していない(総称の「GLOSSARY は終点でまとめて書く」だけ)

#3183 の [c1][83c1] 限界と #3184 の [c3][84c3] 限界は「…と GLOSSARY は終点でまとめて書く」と書くだけで、見出しも行も挙げていない。#3182 は GLOSSARY に触れていない。下は、1 の行の決定が偽にする文を GLOSSARY.md で探した候補(私の読み。網羅ではない)。

| 語(見出し) | GLOSSARY.md の行番号と今の文 | 直す内容(候補) | 元になる決定 |
|---|---|---|---|
| Branch discipline(ブランチ規律) | `:419`「quarantine の受理(人間の回答が『動いた ref のほうが正しい』の受理)だけが撮る」 | 受理は動いた ref を受け入れない(`repaired by hand` は違いがあれば拒む)。全撮りは #3185 決定8 が消す | [#3183 c1][83c1] 決定3(+ #3185) |
| Quarantine(隔離) | `:453`「conflict すれば回答は拒まれ、人間は手で merge を解くか、捨てるなら `git merge -s ours` で記録する —— quarantine 中の checkout への手の書き込みはこの回答で受理され、受理が成立すれば基準を撮り直す」 | 書く場所は作業台、回答が取り込む。「手の書き込みはこの回答で受理され」「基準を撮り直す」は偽になる | [#3182 c2][82c2] 決定1・6、[#3183 c1][83c1] 決定1・3 |
| Quarantine(隔離) | `:453`「workspace の封じ込め…は『検査を回答時にもう一度走らせて成立する』」 | 真のまま。purely-local では回答が検査の前に作業台の tip を取り込む、が足される | [#3184 c3][84c3] 決定2、[c7][84c7] |
| 着地(Landing) | `:435`「失敗 question の文面に従って積み残しを手で merge back すると名前の場所の ref が動くので、次の retry や回答は着地の比較に当たり、workspace の Quarantine を1枚経てから、もう一度で通る」 | H5 は `retry` が merge back を撃ち直す。conflict は作業台で解く | [#3182 c2][82c2] 決定11 |
| 着地(Landing) | `:435`「盤面の外の push が落としたもので、盤面には運ぶ手が無い」 | `merge` の回答が作業台の tip を取り込み、盤面が origin へ push する | [#3183 c1][83c1] 決定8 |
| Workspace(ワークスペース) | `:645`「人間用の checkout は盤面の checkout と分ける」「人間はホスト上でそれを覗くが、書かない — 人間が ref を動かせば…quarantine が立ち、その回答の受理が基準を撮り直す」 | 書く場所として作業台を指す(map L204 が #3235 の持ち分として挙げている行)。「その回答の受理が基準を撮り直す」は偽になる | [#3181 c0][81c0] 決定1、[#3183 c1][83c1] 決定3 |

探して 0 件だった句: `repaired by hand`、`空の面接室`、`手で作る`、`path だけ差し替え`、`verb は作らない`、`巻き戻さない`、`封じ込めの回答`(GLOSSARY.md 全体)。面接室の出口(ADR 0277 追記 決定2)と path の差し替え(ADR 0351 決定7)に当たる GLOSSARY の文は、この句では見つからなかった —— 別の言い方で書かれているかは確かめていない。

## 3. 申し送り

この4 ticket の本文とコメントに、#3237(「置き換える ADR の範囲を確定する」)と #1796 を名指す文は無い(`3237`・`1796`・`置き換える ADR`・`範囲を確定` とも 0 件)。「終点」に ADR / GLOSSARY を送る文は次のとおり。

- 「名前は終点で付ける。それまで『盤面が人間のために開く checkout』と呼ぶ。『人間の checkout』は GLOSSARY で別の意味に使用済み。」—— [#3181 c0][81c0] 決定4。名前は #3235 が決めた(作業台)。
- 「決め直す ADR(0351 決定4 の理由、0240 決定4 の広がり、0103 決定4、0105 決定2 ほか)は終点でまとめて書く。」—— [#3182 c5][82c5] 限界。**「ほか」は開いたまま** で、ticket は中身を挙げていない。スレッドの中で #3182 の決定が触れる ADR として読めたのは、0239 帰結(決定2 と 0351 決定4 の句の経由)、0364(決定7 の「同じ手」と 1-b の不変条件)、0362 決定2(決定8 の拒む場所)。決定8 の残り2つの検査(隠せない形・gitlink)に当たる ADR(0360 決定4、0365 と見られる)は ticket が番号を挙げておらず、0365 は開いていない。
- 「採否は ADR 0053 決定2(非 ff の merge back の根拠)と ADR 0364 決定1(門は祖先を確かめない)を決め直す。」—— [#3182 c3][82c3]。続く resolution が「完了の門で worker に帰り先を merge させる形は、この map で決めない。#3189 に出した。」([#3182 c5][82c5] の 1.)と書いたので、この2つは map の外。
- 「決め直す ADR(0239 帰結、0064 決定3・7、0351 決定7、0242 決定4、0277 追記 決定2)と GLOSSARY は終点でまとめて書く。」—— [#3183 c1][83c1] 限界。
- 「**決め直す ADR の一覧に漏れ。** 決定9 は ADR 0052 §7(保護ブランチを手で origin へ巻き戻すか push する)、決定10 は ADR 0146(`.git` の形)も決め直す。」—— [#3183 c3][83c3]。
- 「決め直す ADR(0351 決定1・4、0362 決定1 の書き手の道、0360 決定3 の直し方、入口の決定8)と GLOSSARY は終点でまとめて書く。足す操作と question の名前も終点で付ける。」—— [#3184 c3][84c3] 限界。「入口の決定8」は ADR でなく #3182 の決定8(#3184 決定6 の表がこの2つの回答についてだけ替える)。名前は #3235 が決めた。
- 「**決め直す ADR に ADR 0259 決定5 を足す。** 封じ込めの回答が『同じ検査を撃ち直す』だけでなく取り込みも行う。」—— [#3184 c7][84c7]。
- 「ADR 0084 決定1 と着地の除外(`src/landing.ts:430–437`)はそこで決め直す。」—— [#3184 c13][84c13]。「そこ」は #3207。
- map の Notes(L11):「決定は各 ticket の resolution comment に置く。ADR と `GLOSSARY.md` は終点でまとめて書く(途中の ticket が前の決定の前提を変えうる)。」
- map の「Spec へ渡すもの」のうちこの4 ticket の block(L78–L87)に `- ADR / GLOSSARY:` の行は無い。4 ticket の ADR の約束は、上の resolution の限界の文にだけ在る。

## 4. 読んだ範囲

- **#3181**: 本文 + コメント 6 件(c0〜c5)を全文。
- **#3182**: 本文 + コメント 11 件(c0〜c10)を全文。
- **#3183**: 本文 + コメント 8 件(c0〜c7)を全文。
- **#3184**: 本文 + コメント 16 件(c0〜c15)を全文。
- **map の保存版**: L1〜L100 と、`- ADR / GLOSSARY:` の行(L126〜L326 の 14 行)を読んだ。L101〜L327 の残りは `318[1-4]` の grep(当たりは L23・L25・L26・L27・L78・L83・L85 だけ)と上の 14 行以外は読んでいない。
- **純効果の出所**: この4 ticket に置かれた上書き・訂正のコメントは全文を読んだ。上書き元の ticket のスレッドは読んでいない —— #3185 だけ、決定1・8・9・10・17 と「決め直す ADR」の行を抜き読みした。#3190・#3196・#3203・#3205・#3206・#3207・#3214・#3216・#3233・#3235・#3238・#3239 の中身は、map の「Decisions so far」の要約と、4 ticket に置かれたコメントの文から書いた。
- **開いた ADR(21 本)**: 0040、0052、0053、0064、0084、0100、0103、0105、0146、0239、0240、0242、0259、0277、0351、0356、0359、0360、0362、0364、0369。全文を読んだのは 0100・0103・0105・0146・0239・0240・0242・0277・0351。残りは Status 行と該当の決定(と、その決定を退けた形・Considered options の該当行)だけ。0356 と 0369 は日付と決定の見出しだけ。
- **開けなかった ADR**: 無い。開いていない ADR で名前だけ出したもの: 0365・0370・0243・0329(Status 追記や ticket の文の中の参照として)。
- **確かめていないこと**: #3182 決定3 の「完了の門の順を決めた ADR は見つからず」の網羅。ADR 0052 §7 に無かった「手で origin へ巻き戻すか push する」の文がコードのどこに在るか。2-b の候補は句の検索で拾ったもので、GLOSSARY.md の通読ではない。

