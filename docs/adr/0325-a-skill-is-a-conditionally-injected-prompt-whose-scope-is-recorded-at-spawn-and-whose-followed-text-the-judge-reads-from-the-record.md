# skill は条件付きで注入される prompt であり、scope は spawn 時の記録と worker 自身の報告から引き、従った文面は transcript の投影から判事が読む

2026-10-29 の triage → grilling(issue #2682、ADR 0324 帰結の派生)で決定。帰責の判事の prompt は「harness 同梱の skill に従った
外れは `environment`、workspace の skill は `workspace_document`」と分けるが、どの skill がどちらかを言う事実は判事に届かず、停止の
判事の行動列も `Skill` の引数を落としていた(`tool: "Skill", args: null`)。盤面は spawn 時に scope を解いて deny に折り込むだけで
記録せず、判事は decision log の名前から推測していた。今の registry はどの agent も `@workspace` しか許さないので事例は起きないが、
allowlist の1行で生きる経路に盤面側の門は無く、記録を書く自律の機構の欠陥として観測を待たない。実測(固定版 2.1.286 の列挙と
注入の形)・`file:line`・読み手の表は #2682 のコメントに置く。

## 決定

1. **skill は文書ではなく、worker が呼んだときに注入される prompt である。** agent 定義・盤面の文と同じ種類の「従った文面」で、違うのは
   注入の契機(spawn でなく呼び出し)と持ち主(workspace か harness のベンダー)だけ。cause の語彙は変えない —— `@workspace` の skill は
   `workspace_document`、harness 同梱の skill は `environment`(ADR 0291 決定3・4)。ADR 0291 が skill を AGENTS.md / README と並べた
   「文書」の語はこの読みに改める。
2. **scope の事実は2つの記録から引く。** 盤面の判断は `worker_spawned` に —— workspace の checkout が運ぶ skill の集合(scan、scope 語の
   有無に関わらず Claude の spawn 全部で取る)と、許可した集合(`*` は「全部」、`[]` は空)。worker が見た集合は worker 自身が transcript の
   `init` 行に報告したもので、Episode がそれを持つ。判事の入力の `skills` は「見た ∩ 許可した」を workspace の集合で `workspace` / `host`
   に分けた値で、投影できない session(transcript が無い・読めない)は null。盤面が spawn 時に列挙した集合は使わない —— 列挙は deny のために user 層まで含めて
   解決させており(ADR 0044 追記2)、worker が見ていない名前が混ざる。
3. **従った skill の文面は、transcript に逐語で残る注入の行を Episode が指し、判事が読む。** Claude の harness は skill の本文を
   `Skill` の結果とは別の合成 user 行で worker に渡し、その行は transcript にある(実測は #2682)。Episode は skill の呼び出しごとに
   名前・行動列の位置・その行の transcript 参照を持ち、本文は写さず正本の transcript から読む(ADR 0083 追記「派生は薄く、原文は
   transcript」)。判事の入力 `skills_followed` は停止では session 全部、異議では異議された判断より前の呼び出し(`memory_read` と同じ線)、
   判断の位置が置けなければ session の呼び出しを全部渡して「位置不明」と告げ、Episode が無ければ null、transcript が読めなければ本文だけ null。
   self RCA の spawn にも同じ出所で注入する —— 当時の agent 定義の節と同じ anchor で、判断を形作った文面を本人が証拠として読む
   (ADR 0020 決定3、独立監査には注入しない)。判事の prompt は `board_text` と同じ型で言う —— 文面どおりに従った
   外れは `skills.host` なら `environment`、`skills.workspace` なら `workspace_document`、読み違えは `capability`。名指しの門は置かない
   (ADR 0291 決定3 のまま)。
4. **線: 記録が逐語で持つ注入文だけ判事に渡す。** AGENTS.md / CLAUDE.md は harness が system prompt に入れ transcript に無いので、
   引用から名指すまま(ADR 0291 決定3)。本文を盤面が写して持つ形(記憶・agent 定義と同じ入力)は採らない —— workspace の本文は
   checkout の git に、harness 同梱の本文はベンダーの版にあり、transcript の行がその版の刻印である。版が上がって skill が消えても、
   当時の文面は記録から読める。
5. **異議の判事は、帰責のたびに transcript をその時点まで読んでその場で投影する。** 異議は triage の commit で同期に帰責され(ADR 0115
   決定2)、異議された行は走っている session のものが流し読みの最前列にある(ADR 0049)。その session の Episode はまだ投影されていないが、
   判断より前の行は transcript に書かれており、投影は純関数なので走行中でも終了後でも同じ読み口で組める。書きかけの末尾の行は投影が
   読めない行として数えて捨て、それは判断より後の行である。停止の判事は session が閉じてから撃つので保存済みの Episode を読む
   (ADR 0310 決定2・3)。ADR 0166 決定2「transcript の結合に依らない」はこの2つで曲がり、transcript が無い session でも判定は撃つ。
6. **Codex は集合も呼び出しも空。** Codex worker は skill を全部閉じている(ADR 0259 決定2、allowlist の翻訳は v1 の範囲外 —— #195 の
   契約「skill 0件」を ADR 0116 が経路の能力表に写した)。翻訳を作る issue は派生で立て、記録の形は harness 中立のまま。

## 退けた形

- **scope の事実だけ記録し本文は渡さない** —— 判事は「文面どおりか読み違えか」を引けず、worker の自己申告を信じるしかない。
- **spawn 時に列挙した集合を記録する** —— `*` の spawn に ping を足すことになり、user 層の名前も混ざる。見た集合は worker の報告にある。
- **注入行の `Base directory` の path で scope を判定する** —— ベンダーの綴り(`bundled-skills/<版>/<hash>/`)で、綴りは門にしない(ADR 0083 追記2)。
- **skill の本文を Episode に写す** —— transcript が正本で、写しは容量だけ増える。
- **走行中の session の行を triage に出さない / 異議を打たせない** —— 未読カーソルは前進のみの高水位マークで、飛ばした行は異議の機会ごと消える(ADR 0049 の退けた形)。
- **走行中の session の異議の帰責を終了まで遅らせる** —— commit で帰責して RCA を決める順(ADR 0115 決定2)を異議の側だけ sweep に移すことになる。判断より前の事実は commit の時点で transcript にある。
- **走行中は null で受けて第2回で確定させる** —— skill に従った判断が毎回 `uncertain` に倒れ、RCA を1回払う。
