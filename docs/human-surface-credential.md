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

**盤面を初めて起動する前に書くこと。** 初回起動は起動時点の設定で bootstrap URL を印字するので、
未設定のまま起動すると loopback ぶんしか出ず、スマホから入る導線の URL が手元に残らない
(取り戻すにはもう一度 `npm run token` = 発行済み token の破棄が要る)。

## 初回起動

ハッシュ**ファイルが無い**盤面は起動時に token を発行し、その場で表示する(systemd 下なら
journal に出る)。以後、平文を得る手段はローテーションだけ。

ファイルはあるが**中身が使えない**(壊れている・空)場合は**発行し直さない** — 読めないだけかも
しれないファイルを上書きすると、生きている端末の cookie を黙って捨てることになる。盤面は起動して
エラーを出し、人間面は fail-open で開いたまま pickup が止まる(下の「認証が成立しない盤面」)。
復旧は `npm run token`。

### 「無い」と「壊れている」は別の事故である

この2つの分岐の違いは運用上かなり効くので、明示しておく。

| ハッシュファイル | 起動時 | 結果 |
| --- | --- | --- |
| **無い** | 新しい token を発行して印字する(初回起動の経路) | 既存の cookie と bearer が**全部黙って死ぬ** |
| **ある が 中身が使えない** | 発行し直さない。エラーを出して起動 | fail-open + pickup 停止。直せば元の token がそのまま生きる |

つまり **ハッシュファイルの紛失は、次の再起動の瞬間に全端末のログアウトになる**(盤面は
「初回起動だ」と解釈するため)。バックアップを取るなら中身ではなくこのファイルそのもの、
そして紛失に気づいた時点で再起動前に戻すこと。2026-07-30 の本番ドリルで実際に踏んだ:
ファイルを `mv` で退避して再起動したら、fail-open のまま留まらず新しい token が発行された。

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
2. 立っている封じ込めの確認 question への回答(認証が落ちて止まっていた場合)
3. **管理MCP の再登録**(下記)

### 管理MCP の再登録 — 手順はここが正本

管理MCP(ADR 0032 / issue #131)は人間面に相乗りして bearer ヘッダで認証するため、その平文は
`claude mcp add --header` により**クライアント側の** `~/.claude.json` に保存される。したがって
`npm run token` を打つたびに保存済みのヘッダが無効になり、打ち直しが要る。

```sh
# 対話セッションを走らせているホスト(= 盤面のホストとは限らない)で
claude mcp remove tidepool
claude mcp add --transport http tidepool https://raspberrypi.tailc0084f.ts.net:8443/mcp \
  --header "Authorization: Bearer <npm run token が出した新しい token>"
```

**置き場所の判断(issue #154)**: これはデプロイの手順ではなく **credential のライフサイクルの
手順**なので、正本はこの節に置き、deploy-pi 側(`SKILL.md` / `references/first-time-setup.md`)
からは**指すだけで複製しない**。ローテーションはデプロイと独立に起きる(token を失くした、
端末を増やした、単に回した)ため、deploy-pi にコピーを置くと「デプロイのときだけやる作業」に
読み替えられ、しかも2箇所が別々に古くなる。`npm run token` の出力自体にもこの旨が印字される。

打ち直す先は**盤面のホストではなく、対話セッションが走っているホスト**であることに注意
(下記の運用制約の通り、worker を走らせるホストにはそもそも設定しない)。

## 運用制約(#151 が解決するまで)

**worker を走らせるホストでは管理MCP を設定しない。**

管理MCP は bearer で認証するため、その平文は `claude mcp add --header` により `~/.claude.json` に
保存される。盤面側のハッシュ保存が切るのは盤面側の依存だけで、**クライアント側の複製は #151 の
読み取り床に依存する**(work プロファイルの `Read` はパスの床を持たない)。

いまは対話セッションが Mac、worker が Pi で同居していないため潜在的。**Mac に盤面を立てるなら
#151 が先。** この制約は #151 の解決とともに消える(ADR 0036 の該当段落も消える)。

## 認証が成立しない盤面(fail-open と、それを支えるゲート)

ハッシュファイルを失った・壊れた・書けなかった盤面は、起動はするが**人間面が開く**
(無認証で誰でも入れる)。これは事故ではなく ADR 0036 の設計で、**pickup ゲートが worker を
1枚も走らせないこと**と対になっている:

| | 認証が立たないとき |
| --- | --- |
| 人間面 | **fail-open**(開く)— 開いていること自体が「question を読んで直す」復旧経路になる。Pi で起動ごと拒むと ssh するしかなくなる |
| worker の pickup | **fail-closed**(全部止まる)— 封じ込め能力の自己検査が無認証 `GET /api/tasks` に 200 を観測して不成立になる |

この非対称は意図的である。**「揃える」ためにどちらかを反転させてはいけない** — 人間面を閉じれば
PWA から復旧できなくなり、pickup を開ければ裸の人間面の隣で worker が走る。

盤面はこのとき Tidepool 名義の確認 question を1枚立てる(「worker containment is not
established — pickup is stopped」)。実装は `src/containment.ts` / `src/auth.ts`、issue #154。

### 復旧の順序(ここを間違えると詰まる)

1. 盤面で `npm run token`
2. **出力の bootstrap URL を、いま見ている端末で開く** — ローテーションはいま持っている cookie も
   殺すので、これを飛ばすと次の手順に進めない
3. WebUI に立っている確認 question に回答する(盤面は受理の直前に検査を走らせ直すので、
   まだ直っていなければ 409 で拒否され question は開いたまま残る)
4. 他の端末・他のオリジン、そして[管理MCP の再登録](#ローテーション)

### fail-open 中の CSRF

cookie を1枚も使わないので `SameSite=Lax` は何も守っていない。**`/api` の変更系に対する JSON
content-type 要求だけが残った壁**である(クロスオリジン fetch に preflight を強制し CORS で
落ちる)。「認証があるのだから冗長」に見えても畳まないこと — 認証が立っていない盤面こそ、
この検査が単独で立つ盤面である。
