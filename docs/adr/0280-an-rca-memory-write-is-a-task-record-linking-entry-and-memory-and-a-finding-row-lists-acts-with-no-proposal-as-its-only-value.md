# RCA の学びの書き込みは RCA の task に帰属する記録でエントリと記憶を結び、所見の行は行為を列挙して `no_proposal` だけを値に持つ

**Status 追記: 題と決定3 の値 `no_proposal` は `no_act` に改名(issue #2580)** —— 行為(この RCA が書いた記憶・この RCA の修理子)の無い所見を表す。

**Status 追記: 決定1 の verb は `propose_from_material`(引数 `material_id`)、その記録の event は `proposed_from_material`(欄 `material_id`)に、決定2 の所見の `entries` は `material` に改名(issue #2577)** —— 行と拒否文は id を材料の種類で名指す: 異議の RCA は今の「entries 501, 502 → …」のまま、停止の RCA は「stop 700 → …」。

2026-10-19 の grilling(issue #2285、元 #1919 / ADR 0278)で決定。ADR 0278 決定5 は RCA の所見の帰結 `proposed` を「この RCA が
立てた candidate」から導くと決め、決定3 はその根拠を「candidate の作成は記録が既に持つ」とした。記録はそれを持っていなかった ——
Behavior candidate の作成 event は記憶の店の event で task を持たず(ADR 0252 決定2)、出所の帰責 event はエントリを名指すが RCA を
名指さない。Knowledge は書き込みの行(`memory_written`)が RCA に付くが、どのエントリから書いたかが無い。self RCA と auditor RCA は同じ
異議群を材料にするので、書いた RCA を記録が名指さなければ、書いていない側の所見にも `proposed` が導かれ、その RCA の `no_proposal` は
行為済みへの値として黙って捨てられる(ADR 0278 決定3)。agent 名は、異議されたエントリを Auditor が書いていれば両方 Auditor で一致する。
実測(`file:line`)は #2285 のコメントに置く。

## 決定

1. **`propose_from_objection` は、呼んだ RCA の task に帰属する記録を1つ残す** —— 材料のエントリの id と、書いた記憶(店の event の id)。
   Behavior candidate も Knowledge も同じ形。人間向けの行(判断ログ)ではなく、異議の対象にも未読にも数えない —— pull の記録
   (`memory_pulled`)と同じ側。記憶の店の event と `source` は変えない(盤面の Behavior 起草の抑止は `source` が帰責 event を指すことで
   引いている、ADR 0170 決定1)。記録と店の書き込みは1つの transaction で、拒否・失敗ならどちらも残らない。
2. **所見の帰結は、この記録と、この RCA の子から導く。** 所見の `entries` と記録のエントリが交われば行為あり。Knowledge も行為に数える ——
   書いた瞬間に効いているものを「提案なし」と書かせるのは偽で、第2回の帰責がその行を読む。
3. **所見の行は行為を列挙し、1語に畳まない。** ADR 0278 決定5 の `proposed` / `repair` は使わない。行為のある所見の文は
   「entries 501, 502 → behavior candidate #77, knowledge #78, repair <task id> — <root_cause>」、行為の無い所見だけが値 `no_proposal` を持ち
   「no_proposal: entries 503 — <root_cause>」。型つきの欄は entries・root_cause・書いた記憶(id と種別)・子(id と status)、行為が無ければ
   `no_proposal`。帰結を型として読む機械は今は無く(第2回の帰責は文を読み、人間は列挙の先頭を読む)、1語に畳むには行為の種別が重なる所見
   (cause の違う異議群をまたぐ所見、同じエントリへの2回目の起草、記録と子の両方)に優先順位の規則が要り、その規則の読み手がいない。

## 退けた案

- **店の作成 event に書き手の task とエントリを持たせる** —— ADR 0252 が退けた形(記憶の店の event は task を持たない)。
- **candidate の作成も書き込みの行にする** —— ADR 0252 決定1 と ADR 0159(承認 question が門)に二重の門を作り、candidate が異議の対象になる。
- **`proposed` を verb の値にする** —— ADR 0278 が退けた「verb が全判断を運び盤面が照合する」。self / auditor の両方が名乗れるので解決しない。
- **帰結を1語に畳み、優先順位(`proposed` > `recorded` > `repair`)で選ぶ / 値を配列にする** —— 読み手の無い語のために規則か型の例外を作る。
- **Knowledge を行為に数えない** —— 偽の `no_proposal` を第2回の帰責が読む。

RCA が Knowledge を書いた異議群にも盤面が Behavior を起草する(出所の種別で抑止が決まる)という疑いは #2298 で実測し、起きないと確認した —— RCA が起草できる異議群(初回で確定)に第2回は無く、盤面が起草する異議群(初回 `uncertain` / 未帰責)では RCA の起草が拒まれる。所見が2つ以上で
子が1つのときの近似(#2279)はそのまま。
