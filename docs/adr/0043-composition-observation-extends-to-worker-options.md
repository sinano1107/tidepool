# 合成の観測は worker options 層まで伸ばす — 「不在 = 実物を使う」と「不在 = 機能が切れる」は別の層である

issue #33 で決定。**ADR 0041 の「同種の穴の捜索」が `ClaudeWorkerOptions` を
『#172 の類ではない』と分類した箇所を、部分的に取り消す。**

## 0041 がそう分類できた理由と、それが今回崩れる理由

ADR 0041 はこう書いていた:

> **`ClaudeWorkerOptions` の `spawn` / `pty` / `enumerateSkills`**: #172 の類では
> ない。不在が意味するのは「機能が静かに切れる」ではなく「実物を使う」であり、
> テスト側が渡すのは実プロセスを差し替えるためである。

これは**当時の任意フィールドの顔ぶれについて**正しい。3つとも fake 注入 seam
(ADR 0027)であり、不在は「本番の姿」そのものだった。

issue #33 が足す `advisorDisabled`(判断8 のグローバル kill switch)は**その類では
ない**。これは機能そのもので、合成 root が渡し忘れたときの壊れ方は fail-open ——
緊急マスクが効かないまま、型検査も既存テストも盤面のどの画面も何も言わない。
advisor 側の障害でフリート全員を止めたいときに「止まらない」ことに気づくのは、
止めたかった事象が起きた後である。これは #172 の穴の形(**型が任意 × 値が機能そのもの
× 渡すのはテスト盤面だけ**)そのものが、`ServerOptions` の一段下で再演した姿である。

## 決定

**1. `ClaudeWorkerOptions` の口の一覧も合成側が持つ。** `buildWorkerOptions`
(`src/server-options.ts`)がリテラルを組み立て、`buildWorkerFactory` が registry の
有無で `LoggingWorker` と実 worker を分ける。`main.ts` に残るのはホストの副作用
(`mkdirSync(logDir)`)と env の読み取りだけで、`new ClaudeCodeWorker({...})` の
リテラルは main.ts から消える。ADR 0041 §1 と同じ理由 —— **リテラルごと出さなければ
意味がない**。一覧が main.ts に残ったままでは、テストが観測するのはテスト自身が
書いた複製でしかない。

**2. 網羅は実行時テストが見張り、除外一覧はテスト側に置く。**
`tests/server-options.test.ts` が `src/claude-worker.ts` から
`ClaudeWorkerOptions` の任意フィールドを読み直し、本番が組み立てたオブジェクトの
キーと突き合わせる。意図的な不在は `spawn` / `pty` / `enumerateSkills` の3つ
だけで、その一覧を `src` 側の定数にしないのは ADR 0041 §3 と同じ理由である ——
除外を1つ増やすことは「その口は本番で永久に立たない」という宣言であり、`src` の
1行で自動的に緑へ戻せる形にすると、その宣言が誰の目にも触れずに通る。

**3. 網羅に加えて、kill switch は値の往復も1本測る。** ADR 0041 §5 と同じ線:
キーが揃っていることと、そのキーに正しい値が刺さっていることは別の主張である。
`advisorDisabled` は真偽値1つなので取り違えても型は黙り、しかも壊れ方が
fail-open なので黙ったまま advisor が止まらなくなる。

## ADR 0041 §1 の文言について(訂正)

0041 §1 は「`main.ts` が渡すのは `BoardComposition`、すなわち**1つも
`ServerOptions` のキーを含まない**入力である」と書き、§4 はそれを「再演を
**構造的に**不可能にする」根拠にしていた。**これは文字通りには成立していない** ——
`BoardComposition` は `dbPath` / `port` / `mcpPort` / `credential` / `clock` /
`auditorName`、そして当時は `worker` を持っており、いずれも `ServerOptions` の
キーと同名同義である。

したがって「構造的に不可能」という保証には寄りかからない。実際に穴を塞いでいるのは
**実行時の突き合わせ**(0041 §2 と本 ADR §2)であって、入力の型の純度ではない。
本 ADR の変更は `worker` を `BoardComposition` から取り除くので重なりは1つ減るが、
残る6つは env 由来のスカラをそのまま運ぶ口であり、無理に別名を与えても綴りが2つに
なるだけで得が無い。0041 §1 / §4 のこの主張は「望ましい方向」として読み、保証としては
読まないこと。

## Considered options

- **0041 の分類のまま、`advisorDisabled` だけ渡し忘れないよう気をつける** —— #172 が
  まさにその状態で本番を1年近く走っていた。規律は観測ではない。
- **`advisorDisabled` を必須フィールドにする** —— `ClaudeWorkerOptions` を直接
  構築するテストが全件で無関係な真偽値を書く羽目になる(0041 が `watchdog` 必須化を
  却下したのと同じ形)。加えて他の任意フィールドには同じ手が使えないので、穴の
  **形**は残る。
- **kill switch を registry(agent.md)に置いて worker options 層を触らない** ——
  判断8 が registry を避けた理由に反する: これはエージェントの定義ではなく運用上の
  緊急マスクであり、「agent.md を1枚も触らずに全 advisor を止める」ことが存在理由
  そのものである。
- **kill switch を `ServerOptions` 経由にする** —— 0041 の既存の網羅にただ乗りできて
  安いが、値の行き先は worker であって server ではない。server が中身を一切見ない
  値を server の口として通すと、`ServerOptions` が「worker へ渡したい物置」に
  なり始める。穴を塞ぐために層の意味を薄める取引をしない。
