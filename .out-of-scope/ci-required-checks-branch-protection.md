# main の branch protection / ruleset で CI の test ジョブを required にする

ADR 0155 が必須とする CI の test ジョブを、GitHub の branch protection / ruleset の required check にはしない。
必須は `/implement-tidepool` の「Waiting for CI」の手順が支える。

## なぜ範囲外か

main に merge・push する人間は owner だけで、ADR などの記録物は main へ直接 commit している。保護の設定は2通りしかなく、
どちらも得るものが無い。

- owner を bypass させる(classic の `enforce_admins=false` / ruleset の bypass list) — 直接 commit は残るが、owner の merge も
  止まらないので何も守らない。
- owner にも強制する — 直接 commit ができなくなる。

## 再開条件

公開・リリースの時点、または owner 以外(盤面の App `tidepool-board` を含む)が main に merge・push する経路ができたとき。
その時点の required check 名は `test (ubuntu-latest, 1/1)` / `test (macos-latest, 1/2)` / `test (macos-latest, 2/2)`(#985 時点)。

## Prior requests

- #984 — ADR 0155 が必須とする CI の test ジョブ2本を、main の branch protection で required にするか決める
