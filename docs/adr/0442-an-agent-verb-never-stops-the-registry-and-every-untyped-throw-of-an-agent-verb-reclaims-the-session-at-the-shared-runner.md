# agent の verb は registry を止めない —— agent の verb の型の無い throw は、共有の runner で1回だけ session を回収する

2026-11-28 の triage → grilling(issue #4010、#3908 の ponytail-review の派生)で決定。ADR 0403 決定5 は、registry の止まりを読み込みの
1点が立てると決めた。ADR 0424 決定3 は、資源の停止は今の観測者が立て、verb は立てないと決めた。agent の verb も同じ読み込みの1点を
通るので、verb の時点で registry の止まりが立っていた。ADR 0403 決定5 が名指した経路は、盤面が自分から動く経路と人間の要求の2つで、
agent の verb には触れていない。同じ triage で、型の無い throw を回収に替えていたのは一部の verb だけで、共有の runner はほかの verb の
throw を素の protocol error で返していると分かった(#4009)。経路と箇所の表は #4010 に置く。

## 決定

1. **agent の verb の registry の読みは止まりを立てない。** registry の観測者は、走る前なら pickup の門、走った後なら後始末である。
   後始末の読みは、verb から始まった後始末でも止まりを立てる。ADR 0403 決定5 の「読み込みの1点が立てる」は、盤面が自分から動く
   経路と人間の要求(management MCP を含む)に限る。
2. **registry を読めなかった verb は、委任の verb(`list_agents` / `decompose` / `redecompose`)も含めて、failure question を登録して
   session を回収する。** 委任したいという worker の判断を盤面は上書きしない。回収の failure question が失敗した verb を名指して
   retry の session に届き(ADR 0045 決定3)、壊れの観測は回収の直後の後始末が引き受ける。ADR 0424 決定4 の拒否文の例外は、
   自分の agent 定義が解けない場合だけに残る。
3. **回収は共有の verb の runner の1か所に置く。** `DomainError` でない throw は、どの agent の verb でも ADR 0424 決定2 の回収になる。
   出口の verb(`escalate`)と読む verb にも例外は置かない。escalate の本文が transcript にしか残らない代償は、ADR 0424 が handoff の
   欄で受け入れたものと同じである。
4. **1つの session の回収は1回である。** 回収の後に届いた throw は、session が終わったことだけを返す。
5. **回収の文(failure question の本文と agent への応答)は ADR 0438 の線で書く。** verb の時点では止まっていないので、
   止まりを告げる文は載せない。

## 退けた案

- **registry を ADR 0424 決定3 の例外にする**(盤面全体の資源で、受理が読み直しなので一過性の代償が小さい) —— verb が登録しなくても、
  後始末か pickup の門が同じ壊れを必ず観測するので、verb の登録は観測者を2人にするだけである。
- **委任の verb は拒否文で session を続ける**(ADR 0424 決定4 と同じ理由) —— 決定4 で session を続けてよいのは、agent の Quarantine が
  その場で人間に届くからである。registry の場合はその場では何も届かず、session が続く間、worker は分割できないまま仕事を進める。
- **registry の型だけを verb ごとに回収に替える** —— 同じ判定の写しが増え、次に足される verb でまた漏れる。

## 派生

- Status 追記: ADR 0403 決定5、ADR 0424 決定2・3・4。
- 委任の verb が verb の時点で agent の Quarantine を登録する経路(ADR 0224)は、決定1 と同じ線を当てるかを #4018 で問う。
- 後始末が registry の止まりに重ねて落ちた後始末を立てる件は #4017。
