# 報告なき exit の question は worker の最後の発話を逐語で添え、盤面はそれで判定しない

2026-10-02 の triage / grilling(issue #1296)で決定。#724 の worker は1ターンを完走して exit 0 で終わり、最後の
`agent_message` で原因(verb が MCP server に cancel された)をそのまま言っていたが、「報告なき exit」(ADR 0145)の
failure question には載らず、人間は transcript を開くしかなかった。transcript は WebUI から読めず、Pi の盤面では
SSH が要る。ADR 0188 が「CLI が報告した失敗」と線を引いて切り出した、もう一方の主語である。行の形の調べと実装の
範囲は #1296 のコメントに置く。

## 決定

1. **worker の最後の発話は、空でなければ逐語で添える。** ADR 0188 決定1 と同じく転記であって盤面の断言ではなく、
   ADR 0145 決定6 の「断言は3つだけ」は変わらない。表示にだけ使い、どの判定にも使わない。worker が「完了した」と
   言っていても、本文が既に「最終報告なしに exit した」と断言しているので注意書きは足さない。
2. **「最後の発話」は root のモデルが書いた最後の text であり、exit の形を問わない。** 走り終えた exit に限らない
   —— 途中で殺された worker が最後に何を言っていたかも判断の材料である。CLI が合成した文(Claude の
   `<synthetic>` の assistant 行)は除く —— それは ADR 0188 の主語で、二重に載る。subagent の文は除く —— root に
   返す途中の文であって、worker が盤面や人間に言った言葉ではない。
3. **最後の1件を切り詰めずに載せる。** 長さはモデルの出力上限で閉じており、長いまとめこそ retry / abandon の
   材料である。読みにくい長さが観測されたら上限を足す。
4. **並びは起きた順** —— 本文、worker の最後の発話、CLI が報告した失敗、stderr 末尾。運び方は ADR 0188 決定5 と
   同じで、adapter が `worker_exited` に載せ、question は提供元を見ずに描く。合成の印は CLI の版上げの適合試験に
   足さない —— 印が変わっても同じ文が二重に載るだけで、判定は誤らない。

## 帰結

- 範囲は「報告なき exit」だけである。watchdog kill の question は回収済み観測で立ち `worker_exited` を受け取ら
  ないので、別 issue で扱う。再起動中断は boot 時に立ち、拾える先が transcript しか無い —— 盤面は transcript を
  読まない(ADR 0188 決定5)ので対象にしない。

## 退けた案

- **question に transcript の場所だけ書く** —— WebUI から開けず、「開くしかない」が手順の案内に変わるだけ。
- **Claude は正常な result 行の `result` だけ読む** —— result 行の無い exit で何も載らず、Codex と範囲が食い違う。
- **走り終えた exit に限る** —— 決定2。
