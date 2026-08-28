# 上限到達による worker の中断は失敗ではなく環境事象 —— ADR 0007 を実測の形の上で復活させる

issue #467 のグリリング(2026-08-28)で決定。前身は #23(「実429死の判別は exit 形を観測してから」)。

ADR 0008 は ADR 0007(使用量リミットによる mid-run 中断は failure question を経ず、`todo` 先頭へ戻して
リセット後に自動再開する)を supersede した。理由は2つ — throttle が実行中タスクに触れなくなったので
中断という事象そのものが消えたこと、そして limit 超過時の exit 形が未検証で、推測の形に実装を建てられ
ないこと(#10 の教訓)。前者は今も正しいが、中断は throttle ではなく **Provider の側から**起きる: 観測から
完走までの間に窓が満杯になれば(Spend-down 中や上限近傍の spawn)、CLI は 429 で exit する。後者は
#447 のライブ検証(2026-08-24)で解消した — exit は `result` envelope に `api_error_status: 429` を運ぶ
構造化された形で、401 の判定と同じ場所に乗る。実測の詳細は #467 にある。

盤面の現状では自己申告のない exit は watchdog(絶対時間リミット)待ちであり、429 は task を
`in_progress` のまま 90 分 slot に握らせる。再起動で failure question が立ち、人間が押すのは決まりきった
retry である — ADR 0007 が退けた toil がそのまま再現された。

## 決定

1. **429 exit は「上限到達による中断」という環境事象であり、失敗ではない。** 回収済み観測(ADR 0099)
   → slot-release tree rule → task を `todo` 先頭へ → slot 解放。failure question は立てず、失敗統計も
   汚さない。ADR 0007 の理路(retry 一択の問いに判断価値はない)をそのまま引き継ぐ。
2. **確定証拠は `result` envelope の `api_error_status === 429` だけ。** 401 の判定(ADR 0070)と同じく
   エラーメッセージの部分文字列から推測しない。stream 中の `rate_limit_event` は判定の根拠にしない —
   出現は確認できたが、枯渇時の意味論は1観測しかない。
3. **再開の門は既存の Throttle である。** `todo` 先頭に戻った行は次の pickup で JIT の使用量観測に
   かかり、100% キャップまたはペース線で skip され、catch-up 時刻に再開する。429 の観測を exit 側から
   throttle の状態へ書き込むことはしない(ADR 0008「使用量は pickup 判断の瞬間だけ」を維持)。観測が
   古くて spawn → 429 → `todo` を繰り返す空回りは、1回 0 トークン・poll 周期で有界であり、痛みが観測
   されてから `resetsAt` を繋ぐ(そのとき #454 の Provider 単位の形が決まっている)。
4. **中断の事実は盤面名義の event として task の timeline に刻む。** 次のセッションが Precedent 経由で
   「なぜ途中で終わったか」を stderr から推測しなくて済むように。「restart interrupted task」が history
   に理由を残すのと対称。
5. **範囲は Claude Code adapter のみ。** Claude CLI を喋る他 Provider(moonshot 等)は envelope が同じ
   なので、401 と同じく spawn 時の provider に帰属させる。Codex の 429 の形は未観測なので建てない —
   ADR 0008 の線をそのまま守る。途中ターン(WIP あり)の 429 は turn 1 と区別しない: 判定は envelope
   一点で turn 数に依存せず、WIP は tree rule が退避する。
6. **専用の可視化は足さない。** `todo` に戻れば queue に throttle の `skipped` として現れ、timeline には
   決定4 の event が載る。それ以上は痛みが出てから(ADR 0102 の線)。

ADR 0007 の Status は「ADR 0104 で復活」に、ADR 0008 の「別スライスで扱う」の先送りは本 ADR で回収。

## Considered options

- **failure question 経由のまま(現状 + 早期検出だけ)** — 429 exit を即 `failTask` に繋げば 90 分の
  放置は消えるが、人間が押すのは常に retry。ADR 0007 が退けた toil を早く届けるだけ。
- **exit 側から throttle 状態へ `resetsAt` を書く** — 観測としては fresh で正しいが、#454 の Provider
  単位スキーマと結合し、ADR 0008 の教義に exit 起点の書き込み経路を1本足す。空回りが観測されるまで
  待っても失うものは 0 トークンの再 spawn だけ。
- **`rate_limit_event.status === "rejected"` を判定に使う** — `resetsAt` と窓種別が構造化されて付く
  点は魅力だが、枯渇時の出現と意味論は1観測しかなく、判定の根拠に足りない。決定3 の再検討時に評価する。
- **自己申告なしの exit 全般を分類する** — 429 以外(エージェントが動詞を呼ばずに終わる等)は本当に
  詰まったのか判断が要り、watchdog → failure question が正しい受け皿。429 は原因を盤面が確定的に知る
  唯一のケースなので、そこだけを切り出す。
