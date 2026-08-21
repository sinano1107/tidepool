# 盤面の GitHub 身元は単一の GitHub App で、仲介が repo 単位の installation token を発行する

issue #392 のグリリング(2026-08-21、#364 の続き)で決定。友人テスト(#367)では各自の Mac の盤面が各自の
repo に触るが、現行の身元は machine user `tidepool-bot` の classic PAT(ADR 0024 / 0067)で、アカウント全体に
効くうえ人数分を用意できない。issue 本文の「ユーザーごとの App(manifest flow)」は 2026-08-20 のコメントで
退け、**単一 App `tidepool` + token 仲介サービス**(同コメントの B1)を前提に、仲介の置き場・認可・ログイン・
更新・移行を決めた。

## 決定

1. **仲介は Cloudflare Worker。** コードは tidepool repo 内 `broker/`、秘密鍵と client secret は Worker secret、
   deploy は起案者の手動 `wrangler deploy`(盤面の release と結合しない)。Pi + Funnel に置くと Pi の再起動・
   停電が全テスターの盤面を quarantine に落とし、起案者不在時に誰も直せない — 障害の半径で選んだ。
2. **仲介の API は1本** — `POST /token { repo }` + user token。仲介は (a) check-token
   (`POST /applications/{client_id}/token`)で**自分の App が発行した** user token であることと user を確定し、
   (b) user token で `GET /repos/{owner}/{repo}` の `permissions.push` を確認し、(c) その repo だけに
   `repositories` を絞った installation token を返す。ADR 0067 決定3「見えるかではなく書けるか」をそのまま
   仲介の門にする — installation 単位で返すと、他人の repo に read collaborator として入っている人の盤面が
   その repo に書ける token を得る。installation 一覧や App 情報の動詞は持たない(repo を知っているのは盤面)。
3. **盤面のログインは GitHub device flow で、user token は失効しない設定にする**(App の「Expire user
   authorization tokens」をオプトアウト)。既定の 8 時間 + refresh 6 か月は、refresh の面倒と「6 か月後に
   黙って切れる」(ADR 0070 が無人ホストで嫌った形)を持ち込む。失効は revoke で起き、盤面は fail-closed に
   落ちるだけ。
4. **user token の置き場は今日の `TIDEPOOL_GITHUB_TOKEN_FILE` と同じ形** — mode 600 ファイル、env にはパス
   だけ。ADR 0090 決定3 の「#392 のログイン情報も `~/.tidepool/env` に同居する」は**パスが同居する**と読む:
   値を env に置くと worker が継承し(ADR 0070 実測: `GITHUB_TOKEN` 系は素通し)、ADR 0024 の「worker は
   GitHub credential ゼロ」が崩れる。`loadGitHubAuth` の fail-closed(不在・600 以外・空)はそのまま効く。
5. **ログインは boot 前の CLI 一発コマンド**(`seed` と同型、ADR 0089)。端末にコードと URL を出し、承認を
   ポーリングして 600 ファイルに書く。WebUI settings は「ログイン済み / 未ログイン」の読み取り表示だけで、
   人間面に credential を書く扉は増やさない(ADR 0088 の線)。再ログインも同じコマンドで、ファイルは呼び出し
   ごとに読むので盤面の再起動は要らない。
6. **installation token の更新は残余駆動** — 呼び出しの瞬間に期限まで 5 分を切っていれば再取得。タイマーも
   新しい状態も無く、repo → (token, 期限) のキャッシュだけ(ADR 0067 決定2「ループは作らない」)。
7. **仲介到達失敗と user token 失効は既存の資源に落とす。** registry の fetch が先に落ちるので registry
   reachability の盤面全体 quarantine(ADR 0052)がそのまま受け、確認 question の文面に再ログインのコマンドを
   載せる。CLI 認証(ADR 0077)と同格の新資源「GitHub 認証」は立てない。
8. **ADR 0067 の修復経路は「App を repo に install する」に置き換わる。** 招待受諾(`user/repository_invitations`)と
   `gh api user` は installation token では動かないので消える。案内は `https://github.com/apps/<slug>/installations/new`
   の一行(他人の repo なら admin に渡す)。probe は `viewerPermission` ではなく**仲介が token を出せたか**
   (決定2 の push 検査を含む)。App の権限は固定なので「read で受諾できてしまう」穴(ADR 0067 実測4)は構造的
   に消える。ADR 0067 決定4「名前は観測で名乗る」は、リンクが App slug から導出されずれれば**リンク自体が 404**
   になる(症状が近い)ことで保たれる。registry repo の branch protection bypass は machine user から App に
   差し替え、**bypass は registry repo 以外に広げない** — bypass を持つ repo では、push を持つ user が自分の盤面
   経由で bypass 付きの書き込みを得る。
9. **盤面の git author email は App の bot noreply**(`<bot-user-id>+tidepool[bot]@users.noreply.github.com`)。
   ADR 0024 決定4「アカウントが盤面を表す」のアカウントが App に変わる帰結で、別名義を残す理由が無い。
10. **Pi も同じ形に移行し、`tidepool-bot` は休眠で残す。** PAT は破棄するが、アカウントを削除するとログイン名が
    再取得可能になり、過去コミット・PR の参照を他人が名乗れる。
11. **App の権限セットは「今日の盤面が撃つ操作の集合」だけ。** 権限の追加は全 installer の再承認を要するので
    余分に持たせない。具体の列挙は issue #392 側の表が持つ。
12. **仲介のレート制限は入れない。** 発行には有効な user token が要るので匿名の叩き放題にはならず、GitHub 側の
    App レート制限が天井。痛みが観測されたら足す。

## 受け入れた残余リスク

秘密鍵の集中(Worker secret が漏れれば全 installation の token を発行できる — B1 を選んだ時点の「1か所」、
対処は鍵の再生成)、device code phishing(他人が送ったコードを承認すると相手の盤面が自分の名義を得る —
テスターの規模では自分の端末のコードだけ入力する、で足りる)、失効しない user token の盗難(今日の PAT と
同じ形で、到達範囲は狭くなっている)。

## Considered options

- **Pi + Tailscale Funnel に仲介を置く** — 新インフラゼロ、context-vault と同じ型。退けたのは障害の半径(決定1)。
- **installation 単位の token** — 実装は最小。退けたのは read collaborator の盤面が書ける token を得るため(決定2)。
- **`GET /user` で user token を検証** — 誰かは分かるが発行元が分からず、他 App の token を持ち込める(決定2)。
- **既定の 8 時間 + refresh** — 盗難時の窓は狭い。退けたのは refresh 機構と 6 か月後の無音の失効(決定3)。
- **WebUI settings に device flow の UI** — 端末を離れずに済む。退けたのは credential を書く扉が人間面に増えるため(決定5)。
- **固定周期のタイマーで先回り更新** — 期限切れ直前の呼び出しが無い。退けたのは新しいループを作るため(決定6)。
- **「GitHub 認証」を新しい quarantine 資源にする** — 原因を名指しできる。退けたのは既存の経路が同じ場所で捕まえ、
  足りないのは案内文だけだから(決定7)。
- **author email を据え置く** — 変更ゼロ。退けたのは machine user の noreply が App の名義と結びつかないため(決定9)。
- **`tidepool-bot` を削除する** — 片付く。退けたのは名前の再取得(決定10)。
