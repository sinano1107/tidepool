# Harness の言語・出力様式の設定は盤面が固定する —— Board call は設定の層を1つも読まず、記録に残る欄は prompt が言語を名指す

2026-10-23 の triage(issue #2454)で決定。#2416 の確認で、英語の prompt・英語の入力に対する振り返り Board call の `evidence` が
日本語で返った。原因は host の `~/.claude/settings.json` の `language: "japanese"` で、`--safe-mode` の下でも user tier と
project tier の `language` が prompt に入ることを 2 版(pin 2.1.286 / 2.1.308)× control 付きで測った。worker の形
(`--setting-sources project`)では repo の `language` が 2.1.308 で入り pin では入らず、repo の `outputStyle` は両版で入る。
Codex は専用の `CODEX_HOME` と `--ignore-user-config` で既に閉じている(ADR 0147)。測定の表と `file:line` は #2454 のコメントに置く。

## 決定

1. **Board call は設定の層を1つも読まない。** 答えを取りに行く Board call は `--safe-mode` に `--setting-sources ""` を足し、
   user / project / local の全 tier を落とす。種類ごとに `language` を固定する案は採らない —— 翻訳と draft は表示言語で書き、
   それ以外は英語で書くので、vendor のキーに2系統で頼り、表示言語の正規値を CLI のキーの値へ写す箇所が要る。Board call は
   project tier から読むものが無い(worker と違い CLAUDE.md / skills を要しない)ので、全部落とすのが最も短い。host の user tier
   が運ぶ他のキー(`model` / `modelSettings` / `outputStyle` / `autoMode` など)も一緒に落ちるが、認証は credentials ファイル、
   model / effort は flag なので、Board call が失うものは無い。
2. **worker の per-task `--settings` に `language: "english"` と `outputStyle: "default"` を載せる。** worker は repo の CLAUDE.md と
   skills を読ませるため project tier を落とせない(ADR 0037 の測定 3)。この2キーは値が1つで flag tier が丸ごと置き換えるので、
   `AUTO_MEMORY_CLOSED`(ADR 0156)と同じ盤面の定数として載せ、tool-surface probe の inline `--settings` も同じ定数から作る。
   **拒否ではなく上書きにする** —— `FLOOR_DEFINING_KEYS`(`sandbox` / `permissions`)を拒否するのは値が merge されて flag tier で
   打ち消せないからで(ADR 0037)、置き換わるキーで問題のない repo を quarantine にする理由は無い。
3. **記録に残る自由記述の欄は、prompt が言語を名指す。** 設定を閉じても、入力の言語に引かれる経路は残る。帰責・配分評価の
   `evidence`、Behavior candidate の `path` / `title` は English を prompt に書く(`text` は書いてある)。翻訳と draft は表示言語の
   指定のまま。地の文の正準が英語である(ADR 0015)ことの、Board call 側の綴りである。
4. **版上げの適合試験(ADR 0186 決定7)に2面を足す。** `outputStyle` は init 行の `output_style` で決定的に、`language` は init 行に
   出ないので、neutral cwd の `.claude/settings.json` に `language: "japanese"` を置いて worker の形と Board call の形の1ターンで
   「応答言語の指示があれば引用、無ければ NONE」を訊き、`japanese` が含まれたら不合格にする。モデルに答えさせる判定は揺れるので
   1回の NONE を合格に読まず、回数は試験が固定する。Board call の形の試験は runner と同じフラグの定数から組む —— 手で写した
   フラグ列は runner に足した `--setting-sources ""` を測らない。

## 範囲外

- repo の CLAUDE.md / AGENTS.md が自由記述で言語を指示する場合。設定の ambient な漏れではなく repo 文書の内容で、自由記述から
  言語の指示だけを落とす機構は無い。tidepool 自身の文書にはその指示は無い。
- 行の probe・使用量の TUI・tool-surface probe の出力。モデルの散文を記録しない。

## Considered options

- **Board call も `language: "english"` を `--settings` で固定する** —— `english` の値は「Always respond in english」を入れることが
  あり、表示言語で書く翻訳と draft の出力と衝突する。決定1 の理由のとおり退ける。
- **`language` / `outputStyle` を持つ repo を `FLOOR_DEFINING_KEYS` で拒否する** —— 決定2 のとおり、置き換わるキーに拒否は過剰。
