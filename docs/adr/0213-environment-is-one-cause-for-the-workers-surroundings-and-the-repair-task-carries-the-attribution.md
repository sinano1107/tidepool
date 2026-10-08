# `environment` は worker の外側の事情を指す1値で、境界は判断の妥当性、修理タスクが帰責を運ぶ

2026-10-08 の grilling(issue #1602)で決定。cause `environment` の読みが2つに割れていた —— 帰責・配分評価の prompt は
「道具・網・sandbox の故障」、CONTEXT.md の注釈と記憶の無効化理由(ADR 0166 決定7「陳腐化」)は「世界の側が変わった」。
CONTEXT.md の注釈は ADR 0115 の commit で書かれ、ADR 0111 / 0115 のどちらも定義を持っていなかった。消費者(RCA の門・
candidate の起草・routing の負の信号)はどれも2つの読みで振る舞いを変えないが、prompt の狭い読みの下では「上流 API が変わった」
異議の行き先が無く `uncertain` に倒れ、RCA 2 session と第2回を払う。併せて、「持続する盤面側の故障」を修理だけで閉じて
よいかを問うた —— 判定する Board call の入力は entry・steering・decision log・読んだ記憶で、資源の今の状態は見えず、
一過性か持続かを知れるのは同じ壁に当たる修理 worker だけである。今の実装の walk-through は #1602 のコメントに置く。

## 決定

1. **`environment` は1値のまま、worker の外側の事情 —— 盤面の道具・網・sandbox の故障も、上流の変化も —— を指す。**
   prompt 2本と CONTEXT.md をこの読みに揃える。無効化理由の `environment`(陳腐化)はこの読みの中にあり、触らない。
2. **境界は判断の妥当性で引く。** 判断がその時の入力に対して妥当だったときだけ `environment`。壁への worker の応じ方
   —— escalate せず迂回した・推測した・黙って進めた —— 自体が異議の対象なら `capability`。self RCA の問い「なぜ escalate
   せずそう判断したか」が空でないからで、ADR 0115 決定3 の根拠がそのまま線になる。
3. **修理タスクの purpose は、対(entry + steering)の横に帰責の判定(cause と evidence)を運ぶ。** 判定は登録の前に
   手元にある。修理 worker は「環境側と判定済み」を知って、同じ壁に当たった時点で迂回を試みず escalate できる。
   **RCA review には渡さない** —— RCA の findings は第2回の帰責の証拠(ADR 0115 決定2)で、初回の判定を見せれば第2回が
   自分の初回を証拠にする循環になる。
4. **人間の面(ログ読取面 —— WebUI と管理 MCP)の異議の注釈に、保存済みの `evidence` を出す。** 今は cause と `entries` だけ
   (ADR 0166 決定6)で、「何が環境の問題だったか」の本文は保存されているのに見えない。worker 向け `list_precedents` には
   足さない。#1601 の「盤面の prompt を人間の面に出す」はこの面を継ぐ。
5. **`environment` から専用の扉(question / human task)は立てない。** 持続する盤面側の故障は、修理子が壁に当たって escalate
   した question として、異議された親の下に出る —— 親 entry の `environment` 注釈と結べるので、観測は今の機構で記録できる。
   2度目の session を払う形で観測を待つ(観測は #1605)。

## 退けた案

- **故障と外部の変化で2値に割る** —— 分けて振る舞いを変える消費者が無く、ADR 0115 が退けた「分類が2本あると漂流する」に戻る。
- **commit 時に `environment` の帰責ごとに確認型 question を立てる** —— 判定側は持続性を知れないので、一過性・外部の変化の
  異議にも人間の着席を払う。
- **RCA の purpose にも判定を乗せる** —— 決定3 の循環。RCA に渡る対は `capability` 系か `uncertain` / 未帰責だけで、得る情報も無い。
