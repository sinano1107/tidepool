# PWA + Push 通知セットアップ(issue #14)

tidepool を tailnet 経由の HTTPS で配信し、iPhone のホーム画面にインストールして
Web Push を受け取れるようにするための手順。コード側で自動化できない、ユーザー自身の
アカウント操作・端末操作が必要な部分。

## 1. VAPID 鍵を生成し、環境変数に設定する

```
npx web-push generate-vapid-keys
```

出力される public/private キーを tidepool の起動環境に設定する(3つ揃って初めて
`main.ts` が push を有効化する — 1つでも欠けると push は無効のまま):

```
export TIDEPOOL_VAPID_PUBLIC_KEY="..."
export TIDEPOOL_VAPID_PRIVATE_KEY="..."
export TIDEPOOL_VAPID_SUBJECT="mailto:you@example.com"
```

## 2. Tailscale の HTTPS 証明書を有効化する

まだなら、[Tailscale admin console](https://login.tailscale.com/admin/dns) の
DNS 設定で "HTTPS Certificates" を有効化する。tailnet 全体で1回だけでよい。

## 3. `tailscale serve` で配信する

tidepool のポート(既定 4589、`PORT` 環境変数で変更可)を tailnet に公開する:

```
tailscale serve --bg 4589
```

確認:

```
tailscale serve status
```

`https://<このマシンの tailnet ホスト名>.<tailnet 名>.ts.net/` でアクセスできる。
公開インターネットへは一切露出しない(`tailscale funnel` は使わない)— tailnet
所属そのものが認証になる(n=1 前提)。

### 既知のギャップ: `/mcp` も同じポートに乗っている

`tailscale serve` は指定したポートの Express アプリ全体(静的ファイル・`/api`・
`/mcp`)をまとめて tailnet に公開する。tidepool の worker は常に
`http://127.0.0.1:<port>/mcp` で自分自身に接続するため、tailnet 経由で `/mcp` に
届く価値のあるトラフィックは本来存在しないが、現状のアーキテクチャ(1つの
Express アプリ・1つのポート)では `/api` だけを選んで公開し `/mcp` を除外する
手段が `tailscale serve` にはない。

実害は tailnet に参加している他デバイス(この tailnet ではこのマシン自身の他に
iPhone/Windows/Raspberry Pi)から `/mcp` の MCP ツールを直接叩けてしまうこと。
tailnet 参加自体を信頼境界とする n=1 設計の範囲内ではあるが、issue #14 の受け入れ
基準(「MCP エンドポイントが tailnet に露出していない」)を厳密には満たさない。

正しい直し方は `/mcp` を `127.0.0.1` オンリーの別ポートへ分離し、`tailscale serve`
が触れるポートを web/`/api`/静的ファイルだけにすることだが、これは
`server.ts`・`main.ts`・大半の MCP 系テスト(`tests/mcp-*.test.ts` 他、`baseUrl` に
`/mcp` をぶら下げている全テスト)に及ぶ変更になるため、この issue のセッションでは
着手していない。ロールアウト前に別 issue として切り出すことを推奨する。

## 4. iPhone のホーム画面にインストールする(Web Push の必須手順)

Web Push は「ホーム画面に追加した PWA」からのみ利用できる — Safari のタブとして
開いているだけでは通知の許可自体が求められない。

1. iPhone の Safari で `https://<tailnet ホスト名>.<tailnet 名>.ts.net/` を開く
2. 共有ボタン(□に↑) → 「ホーム画面に追加」
3. ホーム画面のアイコンから起動する(これで `display: standalone` の PWA として動く)
4. アプリ内の「通知を有効にする」バナーをタップし、通知の許可を許可する

## 5. quiet hours を設定する(任意、既定 23:00–07:00)

```
curl -X POST https://<tailnet ホスト名>.<tailnet 名>.ts.net/api/settings/quiet-hours \
  -H 'content-type: application/json' \
  -d '{"start": "23:00", "end": "07:00"}'
```
