# worker の形で走る process は盤面が列挙したものだけを host から受け取る —— env は組み立て、Codex の列挙外の config 層は封じ込め能力の不成立

**Status 追記: 決定4 の「内容を持つ層」は `config/read` の `config` でなく層の folder で読む** —— path を報告する列挙外の層は、`file` の親(または `dotCodexFolder`)が **存在するだけ**で不成立。path の無い層(mdm / enterpriseManaged / legacy managed)は `config` の中身のまま。列挙内の `user` 層は folder も所有で覆う(`--ignore-user-config` は user 層を空の config のまま stack に残すので `CODEX_HOME/agents` は worker に載る —— source の読みで未実測。盤面所有で worker は書けない)—— 観測は足さない。folder の stat は ENOENT だけが「無い」で、他の失敗は不成立。理由: Codex 自身の層の広がりは `config_folder()` 1つの規則で、agents・rules・skills・hooks.json はその folder から読まれ、requirements.toml は同じ dir を literal で読む(0.163.0 の source)。`config` だけを見るのは口の形の写しで、`/etc/codex/agents/*.toml` だけの host が層の行を通った(#3017 / #3041 の実測)。「`config.toml` 以外の項目があれば」でなく存在で拒むのは、写す規則を「folder は file の親」1つに保ち、同じ層への観測を1本にするため—— 空の dir / 空の `config.toml` も host が置いたもので、人間が消す先は表示で分かる。`--ignore-rules` が外すのは User / Project の rules だけで、system の rules はこの行が持つ(ADR 0098 決定3 / 0147 / 0148 / 0326 決定3 に追記)。退けた mount namespace へ移る条件は文面どおり(2026-11-09、issue #3042)。

**Status 追記: 決定4 の「requirements が空でなければ不成立」は「盤面の `sessionFlags` が作る値の外に requirements があれば不成立」と読む** ——
固定版 0.163.0 の実物は、盤面自身が渡す `-c forced_login_method="chatgpt"`(ADR 0098)を `configRequirements/read` の
`allowedLoginMethods: ["chatgpt"]` として報告し、`/etc/codex` の無い host でも requirements は空にならなかった。成立は、各欄が null か、
`allowedLoginMethods` が盤面の flag の値と一致するときだけ。列挙した `sessionFlags` が作る値を列挙に入れる形で、vendor の主張による例外ではない
(2026-11-07、issue #3041 の実測コメント)。

2026-11-07 の grilling(issue #2998 と #3017 を1つで、#3002 / #2478 は同じ族)で決定。GLOSSARY「床」の最後の段落(ADR 0354)は
「worker の CLI process が読む host 側の状態は盤面が持つ」と言い、git / gh の子(ADR 0339 決定1)・Claude の CLI 状態(ADR 0354 決定1)・
Codex の user 層(ADR 0098 / 0147)はその線の上にあった。残っていたのは2つ —— **env** は ADR 0097 決定4 が反対側(`process.env` を継ぎ、
一覧を消す denylist)を明示的に決めていて、**Codex の system / managed の config 層**はどの ADR も触っていなかった。

決定4 の前提は盤面自身が崩していた。決定4 は「秘密を盤面 env に置かない doctrine が床にあるから scrub は routing 一式で足りる」とし、翻意の
条件を「人が雑に export した秘密が紛れ込む日常」と書いたが、ADR 0070 決定1 は `CLAUDE_CODE_OAUTH_TOKEN` と VAPID 秘密鍵を Pi の盤面 env
(`/etc/default/tidepool`)に置き、盤面は VAPID 鍵を `process.env` から読む。どの一覧もこの名前を消さないので、Pi の全 worker が盤面の push
通知の秘密鍵を継いでいた(code と deploy の設定の読み)。決定4 の構造論「除去一覧 = 注入一覧」に当たるのは Moonshot / subscription の対
だけで、残る一覧(refusal の swap、subagent の model、trust の述語、pin の上書き、host の credential)は vendor が読む名前の写しを、効き方
ごとの ADR が「継ぐ既定」を問い直さずに1つずつ足したものだった。Codex 側は、host の `/etc/codex/config.toml` の trust が workspace の
`.codex/agents` を開き、`/etc/codex/agents` の role が trust 無しで載り、system 層の MCP server が sandbox の外で起動することを固定版
0.163.0 で実測した(#3017)。`codex exec` に system 層を外す flag は無い。実測の表と `file:line` は #2998 / #3017 のコメントに置く。

## 決定

1. **worker の形で走る process(worker 本体、worker の形の ping / probe —— ADR 0341 の posture)は、host の状態を既定で隔て、渡すものを
   盤面が列挙する。** 列挙の外のものが届く形は、名前を消す点修正ではなく、この決定への違反として直す。外に残すのは `/usage` の scrape(pty の TUI で
   `TERM` 等に依る —— 未測)と盤面の local git(ADR 0339 帰結、#2819 / #2842)の2つ。答えを取りに行く Board call は、CLI 状態は人間の
   login のまま(ADR 0354)だが env はこの決定に入る —— 空のツール面(ADR 0044)でも env の持ち主を2つに割らない。
2. **env は Harness を跨いで1箇所で組み立てる。** 土台は `PATH`・`HOME`(Claude の credentials の置き場のためだけ、ADR 0354 決定1)・task temp の
   `TMPDIR`・`GIT_CONFIG_GLOBAL=/dev/null`・`GIT_CONFIG_NOSYSTEM=1`(`HOME` が運ぶ host の git config を Harness 共通で閉じる —— #2819 が
   盤面の local git で観測した `commit.gpgsign` / `core.hooksPath` は worker の git にも効く。Codex 側は #453 の実装の写しで ADR が無かった)で、その上に Harness の adapter が自分の注入一式(Claude: `CLAUDE_CODE_OAUTH_TOKEN` の pass-through、config dir、
   timeout、`GIT_*` の名義。Moonshot: key file からの注入 —— spawn も認証の probe も。Codex: `CODEX_HOME`、git config、npm の固定値)を載せる。
   Claude worker・Moonshot の認証 probe・Codex worker・Codex の probe・Claude Board call(worker の形も答えも)が同じ場所から受け取る。`LANG` / `TZ` / `USER` / `SHELL` /
   proxy / CA / `SSH_AUTH_SOCK` / `TIDEPOOL_*` は渡さない。ADR 0097 決定4 の「注入一覧と除去一覧を同じ定数から導く」は注入の向きだけが
   残り、除去一覧は無くなる。
3. **列挙はコード定数で、設定の口を持たない。** 渡す名前は Harness adapter の vendor 知識(ADR 0005)で、registry・盤面設定・盤面 env の
   どこからも足せない。host 固有の名前が要る運用が観測されたら、通すのは定数への1行で、設定の口ではない(ADR 0013 の「床はデータの
   状態に依存しない」と同じ向き)。
4. **Codex の config 層は、Harness 単位の封じ込め能力の検査が列挙の外を拒む。** 検査(`hooks/list` と同じ app-server の口、cwd 無し ——
   ADR 0259 決定4)に `config/read(includeLayers)` と `configRequirements/read` を足し、列挙した2層 —— `sessionFlags`(盤面の `-c`)と、
   file が盤面所有の `CODEX_HOME/config.toml` である `user`(Codex 自身が trust を書くので内容は問わない)—— の外に内容を持つ層が1つでもあれば、また requirements が空でなければ、能力を不成立にする。悪い層の名前を数える denylist では
   なく、渡すものの列挙の外を拒む形で、requirements を vendor の「制限にしか使えない」という主張で例外にしない(ADR 0354 が退けた
   「vendor の選んだものを床にする」形)。検査は封じ込め能力と同じ周期(pickup ごと)で走るので、観測の時点は新しく決めない。口と層の名前は 0.163.0 の source の読みで、
   固定版の実物への照合は版上げの適合試験(ADR 0147 の口)が持つ。
5. **観測は spawn env の全量一致テスト1本で持つ。** host の env に囮(秘密の形の名前、旧一覧の名前、`TIDEPOOL_VAPID_PRIVATE_KEY`)を
   置き、spawn env が列挙と完全一致することを literal の expected で釘にする。実環境の canary には足さない。#2478 の偽陽性と失敗出力の
   値の露出は、expected が literal になることで同じ変更で消える。

## 決めないこと

- proxy・CA(`HTTPS_PROXY` / `NO_PROXY`、`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`)は渡さない。通さないと壊れる運用が観測されたら、
  その変数だけを通す(ADR 0339 と同じ線)。
- 盤面自身の秘密の置き場が env(Claude token、VAPID)と file(GitHub token、Moonshot key)に割れていることは、本 ADR で漏れが閉じる
  ので別の問い(派生 issue)。

## 退けた形

- **名前を1つ足す点修正**(#2469 → #2998 の繰り返し)—— 付与(spread)を残して効き方を名前で閉じる形で、秘密の名前の集合は閉じない。
- **秘密に見える名前のパターンで消す**(triage の最初の推奨、ADR に無い第3案)—— URL に埋まった資格情報・資格情報への入口
  (`SSH_AUTH_SOCK`、`GIT_ASKPASS`)・振る舞いを変える host の env が残り、一覧を育て続ける。
- **mount namespace で `/etc/codex` を隠す** —— 止めずに隔てられるが、盤面の容器(ADR 0099)が mount を隔てるかは未確認で、Codex 自身の
  bwrap の入れ子になる。不成立を出す運用(本番 VM に `/etc/codex` を置く)が1つも挙がっていないうちは採らず、観測されたら移る。
- **requirements 層を例外にする** —— 例外は列挙に「渡すもの」として足すことで、根拠が vendor の主張だけになる。

## 派生

- Status 追記: ADR 0097 決定4(退役)、ADR 0287 決定3 と ADR 0354 決定1(「常に delete」は「列挙に無い」で読む)、ADR 0024 決定3 と
  ADR 0070 決定1(「env 継承で受け取る」の経路は列挙した pass-through に)。
- GLOSSARY: 床(host 側の状態に env と Codex の config 層を含める)。
- 実装は `/to-spec` → `/to-tickets`(env の組み立て・Codex の層の検査・テスト)。#3002 / #2478 は同じ変更で閉じる。
