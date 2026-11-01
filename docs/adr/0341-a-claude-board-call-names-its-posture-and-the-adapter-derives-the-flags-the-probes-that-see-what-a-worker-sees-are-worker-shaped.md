# Claude の Board call は姿勢を名指し、フラグは adapter が導く —— worker が見るものを観測する probe は worker の形で撃つ

2026-11-01 の grilling(issue #2809、#2798 のレビューの派生)で決定。workspace を cwd にする skill 列挙の ping は tier フラグも
`--strict-mcp-config` も運ばず、workspace が commit した `.mcp.json` の MCP server をホスト上・sandbox の外・盤面の権限で起動していた
(固定版 2.1.286 の実測は #2809 のコメント)。#2798 が `*` の agent にもこの ping を撃たせたので、露出は `[]` 以外の allowlist の
pickup 全部に広がった。根は2フラグの書き忘れではない —— Board call の口(ADR 0136)は容器・上限・回収・env の完全形を契約に持つが、
**CLI が設定のどの層を読み何を起動するか(姿勢)**を契約に持たず、Claude の `/usage` ping 3本と MCP 到達性 probe が各自の `args` に
手で書いていた。答えを取りに行く側の姿勢は runner の1定数が持つ(ADR 0303)のに、probe 側の姿勢には持ち主が無かった。

## 決定

1. **Claude の Board call の spec は姿勢を1欄、必須で名指す。** 値は `answer`(`--safe-mode --setting-sources ""`、ADR 0303 決定1)、
   `worker-shaped`(`--setting-sources project` + `--strict-mcp-config`)、`ambient`(`--safe-mode` だけ —— 認証・使用量のようにホストの
   CLI 自身の状態を観測する probe。GLOSSARY が人間側の設定の入口を呼ぶ語)。任意の欄にはしない —— 書き忘れが今と同じ形で残る。
2. **姿勢 → フラグの写像は Claude の adapter 側(runner の module)に置き、Claude の spec を組む入口を1つにする。** 口は harness を
   知らないままで、フラグを組まない(ADR 0005 の線)。入口の置き場所は #2472 が問う移設先と同じ。
3. **`worker-shaped` は設定の層を選ぶフラグだけ。** inline `--settings`(ADR 0156 / 0303 の4鍵)・`--permission-mode`・`--mcp-config` は
   「その probe が測るもの」として呼び出し側に残る —— 実測(#2809 の D 行)が覆うのは tier + strict の形で、skill の ping に `--settings`
   を足す形は測っておらず、MCP 到達性 probe は `--settings` を2つ運ぶことになる。
4. **skill 列挙(workspace cwd・neutral cwd)・ツール面 probe・MCP 到達性 probe は `worker-shaped`。** ADR 0335 決定4(workspace cwd の
   ping は flag 無し)の反転。決定4 の理由「余分に deny しても害が無い」は skill の名前の集合についての理由で、process が何を起動するか
   の決定ではなかった。worker の tier で撃つことで列挙は初めて「worker が見る集合」に等しくなる。neutral cwd の ping は WebUI の
   skills picker も読むので、strict はホストの user 層の MCP server が設定画面を開くたびに立つのも止める(ツール面 probe の実測からの
   推論、この ping では未測)。
5. **ADR 0136 決定5 の門(workspace cwd の呼び出しは回収済み観測のあとに返す)は残す。** strict が閉じたのは宣言で、容器が床である
   (ADR 0033 の姿勢)。費用は無い —— launch は既に ping の結果を待つ。
6. **適合試験(ADR 0186 決定7)に1面足す: cwd に `.mcp.json` を置き、strict 無しで server が `mcp_servers` に載ること(対照)と、
   `worker-shaped` で空になること。** 床が依る vendor 挙動は版上げの門で測り、pickup ごとには観測しない。

## 退けた形

- **姿勢の定数を1つ置いて呼び出し側が spread する** —— 持ち主が呼び出し側に残り、次の probe で同じ書き忘れが起きる。
- **`.mcp.json` を settings と同じく sparse 除外・quarantine の契機にする** —— ADR 0108 の MCP 軸は床でなく宣言 + 観測。宣言(strict)が
  worker と ping の両方に揃えば、残る欠けは観測の半分(決定6)。
- **workspace ping の init 行の `mcp_servers` を pickup ごとに読む** —— 読む時点で server は起動済みで露出を防がない。版 pin の間の回帰は
  版の門が覆う。
- **`ambient` を `answer` に畳む** —— 認証 probe が user 層の何を読んで認証しているかを測っていない(派生 issue が測る)。
- **`host` という値名** —— GLOSSARY の `@host`(ハーネス同梱)と逆の意味で隣り合う。

## 派生

Codex の probe で trusted な workspace の `.codex/config.toml` の MCP server が立つかの実測、認証 probe と worker の設定の層のずれの
実測、#2472(env を spread でなく組み立てる問いを足す)。
