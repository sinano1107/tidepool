# Codex App Server の Board call は呼び出しごとの空の cwd で走る

2026-10-06 の grilling(issue #1452、#733 の cwd 軸)で決定。preflight の `hooks/list` と使用量 probe が立てる `codex app-server`
は盤面プロセスの cwd を継承していた。worker とも、workspace を cwd にする隣の probe とも違う第3の面である。checkout が持つ
`.codex/hooks.json` について vendor が「trust せよ」の ERROR を出し、それに従うと project の hook が登録の列に混ざって完全一致が
崩れ、Codex が閉じる —— preflight の結論が「盤面をどこで起動したか」と「そこが trust されているか」に依っていた。実測表は
#1452 のコメントに置く。

## 決定

1. **`codex app-server` を立てる Board call は、呼び出しごとに作る空のディレクトリを cwd にし、終わったら消す。** worker は
   `--ignore-user-config` の下で project 層を常に空として走る(ADR 0147 末尾)。project 層が常に空で worker と揃うのは空の cwd
   だけである。Codex は空の cwd を `config.toml` に書き戻さず、`.git` の無い場所では親を遡らない(0.147.0、Linux で実測)。
2. **ADR 0147 決定1(fail-closed 向きのずれは許す)はこれを妨げない。** 0147 が塞がなかったのは、塞ぐ費用が専用 `CODEX_HOME`
   の複製だったからである。空の cwd は何も複製しない。0147 決定4 が許す「trusted な workspace の config が probe にだけ効く」
   は workspace を cwd にする probe の話で、ここでは動かない。
3. **範囲は App Server の口だけ。** workspace を cwd にする preflight の probe(`debug prompt-input` ほか)は workspace の層を
   観測するのが仕事なので動かさない。Claude 側の Board call は `--safe-mode` が checkout の customization(CLAUDE.md・
   skills・hooks・plugins・MCP)を落としており(settings の鍵は読まれる —— ADR 0044、auto-memory は #1482)、使用量 TUI は
   trust 済みの cwd を前提にするので、この決定に含めない。

## 退けた案

- **今のまま、手順書に「無害、trust しない」と書き添える** —— vendor の文面が運用者を Codex が閉じる操作へ誘導し続け、
  preflight の結論が起動場所に依るまま残る。
- **preflight の workspace を cwd にする** —— trust によるずれを workspace 側へ移すだけである。tidepool 自身を workspace に
  する試験では `.codex/hooks.json` があるので、workspace が trusted ならちょうどその場面で Codex が閉じる。workspace を cwd に
  する呼び出しは回収済み観測を待つ門(ADR 0136 決定5)にも入る。
- **盤面が固定の空ディレクトリを1つ持つ** —— 置き場の上に `.git` があると Codex が親を遡って project 層を読む。呼び出しごとの
  一時ディレクトリでも `config.toml` は太らない。
