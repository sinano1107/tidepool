# 合成 root のオプション組み立ては観測可能で、渡さない口は宣言される: 「任意」は本番の不在の言い訳にならない

issue #172 で決定。`startServer` の `watchdog?: WatchdogConfig` は**本番で一度も渡されていなかった** — `main.ts` 全体で `watchdog` の出現回数は 0、Pi の稼働ビルドでも 0 で、実配線を持つのはテスト盤面(`tests/harness.ts`)だけだった。したがって #9 / #17 が設計した「リミット超過 → SIGTERM → 猶予 → SIGKILL → slot-release tree rule → tidepool 名義の failure question」の経路は、**発火する条件そのものが存在しなかった**。concurrency = 1(CONTEXT.md の Slot)なので、詰まったセッション1本で盤面全体が朝まで止まる。

穴の形は watchdog 固有ではない。**「型が任意 × 値が機能そのもの × 渡すのはテスト盤面だけ」**という三点が揃うと、型検査も既存テストも何も言わない。ServerOptions の任意フィールドは22個あり、この形はいつでも再発しうる。

## 決定

**1. 口の一覧を持つ場所は1つだけにし、それを合成 root の外へ出す。** `buildServerOptions`(`src/server-options.ts`)が `ServerOptions` の全キーを組み立て、`main.ts` は env とホストの副作用だけを引き受ける殻になる — `main.ts` が渡すのは `BoardComposition`、すなわち**1つも `ServerOptions` のキーを含まない**入力である。`main.ts` は top-level await のスクリプトで import した瞬間に盤面が起動するので、組み立てが向こうにある限り「本番がどの口を配線しているか」を**テストから観測する手段が無い**。関数へ出すことがその seam であり、**リテラルごと出さなければ意味がない** — 一覧が `main.ts` に残ったままの pass-through では、渡し忘れは型検査にしか映らない。ADR 0027 の線には触れない: server 境界の**上**にある合成の検査であって、境界の下に新しいテスト層を作る話ではない。

**2. 網羅は実行時テストが見張る。** `tests/server-options.test.ts` が `src/server.ts` から任意フィールドを読み直し、**本番が実際に組み立てたオブジェクト**のキーと突き合わせる。口を1つ落とせばその名前で落ちる。型でも同じことを試したが(全キー必須の写像型)、それが止められるのは「`main.ts` が渡し忘れる」形だけで、リテラルを移した後は**組み立て側の落とし忘れ**が残る — 型が届かないのはそこで、実行時の突き合わせだけが両方を覆う。

