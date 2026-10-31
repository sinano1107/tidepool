# skill の許可は正に知った集合(checkout が運ぶ・ハーネス同梱)への解決で、どちらにも無い名前はどの entry 形でも閉じる

2026-10-31 の grilling(issue #2779、#2774 の sweep の派生)で決定。checkout の `.claude/skills` に commit された、checkout の外を指す
symlink は、固定版 CLI 2.1.286 が worker の形(sandbox profile + `--setting-sources project`)でも `init` に載せ、`Skill` は link の先の本文を
注入する(CLI 自身の読みは sandbox の外。Linux の sandbox 下の Bash はその link を辿れない)。この skill の本文は workspace の git にも
ハーネスにも無いのに、`@host` の実装が「checkout が運ぶ集合に無いもの」という引き算(ADR 0025 決定4)なので `@host` / `*` の agent に
開き、帰責の判事には `skills.host` として届いて `environment` と読まれる。引き算が GLOSSARY.md の `@host`(ハーネス同梱の skill 全部)と
一致していたのは、ADR 0038 が user / plugin の skill を worker から外した日からの偶然で、第3の出所が1つ現れた時点で破れた。実測の表・
読み手の一覧・`file:line` は #2779 のコメントに置く。

## 決定

1. **allowlist の各 entry は正に知った集合へ解決し、許可 = 解決の和 ∩ (運ぶ ∪ 同梱)、deny = 列挙 − 許可。** 運ぶ集合は checkout の
   走査(実体が checkout の内側にある dir、link を含む —— #2774)。同梱集合は worker と同じ tier フラグ(`--setting-sources project`)で
   neutral cwd を ping したときに CLI が報告する集合から、**checkout の `.claude/skills` の entry 名全部**(実体がどこを指すかを問わない)を
   引いたもの —— 同名の skill は checkout 側が勝つ(実測)ので、名前の集合で2つの出所を区別できない。`@workspace` → 運ぶ集合、`@host` →
   同梱集合、名前と `名前:*` → 列挙との一致。外を指す link、user 層・plugin の名前、将来の未知の出所は、どの entry 形でも許可の外に
   落ちる —— 名前指定でも開かないのは、registry の著者は link の先を見ていないので名前が同意にならないため。`*` は「運ぶ ∪ 同梱」に
   解決するので列挙 ping を撃つ(ADR 0025 決定5 の「ping 不要」は `[]` だけに縮む)。workspace が同梱と同じ名前の dir を置くと `@host` の
   agent からその同梱 skill が消えるのは、閉じる側に倒した意図した帰結である。
2. **同梱集合の持ち主は1関数(`enumerateHostSkills` に tier フラグを足したもの)で、WebUI の picker と spawn が同じものを読む。** 有限
   allowlist と `*` の spawn に neutral cwd の ping が1本増える(約2秒、token 0)。失敗は既存の列挙失敗と同じ `spawn_failed`(fail-open 無し、
   ADR 0025 決定6)—— その spawn 1回の失敗であって CLI が壊れた証拠ではないので、封じ込めの probe の結果に相乗りして harness ごと止める形は
   採らない。
3. **記録は `worker_spawned.skills = { workspace, host, permitted: string[] }`、`"all"` は廃止。** `host` は決定1の実効集合で、判事は記録の
   2列で正に分ける(ADR 0325 決定2 の「workspace の集合で2分」はこの2列に置き換わる)。sandbox の `skillReadPaths` は消える —— user /
   plugin の名前は許可に入らず、workspace の entry は `workspacePath` の下で既に読める(ADR 0038 決定4「`sandbox.ts` は無変更」の反転)。
4. **workspace cwd の列挙 ping は flag 無しのまま。** ADR 0044 追記2 の理由(user 層まで含めた集合が `@host` に要る)は消え、残る理由は
   「worker に届かない名前を余分に deny しても害が無い」だけである。
5. **Codex も同じ規則。** `skills/list` の `scope` が `system` → 同梱、`repo` かつ実体が checkout の下 → 運ぶ、それ以外(`user`、checkout
   の外の `repo`)→ 閉じる。翻訳は #2689 で組む。

## 退けた形

- **引き算に「外を指す link」の集合を1つ足す** —— 点修正。次の出所(CLI の探索場所の追加、project 層の別の供給源)が現れるたび同じ追記になる。
- **外を指す link を `@workspace` に数える**(checkout が commit し、修理子が消せる)—— ADR 0025 決定7 は `@workspace` を「PR レビューを通る面」に
  閉じる決定で、link の先の本文はその workspace の PR に映らず review の後で変わる。
- **外を指す link を quarantine の契機にする** —— 契機は Git 共有されていない設定(GLOSSARY.md の Quarantine)で、committed な link は
  deny で閉じれば人間を止める理由が無い。
- **scope 語では閉じ、`*` と名前指定では開く**(sweep の推奨)—— 名前は同意にならない(決定1)。
- **workspace cwd の1本の ping(tier フラグ付き)から同梱 = 列挙 − entry 名 で引く** —— ping は増えないが、未知の project 層の出所が
  同梱に落ちる負の定義に戻る。
- **封じ込めの probe の init 行から同梱集合を読んで scheduler から spawn へ配線する** —— 封じ込めの型・scheduler・適合試験(ADR 0186)に
  触り、失敗の単位が「Claude の pickup 全部」になる。
