# merge ダイヤルは3値必須 — `external` が盤面の外の merge を宣言し、正典の主張は盤面決裁の merge に狭まる

authority profile の `merge` だけが optional で、省略の意味が定義されていなかった(issue #235 の grilling、2026-08-14)。省略時の実挙動は「盤面は何もしない — PR は open のまま残り、merge は盤面の外で起きる」だが、これは設計された分岐ではなく宣言の空白の漏れであり、帰結として省略 profile では merge の記録が盤面に1つも残らず、CONTEXT.md の GitHub identity「判断の帰属は盤面の記録が正典」が成立していなかった。さらに grilling で判明した新事実として、盤面外の merge は省略 profile だけの現象ではない — `escalate` の merge question が開いている間に人間が GitHub 上で直接 merge すると、回答「merge」は merge 済み PR への merge 実行が失敗して question が座礁し、`auto_if_ci_green` の CI 待ち行に対しては poll の merge 実行が失敗し続けて無限リトライになる。

**決定1: `merge` は必須の3値にする — `escalate` / `auto_if_ci_green` / `external`。** 省略は不正。issue #41 が `assignable_to` / `allowed_workspaces` に引いた線(省略 = 意味を持つという footgun を作らない)をスキーマ全体に貫徹する。ダイヤルの意味は**人間の merge 判断がどの面に住むかの宣言**である: `escalate` は盤面の question 面(決定は decision log に残り、執行は盤面の GitHub 身元)、`auto_if_ci_green` は CI 緑を条件とした決裁権内(無人 merge)、`external` は盤面の外 — GitHub の PR 面のネイティブな統治(レビューUI・required reviews・merge queue、あるいは盤面の外の merge 権者)に委ねる。`escalate` との使い分けは実在する — tidepool 自身の開発がまさに `external` の姿(全 PR を人間が GitHub 上でレビューして merge し、盤面は問わない)であり、2値必須の世界ではこれらすべてに「既に自分で merge した後に回答する」question が立ってしまう。

**決定2: 正典の主張を狭める。** GitHub identity の「判断の帰属は盤面の記録が正典」は「**盤面が決裁を持つ** merge については」に狭まる。`external` の PR では判断も記録も GitHub の面に住み、それは漏れではなく宣言どおりの姿である。したがって `external` の PR は観測もしない — そこを監視し始めると宣言が空文になる。

**決定3: 盤面が決裁を持つ面に限る「点の観測」。** open な merge question と `auto_if_ci_green` の CI 待ち行の PR に限り、盤面の外で先に merge された事実を検出したら、**観測**として記録し question を決着 / 待ち行をクリアする(人間に無効な意思決定を見せない)。契機は3つで、周期は2面に分離する:

- **独自の遅い走査(10分程度)** — open な merge question の PR を読む。1枚も無ければネットワークに出ない(空なら0リクエスト)。人間の判断待ちに要る鮮度は人間スケールであり、CI の60秒周期で監視するのはレート的に過剰。
- **回答受理直前のバックストップ** — merge question への回答は、値(merge / hold)に依らず先に PR の merge 済みを検証し、merge 済みなら観測決着に変換して人間へその旨を返す(現状の DomainError 座礁を置換)。quarantine 回答の「確認を鵜呑みにせず検証してから受理する」と同じ既存パターン。
- **auto-merge poll の merge 失敗時の検査** — 既存の60秒 CI poll の発火条件(待ち行の非空)の**内側**で、merge 実行が失敗したら merge 済みかを見る(無限リトライの穴を塞ぐ)。60秒面は一切広げない。

走査は快適性のためだけの機構であり、正しさはバックストップが担う — 遅い周期を「直す」対象と誤読しないこと。

**決定4: 記録は執行と観測を区別して綴る。**「盤面が merge した」と「盤面外で merge されたのを観測した」は別の事実であり、区別が無いと狭めた正典の主張を記録から検証できない。綴り(別 event kind か観測マーカーか)は実装に委ねる。

**決定5: `external` は危険な値の列挙に加えない。** 既存の列挙は「無人の外向き効果を広げる向き」であり、`external` は盤面の無人動作をむしろゼロにし、merge には依然人間の行為が要る。

**決定6: 移行は registry 先行。** 必須化は省略 profile の解決を quarantine に落とすため、auditor.yaml に明示値を足す編集(optional のうちに足しても旧スキーマで valid)が、スキーマ必須化の**デプロイ**より先。値は `escalate` — 全禁止・迷ったら人間へ、という auditor profile の精神に一貫する(`external` は「記録なしでよい」の宣言になってしまう)。

Considered options:

- **optional のまま維持** — issue #41 が名指しした footgun をこのフィールドだけ温存する非一貫。
- **必須化 + 2値のみ**(「盤面が merge に関与しない」状態を認めない)— GitHub ネイティブの統治を registry で綴れなくなり、その運用の全 PR に事後 question のノイズが立つ。
- **全 open PR の常設監視** — `external` の宣言を空文にし、観測対象も際限がない。
- **表示時の同期検出** — question 一覧の読み取り(今日は DB のみ)が網の遅延・不達に人質になる(Pi のオフライン耐性)。
- **走査を60秒 CI poll に相乗り** — 発火条件が「待ち行の非空(CI の数分間)」から「open question の存在(人間の判断待ちの数時間〜数日)」へ時間スケールごと広がる。要求鮮度が人間スケールである以上、独自の遅い周期が正しい。

Consequences:

- 確認済みの不変条件2つは無傷: 保護 workspace への PR はダイヤルの値より先に評価される資源側の不変条件として常に人間が merge する。purely-local workspace では全状態が根拠を失い着地は常に merge question(ADR 0053 — 同 ADR の「省略は盤面外の merge 面を根拠として要求する」という言い回しは `external` に読み替える)。
- remote-backed workspace の fork 元はリモート側の保護ブランチなので(ADR 0052)、盤面の外の merge も次のタスクの起点に自然に含まれる — `external` は「盤面は merge を知らない」であって「古い main で作業する」ではない。
- スキーマ必須化を registry 編集より先にデプロイすると、auditor の解決が quarantine に落ちる(fail-closed であり静かな誤動作ではない)。
- CONTEXT.md: Merge ダイヤルの用語項を新設、GitHub identity の正典の主張を狭め、Workspace 節の「省略」を `external` に読み替え。
- 実装は issue #341(3値必須化)/ #342(点の観測)、registry 編集は issue #340(人間タスク)。
