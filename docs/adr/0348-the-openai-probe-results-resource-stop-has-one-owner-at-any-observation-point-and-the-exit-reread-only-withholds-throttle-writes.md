# openai の probe の結果から資源の停止を導く持ち主は観測点に依らず1つで、exit の読み直しが控えるのは Throttle への書き込みだけ

2026-11-02 の grilling(issue #2776、根は #2792)で決定。Codex worker が0ターンで 401 に当たると、盤面は Provider 認証の停止を登録せず
ADR 0145 の failure question(推奨 `retry`)を立て、retry は同じ 401 を踏んでいた。Claude 側は #2742 で ADR 0331 決定4 の経路を持つが、
Codex の 401 の構造化された印は exit 時の app-server probe の `unauthorized` だけで(文言は読まない、ADR 0261 決定1)、exit の読み直しは
cap の軸しか読まず `unauthorized` を「読めなかった」に畳んでいた。同じ probe の結果を資源の帰結に写す読み手は4面(pickup の gate、
Provider 認証の解除の受理、表の行の解除の受理、exit の読み直し)あり、登録する面が2、拒む面が1、捨てる面が1 —— 読みの口は ADR 0331
決定5 で1つになったが、結果から帰結を導く持ち主が無かった。exit で cap だけを読むのは ADR 0261 決定4・6 の決定で、決定6 後段「認証切れの
Quarantine は次の pickup の観測が立てる」は ADR 0331 決定1(観測点に依らず資源に帰属)が引用なしに置き換えていた。sweep が提案した
「exit の分類に 401 の署名を1つ足す」は4面目の手書きの写しを増やす。読み手の数と `file:line` は #2792 のコメントに置く。

## 決定

1. **openai の probe の結果から資源の停止を導く値の関数は1つで、観測点に依らない。** 今ある帰結は `unauthorized` → Provider 認証の停止
   (理由は probe の観測値)。4面はこの1つを呼ぶ。登録の行為は観測点ごとのまま —— pickup と解除の受理は直接、exit は束の `writes` の step
   (ADR 0338 決定4 / ADR 0342 決定6)。ADR 0261 決定4「読み直しは分類にだけ使う」は「Throttle には書かない」に狭まり(再開は次の pickup の
   観測、ADR 0104 決定3 のまま)、決定6 後段は ADR 0331 決定1 に置き換わっていたことをここで明記する。
2. **表の行・Interview の対象の照合(ADR 0184 決定3 / ADR 0218 決定2)は pickup の観測に残し、exit の読み直しでは走らせない。** exit の
   書き込みはその session の後始末の runner の step なので、無関係な行の登録の throw がこの task の落ちた後始末になる。行の Quarantine は
   盤面の決定の枝で adapter の束には載らない(ADR 0338 決定4)。反転条件: 途中で一覧から消えた行が次の pickup まで表に残る実害の観測。
3. **exit 時の probe の構造化 `unauthorized` は Codex の 401 の資源の署名である**(ADR 0331 決定3 に加える)。決定3 の列挙は既に cap(probe
   由来)を持つので「transcript の行か exit の事実」の括弧は Codex では元から不正確で、その根拠「起動時の復旧が同じ読み手で読める」は
   同 ADR 帰結「復旧は分類を撃ち直さない」で効いていない。理由は `worker_exited.usage_recheck.reason` に残り、新しい値は足さない。
4. **非同期の出所の事実は1つの解決で束に載る。** Codex の分類の Promise は真偽値ではなく probe から分かる事実(上限到達・停止)で解決し、
   盤面は解決した停止を読む(ADR 0338 決定1 の「出所ごとに束へ」)。同じ結果で `unauthorized` と満杯は排他なので、ADR 0338 決定2 の順は
   ここでは型のためにある。同期の停止(MCP の起動時 exit)と重なる形は未実測で、adapter が1つに畳む(Claude の 401 / init と同じ shortcut)。

## 退けた案

- **exit の読み直しの中で 401 を分類して束に足す**(sweep の形)—— 4面目の写し。次の帰結(行の照合など)でも同じ追記が要る。
- **束の `stop` の欄も Promise にする** —— 待つ Promise が2本になり、揃う時点が2つに割れる。
- **exit でも表の行を照合する** —— 決定2。

## 帰結

- Status 追記: ADR 0331 決定3、ADR 0261 決定4・6、ADR 0338 決定1。GLOSSARY「Quarantine」の署名の列挙と帰結の持ち主の文。
- 実装は1 slice、仕様は #2792 のコメント。#2776 はその 401 の member。範囲は観測した形(`turn.failed` + exit 1 + probe `unauthorized`、
  codex-cli 0.163.0)だけで、`turn.failed` 無しの exit は ADR 0145 のまま。
