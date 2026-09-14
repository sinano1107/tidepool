# Condensation は周期の memory meta-review で閉じ、提案は付帯子の question として人間へ届く

2026-09-15 の grilling(issue #358)で決定。ADR 0083 決定9 は Condensation を3段(異議ごとの RCA が candidate を書く /
周期の meta-review が繰り返しを判断で見て approved 提案を起草する / 人間承認)と置き、ADR 0115 が第1段を「帰責が学習に
向く異議ごとに」へ改めた。Memory ストア(spec #586)は candidate の作成 seam まで持ち、承認・周期・起草の配線が無い。
「従来どおり registry への diff(承認 question 経由)」と issue 本文が呼んだ経路は、実際には registry-edit タスク → PR →
人間 merge であり、承認で diff を適用する question はまだ存在しない。既存実装の調査と `file:line` は issue #358 のコメントに置く。

## 決定

1. **candidate の起草は3経路で、書き手はそれぞれ確定している。** (a) RCA(self / auditor の両方)が review 専用 verb で、
   異議されたエントリを指して書く。kind(Behavior / Knowledge)と宛先は盤面が最新の cause から導出し(ADR 0115 決定4)、
   RCA に選ばせない。門は列を足さず構造で引く: 現在の task が review で、指したエントリが親 task の異議エントリで、
   最新 cause が学習向き。人間が書いたエントリと `uncertain` のエントリは拒否する。(b) `preference` は最終 cause が
   `preference` になった瞬間(初回・第2回のどちらでも)に Board call が起草する(ADR 0115 決定3)。人間の明示指示はこの経路
   そのもので、別機構は無い。(c) `uncertain` が第2回で学習向きの cause に確定したとき、RCA はもう走っていないので、
   第2回の Board call が RCA の findings から **Behavior だけ**を起草する。Knowledge は起草しない —— LLM の推論を
   「事実(出所 = event)」の種別で店に入れる経路は作らず、欠けていた事実は RCA が `record_knowledge` で書いたものだけ。
   scope はいずれも異議された task の workspace、path は書き手が選ぶ。self と auditor が同趣旨の candidate を並べて書くのは
   避けず、畳むのは meta-review の統合の仕事。

2. **周期 meta-review は主題ごとに盤面全体で1本の root review task で、主題は task の列に刻む。** 周期は盤面設定の
   日数(既定 7)で、意味は**間隔の下限**: 基準は前回登録の event、期限超過後は材料(candidate・帰責つき異議・店の変更)が
   出しだい登録し、材料が無ければ登録せず event も残さない。主題ごとに未決着(open な task または open な提案 question)が
   あれば飛ばす。assignee 未指定 → Auditor、workspace null(既定への参照 —— 記憶は MCP で読み、checkout は使わない)。
   ルート review に「構造化された対象フィールドは作らない」(2026-07-15)の線は、盤面が門と verb の可視性で主題を機械的に
   読む要求が出たので改訂する。scratchpad の `meta_review` 振り分けは主題 `memory` の手動登録になる。#599 の構造検査は
   同じ task の1工程で、Knowledge / Definition 級の修正は meta-review 専用の書き込み verb で直接適用する。周期機構は主題の
   一覧を持ち、`routing`(#549)は主題の追加だけになる。

3. **提案は meta-review の付帯子の question で、盤面全体の記憶は meta-review だけが書ける。** 提案1件 = question 1件
   (approve / reject、推奨 approve)。question は親を塞がない付帯子 —— 適用は盤面が決定論的に行うので meta-review が
   見届けるものは無く、提案を出し終えた session で完了する。載る提案は candidate の承認、統合(新 candidate の承認 + 旧の
   `superseded` を同一 transaction)、approved Behavior の無効化。Behavior の無効化は worker の判断を変えるので承認と同じ
   門を通り、Knowledge / Definition は通らない。複数 workspace の同じ Behavior を scope null に統合できるのは meta-review
   だけ(決定1 の起草は workspace 固定)。表示は item の detail に載せる散文の diff で、UI は増やさない。

4. **question は「提案」を種別つきの1欄で持ち、種別が適用先を決める。** 今回は `memory` だけで、盤面設定の diff(#549)と
   registry diff(#583)は種別の追加になる。提案は置換 / 無効化対象の版と candidate の状態を pin し、pin が古くなった瞬間
   (対象の無効化 event)に盤面が question を observed として決着させる(`pr_merge_observed` と同型)—— 人間に「詰まりを
   解くための reject」をさせない。candidate は候補のまま次周期に再提案される。人間の reject は candidate を理由コード
   `rejected` で無効化し、統合の reject は統合後の新 candidate だけを無効化する(元の candidate 群と approved は残る)。
   meta-review は無効化済み candidate と理由を読めるので同じ提案を繰り返さない。

## 退けた案

- **盤面が RCA の findings から Board call で起草する(RCA 本人は書かない)** —— 決定9 の「RCA が書く」を崩し、書き手の
  出自(self / auditor)が消える。第2回の穴だけに限って使う(決定1(c))。
- **RCA が `uncertain` のエントリにも書き、非学習の cause に確定したら盤面が無効化する** —— `task_ambiguity` の宛先
  (登録者)を RCA 時点で決められず、宛先の書き換えは「承認は文言に対して」と噛み合わない。
- **提案 question を分解子(pending-child 型)にする** —— 最後の回答の後に meta-review が自分を完了させるためだけに
  Auditor がもう1 session 走る。
- **pin が古い question は approve を domain error で拒否し、人間に reject させる** —— 未決着1本の規則と合わさって、
  人間が reject するまで次周期が止まる。
- **周期の基準を前回の検査に置き、飛ばした事実を event に残す** —— 候補が出てから最長1周期は必ず寝かせる形になり、
  繰り返しの有無を時刻で代替する。判断で見る線と重なる。
- **workspace ごとに meta-review を1本** —— 盤面全体への統合を書ける task が無くなり、Auditor の session が workspace
  数だけ増える。1 session に収まらなくなったときの分割は issue #614。
