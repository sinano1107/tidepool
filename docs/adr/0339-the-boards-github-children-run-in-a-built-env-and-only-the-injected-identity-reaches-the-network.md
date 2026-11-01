# 盤面の GitHub への子プロセスは組み立てた env で走り、注入した身元以外で網に出ない

2026-11-01 の grilling(issue #2794 —— ADR 0334 の帰結、#2801 と同根)で決定。ADR 0024 決定1 の seam は「身元は host の ambient 認証ではなく
盤面の設定から注入される」、決定3 は「credential が効く場所は 1 箇所」だが、実装は**継承した** env から既知の経路 1 本(設定済み credential
helper)を消して自分の helper を足す形で、しかも認証つきの分岐だけだった。足す身元は決まっていたが、**注入した身元以外が網に出られない**とは
決まっておらず、helper を消しても残る ambient の身元の経路を同じ Mac で 5 つ実測した —— ssh 綴り(#2794)と `insteadOf`(#2801)は host の
ssh 鍵、`GIT_ASKPASS`(VS Code が立てる)は保存済みの GitHub 資格情報、`~/.netrc`、repo-local の `http.extraHeader`。env を継承せず組み立てると
loopback の偽サーバに届くのは匿名の 1 要求だけになった。表と `file:line` は #2794 のコメントに置く。

同日の grilling(issue #2827、根の設計 issue は #2841)で決定4・5 を書き直した。元の決定5 は checkout の `.git/config` に
残る身元の運び手を key 名で拒む denylist で、`extraheader` → `sslverify` → `cookieFile` / `sslCert` / `sslKey`(#2827)→ `proxy` / `sslCAInfo`
(#2832)と 3 度伸び、`include.path`(絶対 path)が host の任意の file を checkout の config に戻すことも実測した —— key の集合は閉じない。
根は「盤面の網に出る git が、盤面の書いていない repo の中で走る」ことで、決定5 はその repo を読まない形に替えた。

## 決定

1. **盤面が GitHub へ出す子プロセス(git と `gh`)は、注入した身元以外で網に出ない。** env は `process.env` の spread ではなく 1 箇所で組み立てる
   —— `PATH`、空の `HOME`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_TERMINAL_PROMPT=0`、転送の allowlist
   `GIT_ALLOW_PROTOCOL=file:http:https`、認証つきなら `GH_TOKEN`。git にはさらに注入 helper(決定3)・ADR 0334 の stall 検出・
   `-c maintenance.auto=false -c gc.auto=0`(fetch が自動起動する `--detach` の子は ADR 0334 の上限の外に出る)を付ける。打ち消しの `-c`
   (reset)は 1 つも無い —— 読む config が盤面の物だけなら打ち消す相手が無い(決定5)。置き場は ADR 0330 決定4 と同じ `github-auth.ts` の
   1 箇所で、git(`runAuthedGit`)と `gh`(`GhCliClient`)の両方がそこから env を受け取る。転送の床が止めるのは「ssh 鍵という身元」であって秘匿ではない —— plain http が居ても
   ambient の経路は env 側で全部閉じ、token は決定3 で https にしか出ない。
2. **床は認証の無い分岐にも掛かる。** 身元を持たない盤面は public repo を匿名で読むだけで private は fail-closed に quarantine へ落ち、非 GitHub の
   remote は匿名でしか到達しない。registry.ts / workspace.ts の「`auth` 不在は bare な git に委ねる」は決定ではなく写しで、人間の `gh` ログインに
   乗っていた(#209 の実測が言う形)。ADR 0067 決定1 の「非 GitHub は生エラーのまま」はこれで文字どおりになる。
3. **注入 helper は `protocol=https host=github.com` の問い合わせにだけ token を答える。** repo-local の `insteadOf` が別 host へ書き換えても
   installation token は github.com の外に出ない。
4. **網に出る URL は盤面が組む。** checkout の `remote.origin.url` の**値**(insteadOf 適用前)から repo key を取り、GitHub なら
   `https://github.com/<owner>/<name>.git` を、非 GitHub なら値そのままを git に渡す。`gh` にも同じ key を `-R` で渡し、cwd の remote から
   repo を解かせない。人間の checkout の origin は触らず記録の綴りも変わらない(ADR 0052 の「綴りで repo を区別しない」と同じ向き)。盤面の身元は
   App の installation token で https にしか存在しないので、盤面が ssh で出る形は支持しえない —— 支持するのは「人間の checkout の origin が
   ssh」という運用のほうである。URL の元を registry の `repo` 宣言にしないのは、ADR 0052 決定3 がそれを綴りを照合しない人間向けの
   provenance と置き、registry clone 自身に宣言の行が無いからである。
5. **盤面の網に出る git は、checkout の中では走らない。** 呼び出しごとに使い捨ての盤面所有の repo を作り(`--git-dir` の引数、env ではない)、
   `objects/info/alternates` で checkout の objects を**読むだけ**借りる。fetch の結果は盤面 repo の `refs/board/fetched` に置き、checkout は
   そこから local に取る(hop2、網に出ない)。push の後の写し(`refs/remotes/origin/*`)は git の副作用に任せず、盤面が ADR 0243 の口の中で
   `update-ref` で書く。checkout の `.git/config` は網に出る呼び出しの入力にならない —— どの key が身元や経路を運ぶかを数えない。
   `clone` は盤面所有の HOME を cwd にして撃つ(親 checkout の config も読まない)。

## 決めないこと

- proxy 変数(`HTTPS_PROXY` 等)は組み立てた env に通さない。通さないと壊れる運用が観測されたら、その変数だけを通す。

## 退けた形

- **転送の allowlist だけを床にする**(triage sweep の推奨)—— ssh の 2 経路しか塞がず、https の 3 経路が残る。
- **ssh 綴りの GitHub を拒み `git remote set-url` を人間に求める** —— OSS の利用者の ssh origin という自分の運用を変えさせる費用を払わせる。
- **入力の門で https 綴りだけを通す**(issue の候補 1)—— `register` が焼く origin と `insteadOf` に届かない。
- **`extraHeader` を残余リスクとして記す** —— 緩めないと壊れる運用を 1 つも挙げられない。
- **checkout の `http.*` を key 名で拒む / 許す key を列挙する**(#2827 の sweep の 2 案)—— どちらも「網に出る git が checkout の config を
  読む」前提の上にあり、`include.path` で任意の file が戻る以上 key の集合は閉じない。
- **checkout の objects を盤面 repo の object dir として借りる**(`GIT_OBJECT_DIRECTORY`)—— ref を持たない盤面 repo の gc(fetch が自動起動する
  maintenance を含む)が checkout の objects を全部消す(実測)。alternates は読むだけで、盤面 repo の gc は checkout に届かない。
- **盤面が全 checkout を自分で作る**(`register` を clone に替える)—— 残る半分(local の git が人間の checkout の config を読む、#2819)の
  根だが、workspace のモード(ADR 0066)と「人間がホスト上の checkout を覗く」運用を変える別の問い(#2842)。

## 帰結

- ADR 0334 の「無界の面は無い」は ssh にも文字どおりになる(ssh の転送は走らない)。
- 組み立てた env に `LANG` が無いので git の stderr は C locale に固定され、ADR 0334 決定4 の `Operation too slow` の釘が host の言語に依らない。
- `GIT_ALLOW_PROTOCOL=https` だけでは local path の remote(テスト fixture、loopback の `git http-backend`)が弾かれる —— `file:http:https` の根拠。
- worker 側は変えない: sandbox は `~/.ssh` を読ませず、worker の網は allowed domains だけ(ADR 0033)。
- 盤面の local の git(`git.ts` の `run`: WIP commit・registry commit・worktree、決定5 の hop2 と `update-ref` も)は本 ADR の外で、host の
  global config と checkout の config を読んだまま —— `commit.gpgsign` が盤面の commit を人間の鍵で署名させるか失敗させ、`core.hooksPath` の
  hook が走る(実測、#2819)。
- token は検証済みの TLS にしか出ない —— 盤面 repo の config は空で `http.sslVerify` を倒せる file が無い。決定3 の「https の github.com にだけ」の
  TLS 側。
- worker や人間が checkout の `.git/config` に何を書いても、盤面の名義と経路は変わらない。worker の `.git/config` 保護は harness ごとの行
  (Codex は tidepool の profile、macOS では効かない #860)で、盤面の身元はそこに乗らない。
- 写しが動くのは `fetchBranchCopy` と push 後の `update-ref` だけになる(暗黙に写しを進める `fetch origin <branch>` は無い)。ADR 0052 決定1 の
  「push 成功 = 写しが動く」は盤面が口の中で書く形に置き換わる(同 ADR の Status 追記)。
- fetch の negotiation は checkout の `refs/remotes/origin/*` の sha を `--negotiation-tip` に渡して行う —— 空の盤面 repo は have を言えない。
- #2801 は同じ根の別の姿で、同じ実装が閉じる。#2827 / #2832 / #2828 は決定5 の実装(#2841)が閉じる。実測の表は #2827 のコメント、spec は #2841。
