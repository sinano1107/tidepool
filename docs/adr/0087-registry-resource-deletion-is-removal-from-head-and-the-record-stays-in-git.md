# registry リソースの削除は HEAD からの除去であり、記録は registry の git が保つ

issue #205 のグリリング(2026-08-18)で決定。workspace / agent / authority profile を人間面から消す手段が
無く、うまく働かなかった agent や実験用に作った workspace が registry に残り続ける煩わしさへの回答。
リネームはこの決定の対象外 —— agent は ADR 0019 が「新名で作成し旧名を削除」と答え済みで、workspace /
profile のリネームは痛みが観測されていない(観測されたら別 issue)。

## 決定

1. **削除は registry の committed main からエントリを除去すること**であり、無効化フラグ(`retired: true`
   のような残置)ではない。記録は消えない —— registry は git リポジトリであり、過去タスクが参照する agent
   本文は commit 指定で読まれる(ADR 0020 / `agentBodyAtCommit`)ので、HEAD から消えても履歴参照は壊れない。
   Memory の「削除は無く無効化のみ」は DB 内エントリの線であって、git 自体が履歴を持つ registry には
   フラグを重ねない。削除後の同名再作成は転生(ADR 0019)の抜け道になりうるが、手作業の `git rm` にも同じ
   穴は既にあり、v1 は門を足さない(記録として残す)。
2. **参照中のリソースは扉で拒否する。** 未決着タスクが assignee / workspace として参照している agent /
   workspace は消せない(参照している件数を返す —— 先に cancel か再割当が筋)。いずれかの agent が
   `authority` で参照している profile も消せない(現状その解決失敗は quarantine ではなく素の失敗に落ちる
   穴なので、門で塞ぐのが唯一の安全側)。profile の `assignable_to` / `allowed_workspaces` に列挙されている
   だけの agent / workspace は消せる —— 列挙は許可先であり、存在しない名前が残っても許可先が1つ消えるだけで
   無害。ADR 0019 の「余波は quarantine が受け止める」は帯域外の手作業の安全網であり、人間面の扉は事故を
   作らない門である。
3. **消せない資源**: 盤面自身の registry clone(保護剥奪と同じく永久に拒む)、盤面の既定 agent と既定
   workspace(既定はポインタなので、指し先を消せば未指定タスク全部が止まる)。
4. **workspace の削除は registry エントリだけ。** ホスト上の checkout(決着後も残るタスクブランチ = 差分の
   恒久記録を含む)と GitHub 側のリポジトリは触らない。応答は checkout の残る場所を明示する。
5. **作成扉の孤児流用の門を締める。** clone / create モードは規約パスに既にあるディレクトリを「前回失敗の
   孤児」として中身を見ずに流用していたが、削除済み workspace の checkout が残っていると同名で別 repo を
   clone しても古い checkout を静かに採用する。流用は**要求と整合するときだけ** —— clone は `origin` が
   要求 repo と一致するとき、create は `origin` を持たないとき —— に限り、それ以外は checkout の場所を
   名指しして拒否する(register モードで拾うか帯域外で片付ける)。削除とは独立に価値がある(手作業で
   エントリを消した後も同じ事故が起きる)。
6. 記録は registry の commit のみ(作成・編集と同じ)。扉は WebUI のみ(ADR 0088)。

## Considered options

- **削除時に checkout も消す / `<name>.deleted-<日時>` へ退避** —— 前者はタスクブランチの恒久記録を壊す
  破壊的操作、後者は非破壊だがディスクに増え続ける。名前の再利用事故の実体は「中身を見ない流用」なので、
  そちらを直す(決定5)。
- **参照中でも消して quarantine に任せる** —— ADR 0019 の線だが、扉から意図的に事故を作る形になる。
