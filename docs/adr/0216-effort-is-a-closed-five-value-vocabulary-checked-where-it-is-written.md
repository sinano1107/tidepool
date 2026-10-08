# effort は閉じた5値の語彙で、書く入口が拒む

2026-10-08 の grilling(issue #1409)で決定。行を書く扉も行の提案も effort を空でない文字列としてしか見ず、走らない値が
本番の行に入って、その行が選ばれた pickup で初めて落ちていた。Claude の adapter は spawn で throw するが、question は行を
名指さず、selector は決定論なので pickup のたびに同じ行で立つ。Codex は CLI が検査せず API が 400 で断る。実測(Codex の
`model/list` と API の 400、Claude CLI の警告)は #1409 のコメントに置く。

## 決定

1. **effort の語彙は `low` / `medium` / `high` / `xhigh` / `max` の1本で、全 provider の行に当てる。** Claude CLI はこの5値を
   閉じた集合として定義し、Codex は隠れていない model がすべてこの5値を広告する(隠れた `gpt-5.5` は `max` を欠く —— 帰結)。
   いまは2つの固定 CLI の定義が一致しているので1本に置き、どちらかの版上げでずれたら provider ごとに分ける。CLI が閉じた
   集合として持つ値の写しなので、ADR 0005 が model について退けた許可一覧(新しい model を拒んで古くなる)とは違う。Codex の
   版上げでは一覧の広告と突き合わせる。
2. **Codex の `ultra` は effort に数えない。** 推論の深さではなく、max に複数 agent への委譲を足したモードである。使うなら
   委譲の軸として別に設計する。API が受ける `none` / `minimal` も、どの model も広告していないので語彙に入れない。
3. **検査は書く入口すべてが同じ述語を呼ぶ** —— 行を書く扉、行の提案を作るとき、approve に添える修正値、Interview の対象を
   登録する扉(#550)。提案を作る時点で拒むので、meta-review は自分の誤りをその場で受け取る。人間の承認で初めて落ちることはない。
4. **値域の正本は書く入口の検査1つで、adapter の spawn 時の検査は消す。** 書く入口がすべて拒めば adapter に届く値は無く、
   届かない検査は正本が2つあるように見せる。種の行は扉を通らずに入るので、種の effort が語彙の中にあることはテストで釘を刺す。

## 帰結

- 5値の中でも model が受けない値は残る(Codex の `gpt-5.5` + `max` は 400、Claude の Haiku 4.5 は黙って捨てる)。model ごとの
  判定は #1525 が扱う。
- 語彙が閉じたので、settings タブの Effort 欄は同じ一覧から作る Select になる。

## 退けた案

- **Codex の `model/list` の `supportedReasoningEfforts` と照合して Quarantine に入れる** —— 一覧は `ultra` のような effort で
  ない値を含み、API が受ける `none` を含まない。model ごとの違いは5値の中では穴が少なく、#1525 で扱う。
- **Codex の値域は API の7値** —— 決定2。
- **扉で縛らず spawn の失敗に任せる** —— 冒頭の現状そのもの。
