# Claude の答えを取りに行く Board call は prompt cache を明示的に無効化する

issue #2964 の固定版 Claude CLI 2.1.286 の測定で、5 系の行は1回限りの入力全体を cache に書き、再利用しないと入力定価より高くなることを確認した。
ADR 0062 の Consequences「キャッシュの不在は env で宣言しない」が想定した翻訳バーストの共通プレフィクスの読み戻しは、
ADR 0296 決定4・6 のまとめ撃ちと短い system prompt の形では前提にできない。測定の詳細は #2964 の Agent Brief に置く。

## 決定

1. **Claude の答えを取りに行く Board call は、推論の有無・用途に関わらず `DISABLE_PROMPT_CACHING=1` を宣言する。**
   翻訳も含め、alias の解決先や入力長が変わっても1回限りの書き込みの割増を防ぐ。worker 条件を測らない認証・model 到達性の単発 probe も同じ宣言を使う。
   env の綴りは名前付き定数1つに置き、共通の Board call env の上に重ねた答え用の関数から組む。runner の推論あり・なしと適合試験の Board call 形の1ターンが共有する
   (ADR 0303 決定4)。ADR 0062 の上記 Consequences の方針を置き換える。usage の記録は割増を見せるが防がないため、記録があることは宣言を省く理由にならない。
2. **worker と worker 条件の観測は変えない。** skill 列挙・tool-surface・Worker MCP reachability の probe、適合試験の worker 形の1ターンには宣言を足さない。
   usage TUI はモデルを呼ばず、同じく変えない。翻訳結果の DB cache・まとめ撃ち・推論の閉鎖、cache token を含む usage の記録も保つ。Codex は対象外。

## 退けた案

- **共有の Board call env で無効化する** —— worker 形の観測条件を変え、観測対象と worker がずれる。
- **model 別の無効化 env を使う** —— CLI の既定 id との一致に依存し、表の具体 id を一律に閉じる保証がない。全 model に効く綴りを使う。
- **用途の指示を system prompt に移して再利用を狙う** —— ADR 0296 決定6 の変更と TTL 内の再利用頻度の測定が必要で、本件の範囲外。
