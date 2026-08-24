# Provider は1つの正準 Harness を選び、Codex の experimental probe は固定と適合試験で閉じ込める

2026-08-24 の grilling(issue #195)で決定。Kimi 対応で Provider と Harness を分離した ADR 0097 は、すべての worker を Claude Code で起動する実装の上に第2の推論提供元を載せた。OpenAI / Codex を加えるには Provider と Harness の組み合わせ、サブスクリプション認証、使用量観測、安全床、停止範囲を明示しなければならない。

## 決定

1. **agent registry は引き続き必須の Provider だけを宣言し、盤面が Provider ごとに1つの正準 Harness を導出する。** v1 の写像は `anthropic → claude-code`、`moonshot → claude-code`、`openai → codex`。agent に `harness` フィールドを足さず、実行可能な別の組み合わせが増えても正準経路は黙って変えない。障害時の別 Harness への自動 fallback も行わない。実際に使った Harness と CLI version は spawn の歴史的事実として worker session に記録する。
2. **advisor などの任意能力は Provider 単体ではなく正準経路が提供する能力とする。** agent が経路に無い能力を要求した定義は registry 登録と pickup の両方で拒否し、黙って無効化しない。これは ADR 0097 決定3の「provider が提供する能力」を、Provider / Harness の経路へ精密化する。v1 の OpenAI / Codex 経路は advisor を提供しない。
3. **OpenAI / Codex の v1 はローカル worker session だけで、ChatGPT サブスクリプション認証のみを使う。** worker は `codex exec --json` で起動し、`--ignore-user-config`・`--ignore-rules`・`--ephemeral`と盤面が固定する sandbox / approval / model / effort / MCP 構成によって ambient な設定を経路から除く。OpenAI の公式文書は `codex exec` をスクリプト・CI 用の非対話モードとして提供し、trusted/private runner では ChatGPT 管理認証を CI/CD で使う形も案内している([Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)、[Authentication](https://learn.chatgpt.com/docs/auth))。したがって Kimi Code サブスクリプション(ADR 0096)と違い、無人 worker をサブスクリプションで動かすこと自体を禁止する条件はない。OpenAI API key への fallback は持たず、API 用資格情報は OpenAI worker の環境から除去する。
4. **Codex の使用量・認証 probe は、同じ Codex CLI が持つ `app-server` の stdio JSON-RPC 面を、互換性非保証の内部アダプターとして使う。** `codex-cli 0.147.0` の通常生成 schema(`codex app-server generate-json-schema`)には `account/rateLimits/read` があり、used percent・reset 時刻・primary / secondary 窓・plan 種別を返す。この method は `experimentalApi` opt-in 対象ではない。一方、OpenAI は App Server command 全体を experimental かつ production workload 非サポートとし、experimental を「不安定で、変更・削除されうるため自己責任で使う」成熟度と定義している([Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Feature Maturity](https://learn.chatgpt.com/docs/feature-maturity))。これは技術的な不成立ではなく、互換性・廃止猶予・production support の不在として扱う。TUI はスクレイプせず WebSocket transport も使わない。worker の `codex exec --json` と probe の `codex app-server` は同じ ChatGPT 認証 cache に帰属する1つの Harness の二面と数える。production host は #195 で検証済みの CLI version を固定し、起動時に必要 method と応答 schema の適合を検査する。version / schema の欠落・変更は OpenAI Provider の観測不能として fail-closed にし、CLI 更新は同じ適合試験を通した意図的な変更に限る。
5. **資格情報の形はホストだけでなく Harness の認証機構でも決まる。** 本人の Mac と無人常駐ホストのどちらでも Codex 自身の login / cache / refresh を使う。Pi では worker / service user として `codex login --device-auth` を行い、Tidepool は別ホストの `auth.json` をコピーせず、token を保管・注入しない。ADR 0090 の setup-token / ambient login の二分は Claude Code 経路の履歴として残り、全 Harness への一般則にはしない。
6. **Throttle・CLI auth・Containment capability は、止められる最も狭い Provider / Harness 資源で止める。** OpenAI の使用量超過・観測不能・認証失効は OpenAI の worker と Board call だけを止め、Codex 固有の sandbox / tool 面の不成立は Codex を正準経路とする agent だけを止める。これは ADR 0097 決定2の「board call が依存する provider なら実質的に盤面全体停止」という例外を撤回する。throttled な Provider の行は `Pickable head` から一時的に外れ、別 Provider の最上位行が流れる。Provider が回復すれば元のキュー順で候補へ戻る。
7. **Codex 経路は Claude 経路と同じ意味の安全床を証明できるまで production path に入れない。** Worker MCP verbs、OS / CLI sandbox、既定拒否の tool / skill 面、subagent からの盤面 verb 禁止、watchdog の kill / process-tree 回収、JSONL の usage / auth / exit 正規化を issue #195 の合否スパイクで実測する。機構は Harness ごとに異なってよいが、1つでも床を機械的に作れなければ OpenAI / Codex 経路は出荷しない。
8. **将来の Board call は用途ごとに Provider を明示し、同じ正準経路を使う。** 盤面全体の暗黙の既定 Provider は置かない。ただし issue #195 とその直後の production 実装は worker session に限る。Codex Cloud、Moonshot → Codex bridge、OpenAI / Codex の Board call は別 work とする。

## Considered options

- **agent に Provider と Harness の両方を書かせる** —— 今日サポートしない組み合わせまで registry の状態空間に持ち込み、agent ごとの選択が必要になった観測事実もない。Provider ごとの正準経路なら Kimi を Codex から使える技術的可能性を否定せず、今日の経路を一意にできる。
- **Provider 単体に能力表を置く** —— Moonshot を Claude Code と Codex のどちらで走らせるかによって tool / advisor / skill 面が変わりうる。能力は向き先だけでは決まらない。
- **OpenAI API keyへfallbackする** —— サブスクリプション枠だけを使うという運用者の決定を、認証障害時に従量課金へ静かに反転させる。
- **`codex exec`単体に使用量面が無ければ対応しない / TUIをスクレイプする** —— 同梱 app-server に構造化された rate-limit 面があり、より弱い観測へ落とす理由がない。ただし upstream が production contract として保証しているとは呼ばない。App Server の experimental 表記は、検証版の固定、起動時の method / schema 適合試験、OpenAI Provider だけの fail-closed、および #195 の実通信スパイクで受け止める。
- **production-supported な quota API が出るまで Codex 経路を出荷しない** —— App Server は既に OpenAI 自身の rich client を支え、必要 method も通常 schema に現れる。単一ホストが版を固定して更新を制御でき、drift の影響も OpenAI Provider に閉じる Tidepool では、成熟度リスクを明記して受容できる。
- **いずれかのサブスクリプションが throttled なら盤面全体を止める** —— 独立した Provider の予算を結合し、「止められるより狭い資源が存在するか」という Quarantine の既存基準に反する。
- **Codex Cloudをv1に含める** —— ローカル checkout・slot・watchdog・tree rule という worker session の境界を共有せず、別の実行モデルである。

## Consequences

- scheduler は候補の Provider を解決してからその Provider の fresh usage を観測し、1 poll 内で throttled な Provider を除外して次の候補を探す。Throttle の保存値・オフセット・表示・再開タイマーも Provider / window 単位になる。
- Containment capability は Harness ごとの結果になり、共有する人間面の自己検査だけが全 Harness の結果へ同じ原因として現れうる。
- OpenAI / Codex 用の adapter は ClaudeCodeWorker の分岐ではなく、正準経路が選ぶ別の worker 実装になる。Board call も将来同じ経路を再利用できるが、今回その呼び出しは追加しない。
- Codex の CLI / schema drift は壊れた応答を推測して通すのではなく、OpenAI Provider の観測不能として可視化される。別 Harness へ逃がさないため、実行経路と課金元の説明可能性が残る。OpenAI が production support しない面を採る以上、CLI 更新ごとの適合維持は Tidepool 自身の責任になる。
