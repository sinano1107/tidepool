# 盤面呼び出しは advisor を持たない —— 不在はホスト設定に委ねず、呼び出しごとに明示する

issue #174 で決定。ADR 0042 / 0043 が worker session の advisor を扱ったのに続いて、
**盤面自身の CLI 呼び出し(Board call)側の線**を引く。

## なぜこれが #33 で落ちたか

#33 のスコープは「**worker の** advisor capability」だった。盤面が自分の機能のために
回す呼び出し —— AI 下書き(issue #12 / #25)、表示時翻訳(issue #47 / ADR 0015)、
skill 列挙とツール面 probe(ADR 0025 / 0039)、使用量スクレイプ(ADR 0028) —— は
worker session ではないので、そのスコープから素直に落ちた。

落ちた原因は判断の誤りではなく、**指す語が無かったこと**である。CONTEXT.md は
`Worker session` を持っていたが、その対概念に名前が無く、「worker session ではない
claude 呼び出し」は誰の担当でもない空白だった。本 ADR と同時に `Board call`
(盤面呼び出し)を用語集へ足すのはそのためで、次に同種のスコープを切る人が同じ
空白に落ちないことが狙いである。

#33 は `pinnedModelFlags` に `--advisor` を入れない線を引いたが(`advisorSpawnFlags`
の doc コメント)、それは「盤面の呼び出しに advisor を**足さない**」だけであり、
「ホストから**入ってこない**」ことは一切保証していなかった。

## 実測(2026-08-04 / claude 2.1.221 / 開発 Mac)

ホストの `~/.claude/settings.json` に `"advisorModel": "opus"` が実在する状態で、
**本番と同じフラグ形**に「advisor server tool があるなら1回呼べ」という同一プロンプト
を撃った。`--advisor` はどのセルでも渡していない(継承だけを見るため)。

| 経路 | 形 | advisor | `modelUsage` | cost |
|---|---|---|---|---|
| AI 下書き | `-p` / sonnet・medium / `--max-turns 1` / `--safe-mode` | **発火** | haiku, sonnet, **opus** | $0.22105 |
| 表示時翻訳 | `-p` / haiku・low / `--max-turns 1` / `--safe-mode` | **発火** | haiku, **opus** | $0.18622 |
| skill 列挙 / ツール面 probe | `-p /usage` / haiku | 乗らない | (空) | $0 |
| 使用量スクレイプ | PTY 対話・人間プロンプトを送らない | 未実測(同構造) | — | — |

加えて逆向きに1本 —— 決定4 の前提を測るため、**env と `--advisor` フラグを同時に**渡した:

| セル | env | フラグ | 結果 | `modelUsage` | cost |
|---|---|---|---|---|---|
| 優先順位 | `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` | `--advisor opus` | `ADVISOR_MISSING` | sonnet のみ | $0.06662 |

この表が本 ADR の本体である。読むべき点は4つ。

**1. `--safe-mode` は advisor を塞がない。** 下書きと翻訳は両方 `--safe-mode` を
渡しており、その doc コメントは「盤面リポジトリの CLAUDE.md / skills / MCP 設定が
漏れ込むのを防ぐ」と説明していた。advisor はその網に掛からない。`--max-turns 1` も
塞がない —— advisor の相談はターンを消費せず、`num_turns: 1` のまま opus が焼ける。

**2. main が haiku でも継承する。** 「上位モデルへの相談」という語感から haiku 経路は
対象外に見えるが、実際には haiku main + opus advisor が成立する。

**3. `-p /usage` にモデルターンは立たない。** 合成 assistant メッセージ
(`"model":"<synthetic>"`・0トークン)が1本出るだけで `num_turns: 0`・cost 0・
`modelUsage` は空。したがって skill 列挙とツール面 probe は現時点で advisor を
焼いていない —— **ただしそれは advisor のために置かれた性質ではない**(後述)。

