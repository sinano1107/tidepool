# 統合の提案は既存の candidate を後継に名指せ、置き換えの無い承認は元の replaces が生きていても通る

2026-09-30 の grilling(issue #1054)で決定。ADR 0120 決定4 は陳腐化した提案の candidate を「候補のまま次周期に再提案」と
置き、ADR 0165 は defer で閉じた提案も同じ形で残すと決めたが、再提案する op が無かった。`approve` は replaces を持たず
Behavior candidate しか受けず(Exemplar が生まれる前の門の名残)、`consolidate` は新 candidate を書くか既存の approved を
後継に名指すかの2形で、既存 candidate を同じ replaces で出し直せない。`approve` で承認すると元の replaces が生きたまま
残る —— Behavior でも今日そうなる。現状のコード調査と `file:line` は issue #1054 のコメントに置く。

## 決定

1. **統合の提案は既存の candidate を後継に名指せる。** `consolidate` は `text`(新 candidate)/ `successor_id`(既存 approved)/
   `candidate_id`(既存 candidate)のちょうど1つを取る。名指せるのは未無効化の Behavior / Exemplar candidate で、書き手は
   問わない —— RCA 起草の candidate が既存 approved を置き換える提案も書ける。承認は文言の保証であって出自の保証ではない
   (ADR 0152)。新 entry を書かないので `based_on_decision` は取らず、question の見た目と reject / defer の挙動は初回の統合と
   同じ。陳腐化・defer で閉じた提案の再提案はこの形で、replaces はその周期の判断で選び直す —— 初回と同じ門(種別・未無効化・
   他の open な提案に無い・Exemplar は candidate の出所を共有)だけを掛け、前回の replaces との差分を扉は見ない。
2. **`approve` は Exemplar candidate も受ける。** 承認側は #950 で既に受けており、扉だけが Behavior 限定だった。replaces を
   全て失った candidate を承認する口は種別によらず要る。
3. **`approve` は、その candidate が前に置き換えようとした entry が生きていても断らない。** 人間の defer / reject の comment が
   「片方は別に残せ」なら単体承認が正しく、門はその道を塞ぐ。置き換えるか残すかは履歴(ADR 0159 決定1)と comment を読んだ
   meta-review の選択で、issue が言う穴は「盤面が黙って重複を残す」から「meta-review が選ぶ」に変わる。
4. **盤面は再提案の question に前回の回答を足さない。** 再提案の理由は meta-review の rationale が運び、人間は question から
   履歴へたどれる(ADR 0159 決定2)。決定1・3 と同じく、扉に履歴の読み直しを持ち込まない。

## 退けた案

- **陳腐化した Exemplar candidate を meta-review が `rejected` で引退させ、同じ replaces で起草し直す** —— meta-review 名義の
  `rejected` は「Behavior にも Exemplar にもならない」の印(ADR 0159)で、起草し直すための引退と区別がつかない。ADR 0165 が
  defer で退けたのと同じ形。
- **`approve` に replaces を足す** —— 承認側は op を問わず replaces を superseded にするので変更は扉だけで済むが、`consolidate` =
  置き換えがある / `approve` = 置き換えが無い、という op の語彙が崩れる。
- **後継に名指せる candidate を meta-review 起草(前回の提案があるもの)に限る** —— 「前回の提案」の検査が扉に入り、文言を
  書き直させる理由も無い。
