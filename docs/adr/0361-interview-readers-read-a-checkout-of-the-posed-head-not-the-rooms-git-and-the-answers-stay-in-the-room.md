# Interview の読み手は面接室の `.git` ではなく出題の head の checkout を読む —— 面接室を開く worker は居なくなり、答案の ref は面接室のまま、書き手側の trailer 対策は採らない

**Status 追記: 決定1 の「出題の head」は読み手ごとに決まる —— review の鎖が監査を通る読み手(監査、その行への異議の RCA)はその監査が見た出題の head を、他の読み手は root の最新の出題の head を読む。却下の後に出し直した root では、却下した監査への異議の RCA が読むのは最新でない head である。面接室の pickup の項はこの head を読み手ごとに、読み手の checkout の fetch が要る閉包まで検査する([ADR 0329](0329-a-recorded-places-opened-event-is-written-after-its-repo-exists-the-room-and-the-examinee-checkout-share-one-opening-procedure-and-a-room-named-quarantine-is-released-by-re-running-every-predicate-that-raises-the-name.md) 決定4 の Status 追記、2026-11-12、issue #3136)。**

2026-11-09 の grilling(issue #3071、#3031 の実装で見えた疑い。#2248 / #3072 は同じ族)で決定。ADR 0356 決定2 は受験者の答案の ref を
面接室の `task/<受験者 id>` に着けたが、その根拠は「盤面は worker の `.git` に書かないので置き場は面接室になる」という消去法で、検討した
読み手は兄弟の受験者だけだった。一方、retry の新しい root・出題の監査・異議の RCA・人間登録の review 子は、面接室を**path 丸ごと**
(`.git` 込み)sandbox の読み path に受け取っていて、全 ref を `git log` / `show` できる。worker の commit は fetch でそのまま着くので、
CLI が書いた trailer(固定版 2.1.286 の Claude は `Co-Authored-By: Claude Sonnet 5.5` を載せた —— #3071 の実測)も model が書いた文も
採点者側に届き、ADR 0273 決定2(採点者は答案と対象の結びつきを読めない)に触れる。読み手が面接室に求めるのは**環境**である
(ADR 0273 決定1「監査・異議・retry が環境を読む」、監査の purpose「read the interview room at the posed head」、ADR 0276 決定4
「読みに開くのは面接室(環境)、root の採点の入力は伏せた handoff」)。答案の ref を読む worker は決定上1人もいない。
受験者は自分の branch だけを fetch した checkout を貰い、採点者側は記録そのものを貰う —— 走る場所は ADR 0356 で fetch した
checkout に揃えたのに、読む場所だけが名前の場所を直接開く形で残っていた。「`.git` ごと渡す」はどの ADR も決めていない写しである。
読み手の表と `file:line` は #3071 のコメントに置く。

## 決定

1. **Interview の読み手(retry の root が読む旧い面接室・根拠の面接室、root 配下の review が読む root の面接室と開ける面接室)は、
   面接室の path ではなく、盤面が session ごとに `git init` + 出題の head だけを fetch して作る読み専用の checkout を読む。** 受験者の
   乗り物と同じで、違いは fetch する ref が出題の head で、書けないこと。読み手に届くのは盤面が列挙した tree だけになる(ADR 0358 決定1 /
   ADR 0360 決定1 と同じ向き)。出題の head が無い面接室(出題前に落ちた root)は環境が無いので checkout は空 —— root の WIP branch は
   足さない。異議の RCA が読む root の判断は decision log と handoff にあり、git には無い。読む場所の**名前**は面接室の root id のままで、
   quarantine と封じ込めの組の単位(ADR 0273 決定8 / 追記 #2265)は変わらない —— fetch 元は面接室なので、準備の失敗は面接室の性質
   (ADR 0276 決定3 の線)。寿命は task の checkout と同じ session で、解放で消す。面接室の `.git` を開く worker は居なくなる。#2248 のうち worker の読み手の側(監査・retry の root が覗くと作業ツリーが空)は同じ変更で消え、人間が面接室の path を覗く側は残る(人間は git で読む —— ADR 0273 決定1 の線のまま、#2248 で問う)。
2. **答案の ref の置き場は面接室のまま。** 決定1 の後、面接室を読む worker は居ないので、答案の ref が面接室にあっても採点者には届かない。
   答案の器を分けるのは、面接室を読む worker が1人でも要る日だけ。人間が読む答案の記録は面接室の `task/<受験者 id>`(ADR 0359 決定1 の
   門を通った tip)で、決着した最後の checkout(ADR 0276 決定4)は副次(#3072 の主題)。
3. **書き手側の trailer 対策(worker settings に `attribution: {commit: "", pr: ""}`)は採らない。** 決定1 の後、答案の commit message を
   読むのは人間だけで(Interview の答案は着地しない)、採点の純度には当たらない。vendor の鍵1つで閉じる形は ADR 0358 が退けた
   「名前を1つ足す点修正」と同型で、CLI の版が trailer を足すたびに追うことになる。#1884(model 自身の文)も人間の読み手の件に縮む。
   worker の commit に model 名が載ること自体の是非は Interview とは別の問い(記録の衛生)で、ここでは決めない。

## 退けた形

- **`attribution` を worker settings に足す**(#3071 の triage の推奨)—— 書き手の1文字列を閉じるだけで、読み手が `.git` を開く形は残る。
  反転条件として書かれていた「盤面が付けた文字列で結びつく経路」は、読み手の面を tree にすれば経路ごと消える。
- **ref の名前空間を分ける / 答案を別 repo に置く**(#3071 本文)—— 読み手を `.git` の上に置いたままの案で、前者は OS の床では隠れず、
  後者は ADR 0356 決定2 の解放と再開を受験者だけ別の形にする。
- **読み手の checkout に root の branch も fetch する** —— 要する読み手が無く、root の WIP の件名は Interview の語を運ぶ(ADR 0276 の漏れ3)。

## 派生

- Status 追記: ADR 0273 決定4・9(読む面接室 → 出題の head の checkout)、ADR 0276 決定4、ADR 0356 決定2。GLOSSARY.md: 面接室、task の checkout。
- 出題の head が面接室で引けることは面接室の pickup の項(解除の門も撃つ)になり、出題済みの面接室には `git init` の出口を予告しない —— Status 追記: ADR 0277 追記 決定2、ADR 0329 決定5(issue #3105 の実装レビュー)。
- 実装は `/to-spec`(1 slice —— 読む場所の列挙・sandbox の読み path・停止の門の名前は変えない)。#2248 は worker の側だけ閉じるので `Closes` にせず、spec にコメントで寄せる。#3072 は決定2 に依る別 issue。