**4. env は明示の `--advisor` フラグに勝つ。** 両方を同時に渡したセッションで
advisor はツール面に現れず(モデルは探しに行って空振りし、1ターンを浪費した)、
`modelUsage` に上位モデルは載らなかった。これは決定4 の前提そのものであり、
測るまでは「明示フラグのほうが強い」可能性が残っていた —— そちらなら決定4 は
存在しない危険を根拠にした死にコードになっていた。同時に、`TIDEPOOL_DISABLE_ADVISOR`
(ADR 0043 の kill switch)が同じ env を通って worker に届くことの裏づけでもある:
kill switch は registry の宣言を確実に上書きできる。

## 決定

**1. すべての Board call が「advisor 無し」を呼び出しごとに明示的に宣言する。**
実測で焼いていた2本だけでなく、`/usage` ping の2本と PTY の1本も含めた全5本。
`/usage` ping が今日 advisor を焼いていないのは「モデルターンが立たない」という
**別の目的で成立している性質**であり、ベンダーが `/usage` の描画をモデル経由に
変えた日に黙って反転する。同じ理由で、ツール面 probe が `--setting-sources project`
と neutral cwd によって user tier / project tier の両方から守られていることにも
寄りかからない —— どちらも ADR 0039 の測定のために置かれたフラグであって、advisor の
ためではない。**別の目的で渡したフラグの副作用としての不在は、不在の綴りとして
認めない。** これは #33 が `advisorSpawnFlags` の doc コメントで worker 側に引いた線
(「absence is spelled as an explicit no」)を、そのまま盤面側へ延長したものである。

