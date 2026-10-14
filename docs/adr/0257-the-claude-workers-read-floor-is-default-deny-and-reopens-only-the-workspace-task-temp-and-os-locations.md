# Claude worker の読みの範囲は既定拒否 —— 開け直すのは workspace・task temp・OS の置き場所だけ

2026-10-14 の grilling(issue #1950)で決定。ADR 0033 は Claude worker の読みの床を `denyRead: ["~/"]` に置いた。名指した場所だけを
閉じる形で、それ以外は開いている。Lima VM(CLI 2.1.286)で実測すると、worker の Bash から `/tmp` の下の他の task の task temp と、
他の session の `/tmp/claude-<uid>/` が読め、後者には書けた。VM が読み取り専用でマウントする Mac のホーム(`.ssh` や gh の資格
情報を含む)も読めた。Pi では盤面の DB・worker-logs・registry・他の workspace が `~/` の外にある。ADR 0256 決定1 が Codex 側で
守る「別の workspace の内容は届かない」が、Claude 側では成り立っていなかった。測定の表は #1950 のコメントに置く。

## 決定

1. **Claude worker の読みの範囲は既定拒否にする。** `denyRead` は `/` で、開け直すのは worker の workspace、task temp、既存の git
   config と skill のパス、そして OS とツール一式の置き場所(`/usr` `/bin` `/lib` `/sbin` `/etc` `/proc` `/dev`、x86_64 の `/lib64` は
   在るときだけ)である。データが置かれうる場所(`/home` `/root` `/Users` `/mnt` `/media` `/srv` `/opt` `/var` `/tmp` `/run` ほか)は
   開けない。名指して閉じる形は、閉じ忘れを後から見つける形である —— Mac のホームは、repo が固定していない Lima テンプレートの既定
   から生えていた。開け直す組は Linux の分だけを決める。darwin では worker が走らない(ADR 0100 決定6、ADR 0033 の追記)。
2. **Claude worker に task temp を持たせる。** task ごとに `tmpdir()` の下に作り、CLI のプロセスに `TMPDIR` と `CLAUDE_CODE_TMPDIR`
   として渡し、読みと書きを開け、session の終わりに消す。work と review で同じである。`/tmp` を閉じるだけだと、CLI の proxy socket
   が `/tmp` の直下に置かれたまま隠れ、許可ドメインにも届かなくなる(Codex 0.147.0 と同じ壊れ方)。CLI のプロセスの `TMPDIR` を
   task temp に向けると、socket はその中に置かれる。review の書き込みの床は permission 層(ADR 0035)のままで、task temp に書ける
   ことは、今 `/tmp/claude-<uid>/` に書けていることの置き換えである。
3. **読みの範囲の canary は、デプロイと CLI の版上げの e2e スモークに置く。封じ込め能力の検査には置かない。** ADR 0033 が置いた
   canary 読み取りのスモークに、`/tmp` の他の task の物と、ホームと `/tmp` の外の場所を読む行を足す。settings の形は unit test で
   固定する。Codex 側の canary は毎回の preflight で走るので、ここで非対称になる。理由は、Claude CLI にはモデルを通さずに sandbox の
   中でコマンドを走らせる口が無いことである(`-p '!cmd'` もモデルの1ターンになった)。毎回撃てば、pickup のたびに課金とモデルの
   従順さへの依存が入る。一方で、範囲を変えうる変数は settings の形(コード)と CLI の版(pin)で、どちらも別の手段で押さえてある。
4. **workspace が追加の読みのパスを宣言する口は作らない。** 要る workspace はまだ観測されていない。要るときは `allowed_domains` と
   同じく、人間が registry で下す判断として足す。

## 退けた案

- **`/tmp` だけを `denyRead` に足す** —— 許可ドメインへの通信が切れる(実測)。task temp を足して通しても、Mac のホームと Pi の
  `/opt` `/mnt` は開いたまま残る。
- **封じ込め能力の検査で、モデルの1ターンを撃って読みを測る** —— 決定3 の理由で採らない。
