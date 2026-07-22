# Throttle の使用率取得は対話 TUI の `/usage` パネルをスクレイプする — headless の `-p /usage` も非公式 API 直叩きも採らない

ADR 0008 は `claude -p "/usage" --output-format json` の `.result` テキストをパースして session / week の使用率%と reset 時刻を得ていたが、CLI の `/usage` 出力書式が変わり、`-p` 経路は「ローカルセッション集計(リクエスト数・行動別内訳)」だけを返すようになった — %もリセット時刻も含まれず、パーサは常に `{session:null, week:null}` を返し、fail-closed により全 pickup がサイレントに停止した(issue #79)。恒久対応として、使用率の取得を **対話 TUI を PTY 越しに機械操作し `/usage` パネルの描画をスクレイプする**方式に転換する。`claude --safe-mode` を board 自身の cwd で対話起動(実測 約2.7秒・OAuth サブスク認証保持)し、`/usage` を送って `Current session … % used · Resets …` / `Current week (all models) … % used · Resets …` の行を ANSI 除去してパースする。ADR 0008 が定めた設計の骨格 — 閾値(デフォルト80%)判定・reset 一発タイマー・pickup 判断時の just-in-time ポーリング・実行中タスクには触れない・観測不能は fail-closed — は**すべて維持**し、取得機構だけを差し替える。(Status 追記: このうち閾値判定と reset タイマーはのちに ADR-0030 でペース基準判定と catch-up 時刻タイマーへ置き換えられた。スクレイプ機構・just-in-time・fail-closed は現行のまま。)

**認証・トークン管理は CLI が所有し、tidepool は一切触れない。** OAuth トークンの取得・期限判定・リフレッシュ・rotate・`credentials.json`(Linux)/ Keychain(mac)への書き戻しは、対話 CLI の起動時処理がそのまま行う。tidepool は `--safe-mode` 起動という副作用を通じてこれを間接利用するだけで、資格情報ファイルを読み書きしない。これにより自前リフレッシュに伴う refresh-token rotate のレース(共有 `credentials.json` を対話 CLI と競合して片方をログアウトさせる)を構造的に回避する。

**観測不能はすべて fail-closed とし、同時に UI へ可視化する。** spawn 失敗・タイムアウト・プロンプト未到達・認証落ち(API 課金表示で%パネルが出ない)・session/week 行自体が `unavailable` のいずれも throttled=true に倒す(issue #22 / ADR 0008 の踏襲)。ただし #79 の教訓は「fail-closed 自体ではなく、それが完全に不可視だったこと」なので、throttle_state を UI に表示し、run now が pickup できなかった際は偽の成功トーストでなく理由を返すことを本転換の**不可分の一部**とする。人間が完全委任する運用では、持続的 fail-closed(設定ミスの兆候)がサイレントに遊休へ直結するため、可視化は磨き込みでなく安全機構の本体である。

**キャッシュは持たない。** 実負荷の pickup は毎時 tick と稀な run now のみで、レート制限は高頻度アクセス(実験時の自作自演)でしか踏まない。観測不能時に直近スナップショットへフォールバックするキャッシュは、fail-closed=設定ミスの兆候を隠蔽して可視化の目的と矛盾するため採らない。run now 連打による自作自演レート制限が実際に観測されたら、その時に最小ガードを足す(YAGNI)。

Considered options:

- **`-p /usage` のパーサを新書式に追従させる(最小修正)** — 新書式には上限に対する%もリセット時刻も存在せず(リクエスト数と行動別内訳のみ)、throttle 設計が必要とするデータ自体が headless 経路から消えている。追従先が無い。
- **非公式 API `GET /api/oauth/usage` を直叩きする** — CLI バンドル内に実在し(`fetchUtilization`、`refreshOAuth` 付き)、対話パネルの一次ソースと目される。しかし実際に叩くと**一度も成功せず**常に `rate_limit_error` を返した(CLI が送る `anthropic-beta` 等のヘッダを欠くため、隠れたアクセス条件が必要な疑い)。同一時刻に TUI 経由は session/week を返しており、直叩きだけが全滅する = 経験的に TUI より脆い。動く保証の取れない機構の上に恒久対応を建てることになるため却下。
- **能動リフレッシュ(tidepool がトークンを自前で更新)** — アイドル時も自律だが、共有 `credentials.json` の refresh-token rotate を対話 CLI と競合し、ユーザを対話セッションからログアウトさせるレースを持ち込む。CLI を唯一の書き手にする方針で回避。
- **定期バックグラウンドポーリング + キャッシュ読取** — レート制限回避に一見有効だが、実負荷が毎時1回である以上 just-in-time でも制限に近づかず、背景ポーラのライフサイクル管理と staleness ノブだけが増える。ADR 0008 の just-in-time を覆す理由が無い。

Consequences:

- 取得コストが `-p` の約663msから対話起動の約2.7秒へ増えるが、毎時周期に対しては誤差。
- **PTY 駆動の脆さ**を抱える: TUI 描画が変われば再び壊れうる(#79 と同種)。これは fail-closed の可視化で「サイレント全停止」でなく「UI に観測不能と出て気づける」状態に緩和する。
- **Pi デプロイに trust の一度きりの seed が必要**: 対話(TTY)起動は workspace trust ダイアログを要求しうる。現行 `-p`(non-TTY)は trust を要求しないまま通っていたため、デプロイ先ディレクトリが trusted である保証は無い。deploy-pi 手順にワンタイムの trust seed を追加する。
- session の reset は日付を持たず(`Resets 1:30pm`)、week は日付を持つ(`Resets Jul 23 at 1pm`)。パーサは「日付なし=直近未来の同時刻」への丸めを既存の no-year 丸めの延長として扱う。