**2. 綴りは env(`CLAUDE_CODE_DISABLE_ADVISOR_TOOL`)であって `--setting-sources` では
ない。** `--setting-sources project` は user tier の継承を塞ぐ(#33 実測)が、skill 列挙
には**使えない** —— skill 列挙の目的は user tier まで含めた解決済み skill 集合を CLI
自身に報告させることであり(ADR 0025 point 4、CONTEXT.md の Skill allowlist が言う
`@host` = ハーネス同梱の skill 全部)、設定源を絞ると測っている集合そのものが壊れる。
一方 env は設定源の解決を1つも動かさず、閉じたい能力だけを閉じる。ここでフラグ案を
採ると「盤面呼び出しは advisor を持たない」という1つの不変条件が経路ごとに2つの綴りを
持つことになり、6本目を足す人がどちらを選ぶべきか分からなくなる。

**3. env は process 境界の seam を通って渡され、引数は必須である。** `ExecFn` は
`(command, args, env)`、`PtyFn` の `opts` は `{ cwd, cols, rows, env }` へ広げる
(`SpawnFn` は既に `opts.env` を持っており、揃える先はその形)。理由は2つ。

- **観測できること。** seam の内側で立てるとテストからは見えない —— fake に差し替えた
  瞬間に消えるコードは、ADR 0027 の「サーバー境界で止める」テスト観の下では
  何も主張していないのと同じである。完了基準が要求するのは「注入した fake が
  受け取った env」であり、それは seam が env を運んで初めて書ける。
- **省略を不正にすること。** 任意引数にすると「省略 = ホストの env を丸ごと継承」が
  既定になり、6本目の Board call を書く人が書き忘れた瞬間に本 issue が黙って再発する。
  必須にすればコンパイラがその人に問う。Skill allowlist が「省略 = 無制限という
  footgun を作らない」として省略を不正にしたのと同じ判断である。**問うのは本番の
  呼び出し側だけである** —— TypeScript は引数の少ない関数を多い型の位置に許すので、
  `env` を受け取らない既存の fake は全件そのまま型検査を通る(通ってよい。30箇所の
  機械的な書き換えに意味は無い)。したがって「fake が env を無視している」ことは
  コンパイラではなくレビューが見る残余であり、#174 が実際に住んでいた本番側だけが
  機械に守られる。

観測の網にも同じ種類の残余が1つある。5本のうち **seam で観測されるのは4本**
(下書き・翻訳が `ExecFn`、使用量スクレイプが `PtyFn`、worker spawn が `SpawnFn`)で、
`/usage` ping の2本は注入 seam が probe 全体を差し替える高さにあるため、
`initPingSpawnOptions` という**名前を与えた純粋関数**を検査している。残るのは
`nodeSpawn(..., initPingSpawnOptions(cwd))` の1行の配線で、これはレビューが見る ——
`SKILL_ENUM_ARGS` 自体が今日置かれているのと同じ場所である。ping のためだけに
spawn 層へ seam を1枚下ろす取引はしない(ADR 0027 が引いた「vendor recipe は
seam の内側」の線を、advisor 1件のために動かすことになる)。

**盤面プロセスの `process.env` に立てる案は採らない** —— worker spawn は
`{ ...process.env, ... }` で env を組むため、advisor を持つはずの全 worker が
黙って advisor を失い、`worker_spawned` は advisor 名を記録し続ける。#33 が
instrument したその帰属が、まさに壊れる。

**4. 鏡像の穴も同時に塞ぐ: worker spawn は advisor がある場合に env を積極的に
消す。** 従来の `workerSpawnEnv` は advisor 不在時に env を**足す**だけで、
存在時に**消して**いなかった。ホスト側(例: `/etc/default/tidepool` —— 盤面プロセスの
env に直接流れ込み、人間が編集する生きた面である)に
`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` が1行あれば、registry が advisor を宣言し
記録も advisor 名を書いたまま、相談が1回も走らない盤面ができあがる —— env が
明示の `--advisor` フラグに勝つことは実測済みである(上表)。#174 と同じ
「ホスト設定1行で静かに壊れ、計器が無い」構造の、向きだけ逆の穴である。盤面には
既に**記録される** kill switch(`TIDEPOOL_DISABLE_ADVISOR` / ADR 0043)があるので、
ホスト env 経由の停止は同じことをする観測されない二本目の口でしかない。有効・無効の
正本は registry と kill switch だけ、という線を env の削除で執行する。

**5. 盤面呼び出し側に advisor の計器は作らない。** #33 が worker に計器を置いたのは
そこに advisor が**正当に付きうる**からであり、付いてよい場所でのみ「宣言どおりに
付いたか・実際に走ったか」が観測すべき事実になる。本 ADR の後、盤面呼び出しに
advisor が付く状態は構造的に存在しない。存在しえない状態の計器は読まれないまま
維持コストだけを払う。事実を運ぶのは seam の env を見るテストであり、そちらは
壊れた瞬間に赤くなる。封じ込め能力(ADR 0039)に4つ目の問いとして足す筋でもない ——
能力検査が問うのはホストごとに答えが変わる事柄で、ここで渡す env は盤面のコードが
自分で決める値だからである。

## Considered options

- **何もせず、ホスト設定の運用規約にする** —— 本番 Pi の `~/.claude/settings.json` に
  `advisorModel` は無い(#33 実測)ので今日の実害はゼロに見える。しかし規約は機械では
  なく、開発 Mac では**現に焼けている**ことが実測された。加えてホストの1行が盤面の
  費用を静かに変える状態そのものが、ADR 0005 の「ホストの最後の選択が run に漏れて
  はならない」で既に拒んだ形である。
- **3経路に `--setting-sources project` を足す(issue の選択肢1)** —— 決定2 のとおり
  skill 列挙で使えない。issue はここを「慎重に測る必要がある」と留保していたが、
  ADR 0025 / 0038 / issue #151 で既に測って結論が出ていた。
- **`/usage` ping と PTY を「モデルターンが立たないので対象外」とする** —— 決定1 の
  とおり、ベンダーの描画実装についての推論に不変条件を預けることになる。実測($0)で
  今日の姿は確認したが、確認したのは今日の姿であって保証ではない。
- **`--safe-mode` に任せる** —— 実測で否定された(表の1行目・2行目)。この案は
  「既に `--safe-mode` を渡しているのだからこの env は冗長だ」という形で**将来
  再提案される**ことがほぼ確実であり、上の測定表はそれを止めるために残されている。
