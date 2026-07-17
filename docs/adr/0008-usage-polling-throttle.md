# Throttle 検知は pickup 時の /usage ポーリングと自前閾値による — 実行中タスクは常に完走する

**Status: 取得機構は ADR-0028 で差し替え済み** — CLI の `/usage` 出力書式変更(issue #79)により `-p /usage` は%もリセット時刻も返さなくなった。取得は対話 TUI のスクレイプへ転換したが、本 ADR が定める設計の骨格(閾値判定・reset 一発タイマー・pickup 時の just-in-time ポーリング・実行中タスクには触れない・観測不能は fail-closed)はそのまま維持される。以下の本文中「`claude -p "/usage" --output-format json` を叩く」の一点のみが古い。

#10 は「真実の源は各実行の stream-json 中の rate limit イベント」という前提で throttle を実装したが、実際に検証した結果この前提は成立しなかった: Anthropic が statusline 機構に渡している `rate_limits` オブジェクト(`five_hour` / `seven_day` の使用率と reset 時刻)は、headless `-p` 実行の stream-json にも `--debug api` の出力にも一切現れない。そこで検知を、scheduler の pickup 判断時に `claude -p "/usage" --output-format json` を叩く just-in-time ポーリングへ転換した(実測: 663ms・$0・モデル呼び出しなし)。session / week(全モデル)のどちらかの使用率が閾値(デフォルト 80%、`TIDEPOOL_USAGE_THRESHOLD` で上書き可)以上なら pickup を skip し、reset 時刻に一発タイマーで再ポーリングする。

このとき2つの前提も同時に覆した。第一に、#10 の「閾値判断は Anthropic 側に乗り、自前推定はしない」を放棄し、自前の閾値を採用した — ポーリングで観測できるのは使用率という連続量だけであり、Anthropic 側の分類イベント(rejected / allowed_warning)はもう届かないため、状態も2つから1つ(throttled)に畳んだ。第二に、throttle は実行中タスクに決して触れない — 閾値は 100% 未満の予防線であり、到達時点で走っているタスクを切る理由がない。これにより mid-run 中断(WIP 退避 → キュー先頭復帰 → 自動再開)という事象自体が消滅し、ADR 0007 が定めた「自動リトライ原則の唯一の例外」も不要になった(pickup の再開はタスクのリトライではない)。

使用率が観測不能なとき(パース失敗など)は fail-closed で skip する: 守るのは不可逆な予算であり、失うのは回復可能なアイドル時間にすぎない。

Considered options:

- **stream-json のイベント/エラーを監視し続ける(#10 の設計)** — 検証の結果、`rate_limits` は stream-json に現れないことが確定。実際に limit を超えた際の exit エラー形も未検証であり、推測の形に実装を建てることになる(まさに #10 が失敗した理由)。
- **statusline 機構経由で `rate_limits` JSON を横取りする** — データは構造化されていて理想的だが、statusline はインタラクティブセッションの装飾機構であり、headless 実行で発火する保証も互換性の約束もない。ハックの上に土台を置くことになる。
- **`/insights` を叩く** — 実モデル呼び出しを伴い $1.75・66秒(実測)。ポーリング用途には論外。
- **定期バックグラウンドポーリング + mid-run 中断の維持** — 実行中タスクを完走させると決めた以上、使用率が意味を持つ瞬間は pickup 判断時しかない。常駐監視は何も追加せず、poll 再入とタイマー重複の管理だけが増える。

Supersedes ADR 0007(mid-run 中断が消滅したため、その扱いを定めた 0007 の対象事象自体が存在しなくなった)。実際に limit を超えて強制終了された場合の判別は、実事象の stream.jsonl 証拠が採れてから別スライスで扱う。
