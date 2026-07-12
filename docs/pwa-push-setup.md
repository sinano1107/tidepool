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

`/mcp` はこのポートには乗っていない(issue #37)— `127.0.0.1` オンリーの別ポート
(既定 `PORT + 1`、`MCP_PORT` 環境変数で変更可)で待ち受けており、`tailscale
serve` が公開するポートを上記の1つ(web/`/api`/静的ファイル)だけにする限り、
`/mcp` は tailnet から到達不能。tidepool の worker は常に
`http://127.0.0.1:<mcpPort>/mcp` で自分自身に接続するため、tailnet 経由で `/mcp`
に届く価値のあるトラフィックは元々存在しない。

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
