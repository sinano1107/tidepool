# Claude worker の CLI 状態は盤面所有で spawn ごとに新規、checkout の subagent 定義は名前で閉じる —— 口は settings.json だけではなかった

**Status 追記: 決定1 の「`CLAUDE_CODE_SANDBOXED` を spawn env から常に delete」は [ADR 0358](0358-a-worker-shaped-process-receives-only-what-the-board-enumerates-env-is-built-and-codex-config-layers-outside-the-enumeration-fail-the-capability.md) で「盤面が組み立てる env の列挙に無い」と読み、worker の形の Board call(#3002)も同じ env を受け取る** —— 「その process が読む host 側の状態は盤面が持つ」の線を env と Codex の config 層へ広げた(2026-11-07、issue #2998 / #3017)。

2026-11-02〜06 の grilling(issue #2936、#2846 のレビューの派生)で決定。triage の実測(Lima VM、固定版 2.1.286)で、checkout の
`.claude/agents/*.md` の frontmatter `hooks:` が **その checkout が trust 済みのとき** host 上・sandbox の外で、worker session の env を
継承して走った。trust は checkout の性質ではなく host の人間の `~/.claude.json` の `projects[<cwd>]` の状態で、Claude worker の spawn env
は `process.env` から鍵を1つずつ消す形なので、worker の CLI process は host の人間のその file をそのまま読む(`--setting-sources project`
が落とすのは user tier の settings だけ)。Codex worker は盤面所有の `CODEX_HOME` と task ごとの `XDG_CONFIG_HOME` を受け(ADR 0098 /
0147 / 0148)、git / gh の子は盤面が組んだ HOME で走る(ADR 0339 決定5)。Claude worker だけが host の人間の CLI 状態を継承していて、
それを決めた ADR は無い —— ADR 0287 決定3 が `.claude/agents/*.md` を親の采配に置いたのは model の軸で、host 実行の軸は写しだった。
今まで開かなかったのは盤面の clone と人間の checkout の path が違う偶然で、人間が生きた checkout を登録する形(ADR 0090 の Mac、友人
テスト)でそのまま開く。同じ `projects[<cwd>]` には `hasClaudeMdExternalIncludesApproved`(CLAUDE.md の `@` 参照が project の外の host
file を読む承認、binary の読み)もあり、同じ根の2例目である。frontmatter の `permissionMode` は親が review の `manual` でも subagent を
`acceptEdits` / `auto` にして workspace への redirect を通す(VM 実測 —— 同じ命令は親でも control の subagent でも拒まれた)。trust に
依らないことと、`bypassPermissions` だけ親の mode に戻ることは binary の読み—— checkout の定義が worker の床の軸に触る、hooks でも trust でもない経路。実測の表(Mac A / B、VM R1〜R5)と binary の読みの offset は #2936 のコメントに置く。

## 決定

1. **worker の形で走る process(worker 本体、workspace cwd の列挙 ping、worker の形の probe —— ADR 0341 の worker-shaped posture)は、
   盤面所有の `CLAUDE_CONFIG_DIR` で走る。** dir は spawn ごとに新規で、task temp の兄弟として sandbox の読み書きの外に作り、worker の
   Write tool からは `Edit(//<dir>/**)` の deny(ADR 0156 の auto-memory と同じ形・同じ絶対 path の綴り)で閉じ、settle で消す。spawn
   の無い ping / probe は呼び出しごとに作って消す(`atNeutralCwd` と同じ寿命)。ADR 0341 の posture は flags だけだったので env の半分を
   得る(Status 追記)。盤面はこの dir から何も読まない(transcript は自分の tee、`--resume` は使わない)。credentials だけは
   `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`(空で set)で host の置き場に残す —— ADR 0090 の ambient login は credentials の置き場の決定で、
   それ以外の CLI 状態を人間と共有する理由ではない。keychain の読みは Mac 2.1.316 の実測で 2.1.286 は binary の読み、本番の形(ADR 0100、
   VM 内の `claude auth login` → Linux の `~/.claude/.credentials.json`)は VM で path の解決まで確認(期限切れの file で既定 dir と同じ
   「expired」、空 set 無しでは「Not logged in」)、生きた login での認証は実装の確認 issue が持つ。これで worker session ではどの checkout
   も trust されず、外部 include の承認も無い。sandbox 下の worker の Bash は変わらない(shell snapshot は config dir の下に書かれるが
   sandbox の中では既定 dir でも読めておらず、`source … || true` で黙る —— VM 実測)。`answer` posture と `/usage` の scrape は人間の
   login 状態を使うので触らない。`CLAUDE_CODE_SANDBOXED` は workspace trust の述語を host の env が反転させるので、ADR 0287 決定3 の
   env と同じ形(常に delete)で spawn env から消す(agent hooks の門には届かないことは実測)。
2. **checkout の subagent 定義は worker に届けない。** deny の名前は2つの和: init 行の `agents` の引き算(workspace cwd の ping −
   neutral cwd の ping)と、checkout の `.claude/agents/**/*.md` の frontmatter `name:`(agent 名は `name` で、filename ではない —— binary の
   読み)。後者が要るのは、projectSettings の agent が同名の built-in / user agent を黙って置き換える(binary の読み)ので、名前の集合の
   引き算では同名の衝突が見えないから —— ADR 0335 決定1 が `.claude/skills` の entry 名を読むのと同じ写し。同名は閉じる側(worker が
   その built-in を失う)。綴りは実測どおり `--disallowedTools Agent(<name>)`(`Task(<name>)` ではない)。列挙の失敗は spawn の失敗
   (ADR 0025 決定6)。2本の ping は skill の allowlist に依らず常に撃つ —— `[]` の agent も subagent は持つので、ADR 0025 決定5 の
   「`[]` は ping 不要」は skill の deny についてだけ残る(`--disable-slash-commands` はそのまま)。session 中の定義の追加は Write が permission で拒まれ Bash は sandbox の stub(triage の実測)だが、CLI の
   再走査は測っていないので `Edit(<ws>/.claude/agents/**)` の deny を settings の deny と並べて置く(ADR 0037 機構2 の重ね方)。理由は hooks ではなく `permissionMode` —— 定義が床の軸に触る以上、CLAUDE.md や `@workspace`
   skill と同じ「model に届く文」ではない。ADR 0287 決定3 の「親の采配」は model の軸の決定で、矛盾しない。
3. **登録の門は checkout に `.claude/agents/*.md` があることを live-checkout 信号(#383)の1コードとして提示する。** tracked か否かも
   中身も読まない(決定2 で全部閉じるので)。`.claude/agents` は `SANDBOX_SHADOW_PATHS` にあり 0 バイトの file として残りうる(ADR 0069)
   ので、信号は `.md` を持つ dir にだけ立て、link は辿らない(#2935 の線)。定義があれば worker が使うと読むのが自然で、「使わない」は登録時に報せる側。
4. **ADR 0346 の「settings.json は workspace がその process に書き込める唯一の口」は誤りで、Status 追記で直す。** 決定1 の下で
   盤面が処遇を決めた checkout の口は、置き場所で隠す settings.json、`--strict-mcp-config` の `.mcp.json`、allowlist の skill、決定2 の
   subagent 定義、そして model に届く文としての CLAUDE.md である。vendor 自身が守る残りの path(`SANDBOX_SHADOW_PATHS`)のうち
   `.claude/output-styles` は ADR 0303 の flag pin、`.claude/workflows` は Workflow の deny、routines / scheduled_tasks / launch.json は
   `--tools` の既定拒否(ADR 0039)、`.claude/hooks` は隠した settings からしか参照されない。`.claude/commands` だけは Skill の allowlist
   が覆うか測っていないので派生 issue。

## 退けた形

- **名前の deny だけ(triage の推奨)** —— trust という付与を残して効き方1つを閉じる点修正。外部 include の承認が同じ付与から残る。
- **盤面1つに1つの config dir(`CODEX_HOME` の置き方)** —— CLI が書く `.claude.json` を session 間で共有し、trust が1度書かれれば次の
  spawn に残る。Claude は credentials を dir の外に残せるので持ち越す状態が無い。
- **vendor の untrusted posture を床にして他の閉じ方を外す** —— ADR 0346 の実測では未 trust の clone で `apiKeyHelper` が走った。
  trust の門は vendor が選んだものしか閉じない。
- **`--setting-sources ""`** —— CLAUDE.md と skill が道連れ(ADR 0037 測定3)。
- **checkout の subagent 定義を届け、`permissionMode` だけを見る** —— frontmatter の鍵の列を盤面が抱える(ADR 0346 が settings の鍵で退けた形)。

## 派生

- Status 追記: ADR 0346(「唯一の口」)、ADR 0287 決定3(射程は model の軸)。
- GLOSSARY: Subagent(checkout の定義は届かない)、床(worker の CLI process が読む host の per-checkout 状態)。
- Status 追記: ADR 0341(posture に env の半分)、ADR 0025 決定5(`[]` でも ping は撃つ)。posture の env の半分は、Board call の口が harness を知らない(ADR 0341 決定2)
  ので runner には置けず、`atNeutralCwd` と同じ形の wrapper が dir を作って消し、注文を組む側は worker-shaped のとき dir を型で必須に取って
  env に写すだけ(純粋のまま)。配線は `LiveCheckoutSignal` の union と WebUI の文言表。
- 観測は spawn env の宣言テスト(ADR 0287 決定5 の形)と、ADR 0037 の hook canary に agent frontmatter の行を足す形 —— 対照の行は
  使い捨ての `CLAUDE_CONFIG_DIR` に trust を seed して hook が走ることを示す(R1 の形)。skip の文は
  debug log にしか出ないので stream では観測しない。fresh な config dir で CLI の既定 model が変わる(opus → sonnet、実測)が、盤面は
  常に `--model` を pin するので効かない。
- Codex 側の対(checkout の `.codex/agents/*.toml` が worker に届くか、process に触る鍵があるか)は測っていないので派生 issue。
- 副産物: 403 の MCP を名前で needs-auth に記録するのは `.claude.json` なので、spawn ごと新規の dir ではその記録が次の spawn に残らない。
- 実装は `/to-spec` → `/to-tickets`。
