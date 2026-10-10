# 組み込み agent は委譲先として示さず、Assignee の候補は type で出し分ける

2026-10-10 の grilling(issue #1744)で決定。ADR 0228 決定1 で、組み込みに解決される assignee の work は登録・Edit・decompose
の門で拒まれるようになった。ところが候補を示す面は門より先に組み込みを差し出していた —— WebUI の Assignee 候補(Register /
Edit / 下書きの「Known assignees」)と worker の roster(spawn 時の push の `*` 展開と `list_agents`)は registry の全 agent
から組まれ、shadow の無い `fugu` を含む。選ぶと必ず拒まれる候補である。測定と各面の経路は #1744 に置く。

## 決定

1. **組み込みに解決される名前は roster に現れない。** push(`*` の展開・名指し)と `list_agents` の両方から除く。委譲は常に
   work で、組み込みは work を実行しないので、行の意味(「この相手に振れる」)が成立しない —— 盤面自身が roster に現れない
   のと同じ理由である。`list_agents` の `direct` / `needs_approval` はどちらも組み込みには偽になる(decompose は変換せず拒む)。
   判定は解決の結果を見る(ADR 0228 決定2)ので、shadow している間は普通の agent として現れる。`assignable_to` に名指しされた
   組み込みは、registry から消えた名前と同じく黙って飛ばし、profile を書く扉では拒まない —— shadow すれば正しい名前になる。
2. **WebUI の Assignee 候補は type で出し分ける。** work の Assignee と下書き(work のフォームを埋める)からは組み込みを外し、
   review の Assignee と ReviewerPicker には残す。review で組み込みを指名することは ADR 0228 が禁じていない。
3. **「この type の assignee に取れるか」は leaf の1関数が答える。** サーバーの門と WebUI が同じ関数を呼び(ADR 0209)、
   WebUI は候補の応答から「組み込みに解決される名前」を受け取る。
4. **Edit の選択肢は現在値を必ず含め、規則が絞るのは新しく選ぶ候補だけである。** 外れた現在値を出さないと、select は値を
   持ったまま別の表示をする —— work が組み込みに落ちた quarantine の修理(ADR 0228 決定4)はまさにこの画面で付け替える。

worker が `review_by` に組み込みの名前を書く手がかりは roster から消える。省略すれば Auditor に解決されるので、Auditor を
付け替えた盤面で組み込みを名指したい場合だけが失われる。その必要は観測されていない。

## Considered options

- **候補から組み込みを一律に外す** —— 候補の配列は Assignee と ReviewerPicker が共有するので、review での指名まで取り上げる。
  ADR 0228 決定1 の範囲を超えた制限になる。
- **サーバーが type 別に2本の候補を返す** —— leaf は増えないが、「review なら組み込み可」の対応を WebUI が写す。ADR 0209 が
  消した形である。
- **roster に残して「委譲できない」の3値目で印を付ける** —— 振れない相手を委譲の材料に並べる理由が無く、盤面自身を roster
  から外した線と食い違う。
