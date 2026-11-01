# 盤面は workspace の settings の中身を読まず置き場所で決める —— Git 共有された settings.json は常に隠し、共有されていない settings は存在で止める

2026-11-02 の grilling(issue #2846、#2809 のレビューの派生)で決定。#2846 / #2885 の実測(固定版 2.1.286、Lima VM)で、
`apiKeyHelper` や `env.ANTHROPIC_BASE_URL` だけを持つ commit 済みの `.claude/settings.json` が列挙 ping と worker の CLI process に
届き、helper がホスト上・sandbox の外で盤面の権限で走り、`env` が worker の資格情報を workspace の宛先へ運んだ。
`workspaceSettingsDisposition` は `sandbox` / `permissions` / `hooks` / 壊れた JSON の列挙(denylist)で隠す・止めるを決めていて、
列に無い鍵は届く。この列は決定ではなく、ADR 0037 追記(#382)の契機「hooks か床キーを持つとき」を ADR 0158 が引き継いだ写しで、
「列に無い鍵は worker に届けてよい」と決めた ADR は無い。床(sandbox profile)が縛るのは worker の Bash だけで CLI process 自身に
床は無く、settings.json は workspace がその process に書き込める唯一の口である。盤面の他の面(`--tools`、egress、
`--strict-mcp-config`)は既定閉で、ここだけが既定開だった。実測の表は #2846 / #2885 のコメントに置く。

## 決定

1. **盤面は worker の形で走る process(worker 本体、workspace cwd の列挙 ping)に、workspace の settings の中身を1鍵も届けない。**
   盤面が worker に欲しい鍵は全部 flag 層に自分で載せている(ADR 0033 / 0035 / 0037 / 0156 / 0303)。
2. **判定は置き場所だけで、中身は読まない。** Git 共有された `.claude/settings.json` は中身を問わず worker session 中だけ隠す
   (ADR 0158 の題のとおり —— 決定1 の条件を廃止)。`settings.local.json` と untracked な `settings.json` は存在するだけで
   (claude-code, workspace) の組を止める(ADR 0158 決定2 の条件を廃止)。読めないファイルは従来どおり止める。
   `FLOOR_DEFINING_KEYS` と `hooks` の検査、JSON parse、隠された tracked の index 読みは disposition から消える。
3. **settings の JSON を読むのは登録の門の `claude_settings_hooks` 信号(#383 / #1005)だけ。** 信号の線(hooks だけの tracked に
   限る)は変えない。
4. **ADR 0303 決定2(`language` / `outputStyle` を持つ repo を拒まない)は tracked に残る** —— 隠されるので拒まれない。untracked の
   同じファイルは置き場所で止まる。釘(`tests/sandbox-settings.test.ts` の「拒否しない」、`tests/git.test.ts` の部分 clone の
   index 読み)は書き換える。

## 退けた案

- **helper と `env` を列に足す / 許す鍵の allowlist に反転する**(#2846 の triage の Q1 / Q2)—— どちらも vendor の schema の列を
  抱え、次の鍵で同じ形が再発する。allowlist は untracked だけ中身を読む非対称を残す。
- **`--setting-sources ""` で project 層を落とす** —— CLAUDE.md と skills が道連れ(ADR 0037 測定3)、2.1.220 では `sandbox` の
  merge を止められなかった(ADR 0033)。
- **flag 層の `--settings` で鍵ごと打ち消す** —— 列挙と同じ形で、列挙 ping に `--settings` を足すので ADR 0341 決定3 を開き直す。

## 帰結

- ADR 0293 の隠し / 戻しが例外経路から共通経路になる(tracked な settings.json を持つ repo はすべて通る)。戻しの失敗(#2471)の
  重みはそのぶん上がる。
- ADR 0037 の床キー guard(「深層防御として残す」)は退役する —— 置き場所での隠し / 止めがその上位互換。
- `claudeWorkspaceContainment` の理由文は置き場所の語で書く。
- #2885(`env`)と #2847(コメントの食い違い)は同じ変更で閉じる。
