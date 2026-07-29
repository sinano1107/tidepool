# 人間面の credential — 発行・bootstrap・ローテーション

人間面(WebUI の静的資産・`/api`・そこに mount される管理MCP)は単一の盤面秘密で守られる。
設計とその理由は **ADR 0036**、実装スライスは **issue #153**。ここは運用側の手順だけを書く。

**Worker MCP(別ポート)は守らない。** あちらのアクセス制御は `?task=` + slot + サーバー側の
authority 解決のままで、credential を掛けると全 worker が死ぬ。

## 盤面が持つもの

盤面が持つのは **token のハッシュだけ**(既定 `~/.tidepool/api-token`、mode 600)。平文は
発行の瞬間に一度表示されるだけで、盤面にもディスクにも残らない — したがって「再表示」は
存在せず、失くしたらローテーションする。理由は #151(work プロファイルの worker は `Read`
ツールで cwd 外の任意パスを読めるため、平文はどこに置いても読まれる)。

平文は **`process.env` にも載せない**。`src/claude-worker.ts` の spawn は `{ ...process.env }` を
worker に渡すので、env に置いた時点で worker の手に渡る。

## 設定(環境変数)

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `TIDEPOOL_API_TOKEN_FILE` | `~/.tidepool/api-token` | ハッシュの置き場所。**盤面ディレクトリには置かない**(#149: デプロイの rsync や git 管理下に紛れ込む) |
| `TIDEPOOL_PUBLIC_ORIGINS` | (なし) | この盤面が公開されているオリジン。カンマ区切り。loopback (`http://127.0.0.1:$PORT`) は常に自動で含まれる |

cookie はオリジン単位なので、**盤面は自分の公開 URL を知っている必要がある**(自力では導出
できない)。Pi なら `/etc/default/tidepool` に:

```sh
TIDEPOOL_PUBLIC_ORIGINS=https://raspberrypi.tailc0084f.ts.net:8443
```

これを設定しておくと、`npm run token` が loopback と tailnet の両方ぶんの bootstrap URL を出す。

## 初回起動

ハッシュファイルが無い盤面は起動時に token を発行し、その場で表示する(systemd 下なら
journal に出る)。以後、平文を得る手段はローテーションだけ。

## bootstrap(端末を1台通す)

`…/auth?token=…` を開く → cookie(`HttpOnly` / `SameSite=Lax`、`Secure` なし)が張られて `/` へ 302。

- **オリジンごと・端末ごとに1回**。Pi なら `127.0.0.1:4589` と tailnet オリジンの両方。
- cookie を持たない端末には token 入力欄を持つ 401 ページが出る。インストール済み PWA には
  アドレスバーが無く、URL を開き直せないため、この入力欄が唯一の復旧導線になる。
- 道具(curl / Playwright / 管理MCP)は cookie ではなく `Authorization: Bearer <token>`。

## ローテーション

```sh
npm run token
```

新しい token を発行・表示し、**既存の cookie と bearer をすべて無効にする**。盤面の再起動は
要らない(ハッシュはリクエストごとに読み直される)。

ローテーション後にやり直しが要るもの:

1. 各端末・各オリジンの bootstrap(出力の URL を開く)
2. **管理MCP の再登録** — bearer ヘッダは `~/.claude.json` に保存されているので、
   `claude mcp add --header "Authorization: Bearer <new token>"` を打ち直す。
   `npm run token` の出力にもこの旨が出る。

## 運用制約(#151 が解決するまで)

**worker を走らせるホストでは管理MCP を設定しない。**

管理MCP は bearer で認証するため、その平文は `claude mcp add --header` により `~/.claude.json` に
保存される。盤面側のハッシュ保存が切るのは盤面側の依存だけで、**クライアント側の複製は #151 の
読み取り床に依存する**(work プロファイルの `Read` はパスの床を持たない)。

いまは対話セッションが Mac、worker が Pi で同居していないため潜在的。**Mac に盤面を立てるなら
#151 が先。** この制約は #151 の解決とともに消える(ADR 0036 の該当段落も消える)。

## 認証が成立しない盤面

ハッシュファイルを失った・壊れた盤面は、起動はするが**人間面は全部 401**(ログインページは出る)。
ADR 0036 が書いている「人間面は fail-open」は、pickup ゲートが worker を1枚も走らせないことと
**対**になっている非対称であり、そのゲート側(#154)が入るまで人間面だけを開けると裸の盤面に
なる。復旧は `npm run token`。
