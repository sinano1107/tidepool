# Git 共有された workspace の settings.json は中身を問わず worker から隠し、quarantine しない

**Status 追記: 決定1 の「hooks・`sandbox` / `permissions`・壊れた JSON のどれを持っても」と決定2 の「床キー・hooks・壊れた JSON を持てば」という条件は [ADR 0346](0346-the-board-decides-workspace-settings-by-place-not-content-tracked-is-always-hidden-untracked-and-local-stop-on-presence.md) で廃止 —— tracked は中身を問わず隠し、untracked / local は存在で止める。中身を読む判定は disposition から消えた(2026-11-02、issue #2846)。**

**Status 追記: 隠す書き方(pattern の置き換え・`sparse-checkout add` での戻し・skip-worktree の S bit での判定)は [ADR 0293](0293-the-board-hides-tracked-settings-by-adding-one-line-to-a-snapshot-of-the-humans-sparse-checkout-and-restores-the-snapshot.md) で、人間の sparse-checkout の写しに `!/.claude/settings.json` の1行を足して隠し、写しどおり戻す形に置き換わった(2026-10-21)。決定1〜4 はそのまま。**

2026-09-26 の grilling(issue #1005)で決定。ADR 0037 追記(issue #382)は、tracked な `.claude/settings.json` が
hooks だけなら worker session 中に sparse-checkout で実体化から外し、`sandbox` / `permissions` や壊れた JSON を持てば
「床の著者権の主張」として従来どおり quarantine するとした。その結果、`permissions.allow` を commit した普通の
Claude Code 利用者のリポジトリは、登録も clone も黙って通り、最初の pickup で必ず止まる。作成時に予告・拒否する案を
検討する中で、quarantine そのものの根拠が外す機構と両立しないことが分かった。実測と現状のコード調査は #1005 のコメントに置く。

## 決定

1. **tracked な `settings.json` は、hooks・`sandbox` / `permissions`・壊れた JSON のどれを持っても、worker session 中だけ
   実体化から外す。** quarantine しない。この1行で ADR 0037 追記の「同じファイルに `sandbox` / `permissions` があれば
   従来どおり quarantine」と「壊れた JSON も同じ」を置き換える(tracked に限る)。回収後に戻す仕組み・盤面外で保つ線は
   #382 のまま。
2. **Git 共有されていない設定は従来どおり quarantine する。** `settings.local.json` と untracked な `settings.json` は
   sparse-checkout で安全に外せないため(ADR 0037 追記の理由のまま)。
3. **登録の門で quarantine を予告しない。** 決定2の形は #383 の `claude_settings_local` と #686 の untracked 信号が
   「生きた dev checkout らしさ」として既に提示しており、clone 入口へ移れば付いてこない。予告を混ぜると #383 が退けた
   意味が入る。
4. **canary に行を足さない。** 既存の `project-hook` 行が「sparse で外した tracked settings を CLI が index から読まない」を
   full-checkout control と対にファイル単位で測っており、キーを問わない。

## なぜ quarantine の根拠が消えるのか

床キーを guard する理由は、CLI が workspace の settings を読んで `--settings` の床とマージすること、そしてどの tier の
どのキーを CLI が尊重するかはベンダーの挙動で変わりうること(guard 自身の注記)だった。外したファイルは
読まれない。worker 自身は settings ファイルを書けない(ADR 0037 機構2)ので、「session N で広げ N+1 で出る」経路もない。
壊れた JSON の fail-closed も「読めないせいで床キーを見落とす」ことを防ぐためで、読まれないファイルには見落とすものがない。
ファイルシステムがそもそも読めない tracked ファイル(ENOENT 以外の読み取りエラー)はこの決定の外で、従来どおり quarantine する。

## 退けた案

- **quarantine を保ち、作成時に拒む** —— quarantine は Claude worker の spawn 前だけにあり、workspace は Harness に縛られない。
  作成時に拒めば、Codex agent が担当なら動く workspace まで塞ぐ。clone の後でしか settings は読めず、ADR 0040 の
  「外部効果の前に拒む」とも噛み合わない。
- **quarantine を保ち、作成時に提示する** —— tracked な設定はリポジトリの性質で、clone 入口へ移っても同じファイルが付いて
  くる。提示しても逃げ道がなく、同意しても動かない(ADR 0146 が linked worktree で退けたのと同じ構造)。
- **床の著者権を尊重して quarantine を保つ** —— commit された `sandbox` が worker を締める意図だったとしても、worker の床を
  決めるのは盤面だけである(ADR 0033)。外しても盤面の床はそのまま効き、失うのは締めの上乗せだけ。`model` / `env` などの
  通常キーが一緒に消えるのは hooks の場合と同じで、受け入れる。
