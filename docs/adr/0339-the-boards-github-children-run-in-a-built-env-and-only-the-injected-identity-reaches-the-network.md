# 盤面の GitHub への子プロセスは組み立てた env で走り、注入した身元以外で網に出ない

2026-11-01 の grilling(issue #2794 —— ADR 0334 の帰結、#2801 と同根)で決定。ADR 0024 決定1 の seam は「身元は host の ambient 認証ではなく
盤面の設定から注入される」、決定3 は「credential が効く場所は 1 箇所」だが、実装は**継承した** env から既知の経路 1 本(設定済み credential
helper)を消して自分の helper を足す形で、しかも認証つきの分岐だけだった。足す身元は決まっていたが、**注入した身元以外が網に出られない**とは
決まっておらず、helper を消しても残る ambient の身元の経路を同じ Mac で 5 つ実測した —— ssh 綴り(#2794)と `insteadOf`(#2801)は host の
ssh 鍵、`GIT_ASKPASS`(VS Code が立てる)は保存済みの GitHub 資格情報、`~/.netrc`、repo-local の `http.extraHeader`。env を継承せず組み立てると
loopback の偽サーバに届くのは匿名の 1 要求だけになった。表と `file:line` は #2794 のコメントに置く。

## 決定

1. **盤面が GitHub へ出す子プロセス(git と `gh`)は、注入した身元以外で網に出ない。** env は `process.env` の spread ではなく 1 箇所で組み立てる
   —— `PATH`、空の `HOME`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_TERMINAL_PROMPT=0`、転送の allowlist
   `GIT_ALLOW_PROTOCOL=file:http:https`、認証つきなら `GH_TOKEN`。git にはさらに `-c credential.helper=`(reset)・注入 helper・
   `-c http.extraHeader=`・ADR 0334 の stall 検出を付ける。置き場は ADR 0330 決定4 と同じ `github-auth.ts` の 1 箇所で、git(`runAuthedGit`)と
   `gh`(`GhCliClient`)の両方がそこから env を受け取る。転送の床が止めるのは「ssh 鍵という身元」であって秘匿ではない —— plain http が居ても
   ambient の経路は env 側で全部閉じ、token は決定3 で https にしか出ない。
2. **床は認証の無い分岐にも掛かる。** 身元を持たない盤面は public repo を匿名で読むだけで private は fail-closed に quarantine へ落ち、非 GitHub の
   remote は匿名でしか到達しない。registry.ts / workspace.ts の「`auth` 不在は bare な git に委ねる」は決定ではなく写しで、人間の `gh` ログインに
   乗っていた(#209 の実測が言う形)。ADR 0067 決定1 の「非 GitHub は生エラーのまま」はこれで文字どおりになる。
3. **注入 helper は `protocol=https host=github.com` の問い合わせにだけ token を答える。** repo-local の `insteadOf` が別 host へ書き換えても
   installation token は github.com の外に出ない。
4. **ssh 綴りの GitHub remote は盤面側で https に書き換えて盤面の名義で通す**(`-c url.https://github.com/.insteadOf=git@github.com:` と
   `…=ssh://git@github.com/`)。人間の checkout の origin は触らず、`remote.origin.url` の記録の綴りも変わらない(ADR 0052 の「綴りで repo を
   区別しない」と同じ向き)。盤面の身元は App の installation token で https にしか存在しないので、盤面が ssh で出る形は支持しえない ——
   支持するのは「人間の checkout の origin が ssh」という運用のほうである。
5. **repo-local の `http.*.extraheader` は床の述語で拒む。** URL 付きの `http.<url>.extraHeader` は `-c http.extraHeader=` の reset より特定度が
   高く勝つ(実測)。host の設定は決定1 で消えるので残るのは人間自身の checkout の `.git/config` だけで、呼び出し前に `git config --local` で
   読み、1 つでもあれば撃たずに落として quarantine の理由にその key を載せる。床の文を「host の設定と env からは」に弱めない。

## 決めないこと

- proxy 変数(`HTTPS_PROXY` 等)は組み立てた env に通さない。通さないと壊れる運用が観測されたら、その変数だけを通す。

## 退けた形

- **転送の allowlist だけを床にする**(triage sweep の推奨)—— ssh の 2 経路しか塞がず、https の 3 経路が残る。
- **ssh 綴りの GitHub を拒み `git remote set-url` を人間に求める** —— OSS の利用者の ssh origin という自分の運用を変えさせる費用を払わせる。
- **入力の門で https 綴りだけを通す**(issue の候補 1)—— `register` が焼く origin と `insteadOf` に届かない。
- **`extraHeader` を残余リスクとして記す** —— 緩めないと壊れる運用を 1 つも挙げられない。

## 帰結

- ADR 0334 の「無界の面は無い」は ssh にも文字どおりになる(ssh の転送は走らない)。
- 組み立てた env に `LANG` が無いので git の stderr は C locale に固定され、ADR 0334 決定4 の `Operation too slow` の釘が host の言語に依らない。
- `GIT_ALLOW_PROTOCOL=https` だけでは local path の remote(テスト fixture、loopback の `git http-backend`)が弾かれる —— `file:http:https` の根拠。
- worker 側は変えない: sandbox は `~/.ssh` を読ませず、worker の網は allowed domains だけ(ADR 0033)。
- #2801 は同じ根の別の姿で、同じ実装が閉じる。実装は 1 slice、#2794 のコメントが spec。
