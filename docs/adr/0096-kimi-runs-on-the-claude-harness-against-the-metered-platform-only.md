# Kimi は Claude harness + Moonshot Platform 従量課金のみ —— サブスク経路とネイティブアダプタを退ける

2026-08-23 の grilling(Kimi Code CLI 対応の検討)で決定。無人の worker session を Kimi の推論で動かしたいという要求に対し、規約と実装コストの両面から経路を絞った。

**規約上、使えるのは Moonshot Open Platform の従量課金だけである。** Kimi Code の Community Guidelines は「Kimi Code subscriptions are for personal interactive use only」「Don't use Kimi Code for non-interactive automation — scripted batch execution は通常利用の範囲外」と明記し、違反時の suspension まで定めている。tidepool の無人 worker はこの非対話型利用そのものであり、membership quota に繋がる経路 —— `/login` の OAuth 資格情報と Kimi Code Console 発行の API キー(全 API キーは quota 共有)—— はどちらも使えない。ガイドライン自身が platform 用途を Kimi Platform へ誘導しており、従量課金の `api.moonshot.ai` が唯一の適法経路。Kimi 公式ドキュメントが「サードパーティツールから API キーで使える」と明記しているのは人間が駆動する対話ツールの話であり、無人化の許可ではない —— この読み違いで一時「規約上は曖昧」と判断しかけたが、ガイドライン本文が決着させた。

**ハーネスは Claude Code のまま、向き先だけを変える。** Moonshot Platform は Anthropic Messages 互換エンドポイント(`https://api.moonshot.ai/anthropic`)と Claude Code からの接続ガイドを公式提供しており、worker spawn の env(`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL` 系)を差し替えるだけで既存の ClaudeCodeWorker が再利用できる。互換性調査の結果、permission mode・`--settings` サンドボックス・`--mcp-config`・`--append-system-prompt`・stream-json 出力とエラー封筒はすべて CLI ローカルの機構であり、向き先を変えても壊れないことが確認できた。規約要件を満たす経路として両者は等価なので、差分が env とモデル名だけの側を取る。

**スコープは worker session のみ。** board call(AI 下書き・翻訳・probe)は Anthropic のままに固定する。ただし本経路では「board call を Kimi に向ける」ことも env 違いで済むため、後から安く拡張できる。

**使用量スロットル(ADR 0028)は Kimi provider の対象外とする。** `/usage` パネルはサブスク % 前提であり従量課金には存在しないが、Platform はプリペイド残高制で残高そのものが天然の支出キャップになる —— 「暴走で破産しない」という ADR 0028 の精神は課金構造が担保する。残高 API(`GET /v1/users/me/balance`)の存在は確認済みで、閾値 quarantine は後から安く積める。

## Considered options

- **サブスク OAuth(`/login`)で Kimi CLI を動かす** —— Community Guidelines の非対話型利用禁止に正面から抵触。違反時はアクセス停止。
- **Console 発行 API キー + Claude Code(`api.kimi.com/coding` 向き)** —— 公式ガイドがあるが、その API キーは membership quota 共有であり、同じガイドラインの禁止に落ちる。「公式がツール利用を明認している」は無人化の許可ではない。
- **Kimi CLI ネイティブアダプタ(`kimi -p --output-format stream-json`)** —— 規約上の優位はゼロ(同じ Platform キー課金に行き着く)のに、stream-json スキーマ差分・per-spawn MCP 設定・advisor 相当・認証プローブのギャップ分析から始まる大物。Kimi harness 固有の機能が欲しいという別の動機が出たときだけ再検討する。
- **ACP(`kimi acp`)** —— tidepool の stream-json パース基盤を捨てることになり、割に合わない。

## Consequences

- **advisor は Kimi 向き先では使えない。** advisor は Anthropic のサーバーサイドツール(wire 上 `server_tool_use`)であり、Moonshot が実装した記録はない。組み合わせの扱いは ADR 0097 が「不正な定義」と定める。
- **WebFetch は使えない**(Moonshot 公式 FAQ 明記)。他に thinking 必須モデル(off で 400)・ツールスキーマ厳格検証・experimental beta ヘッダ拒否(`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`)等の癖があるが、v1 では個別対応しない —— 呼ばれた場合の失敗は worker に可視であり、既定拒否のツール面(ADR 0039)は無傷。
- **effort マッピング(Claude 5 段階 → Kimi 3 段階)と認証優先順位は実測待ち。** `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` が必要な可能性がある。実キーでの検証は実装タスクの受け入れ条件に含める。
- **初回起動にはオンボーディング skip(`hasCompletedOnboarding`)と trust seed(#442)が必要** —— これは Claude 経路と同じゲートであり、新しいつまずきではない。
