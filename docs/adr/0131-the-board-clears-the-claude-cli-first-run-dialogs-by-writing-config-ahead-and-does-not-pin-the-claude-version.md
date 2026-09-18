# 盤面の Claude CLI の初回対話は盤面が config を先回りで書いて消し、Claude の版は pin しない

2026-09-18 の grilling(issue #682)で決定。`main` のインストーラで新規に作った Lima VM の盤面は、初回タスクを1本も
走らせなかった —— claude 2.1.273 は初回起動でテーマ選択(onboarding)を REPL より前に出すので、`/usage` の scrape
(ADR 0028)がパネルに届かず、anthropic が観測不能 → fail-closed → tako の全 entry 除外 → 恒久 `skipped` に畳まれた。
trust seed(#442 / ADR 0101 決定6)は folder-trust の門しか消さない。VM での実測(どの旗がどの門を消すか、
headless probe の envelope)は #682 のコメントに置く。

## 決定

1. **初回対話は、盤面が CLI の config(`~/.claude.json`)に旗を先回りで書いて消す。** 書き手は trust seed と同じ script
   で、役割は「盤面の Claude CLI が無人で REPL に到達するための config」に広がり、名前も trust を名乗らなくなる。
   インストーラ(毎 pass、冪等)と deploy-pi の手順が呼ぶ場所は変えない。既にある値は上書きしない。scrape が渡す
   `--settings` は settings 層(`tui` など)にしか効かず、config 層の旗には構造的に届かない。
2. **書く旗は観測で証明された門の分だけ。** 今日は onboarding 完了の旗1つ(と従来の trust)。fullscreen renderer の
   門は scrape の `--settings` の fullscreen 指定が既に消している(外すと門が戻る —— 実測)ので、予防で旗を足さない。
   新しい門は観測されたときに旗を足す。
3. **Claude の版は pin しない。** Codex の pin(ADR 0098 決定4、`codex-cli 0.147.0`)は App Server が experimental 境界で
   schema を推測しないための措置で、Claude の対話 TUI にはその理由が無い。pin は model alias の前進(ADR 0114)と修正の
   取り込みまで止め、代償が門1つより大きい。列挙漏れは pin ではなく可視化で受ける: scrape が REPL に届かないまま
   タイムアウトしたとき、盤面ログに画面の先頭を残す —— ADR 0028 の「fail-closed と可視化は不可分」の可視化側であり、
   今回それが欠けていて痕跡が cli-auth の1行しか無かった。
4. **観測不能の fail-closed(ADR 0028)は据え置く。** 「観測不能」と「観測できて上限」を分けるかは範囲外 —— データは
   既に別の行(Provider の観測状態と、窓の `throttled`)で、共通なのは pickup 除外という効果だけ。前提の変化は
   「観測不能が fresh install の既定になった」ことで、治し方は決定1 の観測性の回復である。
5. **Seed の語は registry の種まき(CONTEXT.md)に残す。** この script は seed を名乗らず、CONTEXT.md にも項を立てない
   —— 中身は vendor の TUI の門で、ドメインの語ではない。

## 退けた案

- **scrape 側の `--settings` で消す** —— settings 層と config 層は別で、onboarding の旗は後者にしか無い。
- **Lima の provision に書く** —— Pi の手順と二重になる。書く先は同じファイルで、呼び手は既に揃っている。
- **`fullscreenUpsellSeenCount` / `theme` も予防で書く** —— 観測されていない門の列挙で、決定2 の線に反する。
- **観測不能を「上限」と分けて pickup を通す** —— 守っているのは不可逆な予算(ADR 0028)で、その理由は変わっていない。