**3. 渡さない口の一覧はテスト側に置く。** 現在の唯一の項目は `authority`(issue #11 の盤面固定1本)で、ADR 0012 / issue #36 の `resolveAuthority` に置換済み — 両方渡せば後者が前者を覆う。この期待値を `src` 側の定数にしないのが要点である: 除外を1つ増やすことは「その口は本番で永久に立たない」という宣言であり、**#172 と同じ穴を開け直す行為**でもある。`src` の1行で自動的に緑へ戻せる形にすると、その宣言が誰の目にも触れずに通る。

**4. テストは合成 root 自身を観測する。** 「本番と同じ配線」と称して production の関数をテスト側から呼び直すのは、#172 を素通しさせた形そのものである(`tests/auth-token-file.test.ts` の `bootWithTokenFile` がその形 — `main.ts` が実際に `openHumanCredential` を呼んでいるかは何も検査していない)。テストが渡す入力に `ServerOptions` のキーが1つも無いのは、この再演を**構造的に**不可能にするためでもある。加えて `main.ts` が組み立てを経由していること・口の一覧が `main.ts` に戻っていないことをソーステキストで見る — import できない以上、そこが残る唯一の観測面である。呼び出しの**形**は主張しない(中間変数を挟むリファクタで赤くしない)。

## watchdog の値はコード定数に置く

`work` = 90分 / `review` = 45分 / `grace` = 60秒。`question` は**キーごと無い**(`Partial<Record<TaskType, number>>` は「書かない = 監視しない」でしか表現できず、人間の回答を待つタスクを時限で殺すのは端的に誤り)。

env に出さない理由は ADR 0037 と同じ軸である: **盤面の不変条件をホストごとの設定に委ねない。** 「唯一の slot が誰にも回収されずに握られたままにならない」は盤面の性質であって、`/etc/default/tidepool` の綴り次第で消えてよいものではない — 消え方は正確に #172 の再演(値が無い = 監視されない)になる。

値そのものの根拠:

- **`work` = 90分。** `/etc/default/tidepool` の `CLAUDE_STREAM_IDLE_TIMEOUT_MS` は 10分(#33 / anthropics/claude-code#69238 の回避)なので、byte-idle 由来のストールは CLI 側が拾う。拾えないのは**ループに入ったセッション** — バイトを出し続けるので idle 検知が効かず、watchdog だけが backstop になる。kill は失敗 question(retry / abandon)+ push に落ちる**回復可能**な事象なので、夜の8時間のうち最大90分の損失に抑える側へ倒す。
- **`grace` = 60秒 = 1 tick。** `WATCHDOG_TICK` が 60秒なので、それ未満の猶予は事実上1tick へ丸められる。**全ての値が分単位に量子化される**ことを前提に選ぶ。比較は `>=` なので SIGTERM の次の tick で SIGKILL が出る。

## 同種の穴の捜索(#172 やること4)

- **ServerOptions の任意22個**: 本番が渡していないのは `watchdog` と `authority` だけ。事前調査どおりで、実際に列挙して突き合わせた(`github` / `auditorName` は短縮記法なので素朴な grep では見落とす)。`authority` の意図的不在は doc コメントの主張どおり。
- **`ApiRouterDeps`(任意19)/ `McpDeps`(任意10)**: `server.ts` が全件を property として転送している。ここは合成 root ではなく `ServerOptions` から機械的に降りる層なので、穴の形が違う(渡し忘れは同じ1ファイルの中で完結する)。
- **インライン `deps: {...}` 型**: 名前付き interface だけを見ると見落とすので別途走査した。該当は `startScheduler`(任意6 — `workspace` / `resolveWorkspace` / `auditorName` / `github` / `fableAgents` / `containment`)と `startWatchdog`(任意2)と `pollNotifications`(任意1)で、いずれも `server.ts` が全件転送している。**この層は `ServerOptions` の下**なので、`buildServerOptions` が口を確保すれば穴は上から塞がる。
- **`ClaudeWorkerOptions` の `spawn` / `pty` / `enumerateSkills`**: **#172 の類ではない。** 不在が意味するのは「機能が静かに切れる」ではなく「実物を使う」であり、テスト側が渡すのは実プロセスを差し替えるためである(ADR 0027 の fake 注入の形)。`auditorName` / `workspacesDir` / `boardState` は `main.ts` が渡している。

## Considered options

- **`watchdog` を必須フィールドにする** — テスト盤面が全件で値を書く羽目になり、watchdog を主題にしないテストにまで無関係な数値が散る。加えて `ServerOptions` の他の21個には同じ手が使えない(不在が正当な口が実際にある)ので、穴の**形**は残る。
- **本番の起動を丸ごとテストで再現する** — ADR 0027 の線を越えて main.ts をサブプロセスで起こすことになり、実 CLI・実ポート・実 token ファイルを引き連れる。観測したいのは組み立てられたオブジェクト1つで、そこまでの装置は要らない。
- **リテラルは `main.ts` に残し、pass-through の関数と全キー必須の写像型だけ足す** — **一度これで実装し、レビューで却下した。** 型は「`main.ts` が渡し忘れる」形を確かに止めるが、口の一覧が `main.ts` に残るので、テストが観測するのは**テスト自身が書いた複製**でしかない。実際に組み立てを1行落として測ると、赤くなるのは `tsc` だけで全テストは緑のままだった — #172 が「テスト盤面だけが渡していた」ために気づかれなかったのと同じ構図が、一段ずれて再現する。
- **除外一覧を `src` 側の定数にしてテストがそれを読む** — 除外を1行増やすだけでテストが緑に戻る。その1行こそが #172 の再発形なので、期待値はテスト側に置く。
