# 本人の Mac 上の盤面は ambient な CLI ログインで動き、setup-token は無人ホストの形

issue #364 のグリリング(2026-08-20)で決定。友人テスト(#367)は「各自の Mac に各自の盤面、各自の Claude
契約」であり、Pi の立ち上げ手順(deploy-pi)しか無かった。Mac の手順を1本にするにあたり、ADR 0070 が定めた
`claude setup-token`(`CLAUDE_CODE_OAUTH_TOKEN` を盤面の env に置く)を Mac でも要求するかが問いになった。

## 決定

1. **本人のマシン上の盤面は、その人が普段 `/login` している claude CLI をそのまま動力にする。** setup-token は
   要求せず、任意にもしない(手順に書かない)。ADR 0070 の根拠 — 無人ホストには人間の keychain も対話ログインも
   無く、refresh の失効が黙って起きる — は本人のマシンでは成立しない: 切れれば本人が次に CLI を使った瞬間に
   気づき、`/login` し直せば盤面も戻る。cliAuth の検知(ADR 0077)は `api_error_status: 401` の機械判定で資格
   情報の出どころを見ないので、盤面側の変更は無い。ADR 0070 は改訂ではなく**適用範囲の明示**である:
   setup-token は無人常駐ホスト(Pi)の形、ambient ログインは本人のマシンの形。
2. **Mac の盤面はフォアグラウンドで、`caffeinate -i -s` に包んで起動する。** launchd は用意しない。朝の triage は
   盤面が夜に走ることを含意するが、Mac はスリープするので launchd があっても解かれない — それは友人テストで
   観測されるべき痛みで、先回りしない。`caffeinate` は盤面が生きている間だけ効き(`-s` は電源接続時のみ)、
   蓋を閉じれば眠る。Pi に `caffeinate` は無いので `package.json` には入れず、手順の起動コマンドに書く。
3. **盤面の状態(DB / worker-logs)はチェックアウトの外、`~/.tidepool/` 配下に env で明示させる。** 既定は cwd
   相対だが、cwd は `/usage` scrape の trust の都合でチェックアウトに固定される(ADR 0074)ので、既定のままだと
   盤面の記録が checkout の作り直しで消え、ADR 0040 の重なりガードも踏みやすい。env は `~/.tidepool/env` を
   `source` する — `/etc/default/tidepool` の Mac 版で、#392 のログイン情報も将来ここに同居する。
4. **「自分の repo を足す」は GitHub 身元が GitHub App(#392)に置き換わるまで手順に書かない。** machine user の
   PAT(ADR 0024 / 0067)は一人の盤面の形で、テスターごとに用意できない。個人 PAT で先に渡せば後の方式替えが
   テスター全員のやり直しになるので、#392 を #364 の blocker にし、手順は第1段(purely-local な sandbox で
   初回タスク完走)だけ先に着地させる。
5. **手順の検証は文書内のチェックリストで、スクリプトにしない。** deploy-pi の `verify-deploy.sh` から転用できる
   検査は3つ(無認証 401、4589 / 4590 が loopback のみ、env キーの存在)で、2本のスクリプトを追従させる負債に
   見合わない。手順が通ったかの最終判定は初回タスクの完走そのものが担う。

## Considered options

- **Mac でも setup-token を要求** — 手順が1段増え(`claude setup-token` → env に貼る)、1年後に黙って切れる形を
  本人のマシンに持ち込む。守るものが無い場所に無人ホストの型を持ち込むだけ。
- **ユーザーごとの GitHub App / 個人 PAT で第2段を先に渡す** — #392 に記録。
