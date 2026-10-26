# spawn 時の prompt は transcript の3本目として持ち主つきの部分の列で記録し、ベンチマークは session ごとに prompt と verb の往復を全文で出す

2026-10-26 の triage → grilling(issue #2554、spec #2439 / ADR 0298 の派生)で決定。走行の記録の抽出(#2440)は session の盤面 verb を名前
だけ写し、worker が受けた system prompt はどこにも残っていなかった —— `--append-system-prompt` / `developer_instructions` で渡すだけで、
transcript の `init` 行にも event にも無い。記録から再構成できるのは agent 定義・Authority・Roster まで(ADR 0291 決定2 の読み口)で、
doctrine / protocol の文は記録されない verb 集合(`taskVerbSwap`、spawn の時点で切らない)で変わり、注入した記憶の節は event を書く前に
本文を捨てている。実測(容量・再構成の可否の表・`file:line`)は #2554 のコメントに置く。

## 決定

1. **盤面は spawn ごとに、harness へ渡した prompt 一式を記録する。transcript の3本目である。** ファイルは `<task>.<worker_spawned の
   id>.prompt.json`、stream・stderr と同じ記録の器で、spawn の前に開き、書けなければ記録の器の停止(ADR 0266 決定3)に乗る。ADR 0149
   決定1 の「2本で1単位」は「3本で1単位」になる。ベンチマーク専用の切替は持たない —— 切替は測る盤面と製品を別物にし(ADR 0298 決定1、
   決定4 の4軸の外に5つ目を作る)、本番にも読み手がいる(帰責 judge —— ADR 0291 退けた案4 が「版の刻印が無い」と退けた文面の刻印が
   これになる)。容量は transcript の数 %〜数十 % で、切替を持つ代価に見合わない。
2. **形は持ち主つきの部分の列で、連結すると逐語に戻る。** `system` は `[{ part, text }]` の順序つき列、`text` は自分の区切り(先頭の空行や
   見出し)を含み、順に空文字で連結した値が harness へ渡した値と一致する。`part` の語彙は spawn が組む節と同じ: `definition`(`builtin` 旗と
   `registry_commit` / `definition_version` の写しを添える)・`authority`・`roster`・`doctrine`・`interview_discipline`・`protocol`・
   `historical_definition`・`memory`(spawn 注入の節)・`meta_review_material`(ADR 0180 の材料の節、meta-review の session だけ)。組まなかった節は列に置かない(空文字の部分を作らない)。`user` は1欄(Claude は固定文、Codex は task の題・目的・完了基準を埋めた user turn)。帰責 judge は
   部分の持ち主(本文・Authority・Roster、builtin なら environment)で cause を付けるので、逐語の塊だけでは読めない。Codex も同じ形で、
   `developer_instructions` の値と user turn を書く。CLI 本体の既定 system prompt は盤面が渡していないので含めない(`cli_version` で引く)。
3. **同じ dir の spawn の入力は「再生できるか」で transcript かどうかを分ける。** MCP 設定・sandbox 設定は code から再生できるので
   transcript ではない(従来どおり)。prompt は再生できないので transcript である。
4. **ベンチマークの走行の記録は session を単位に、受けた prompt と verb の往復を全文で出す。** `results/<run>/sessions/<task>.<spawned id>.md`
   を session ごとに書き、`record.json` の `sessions[]` の行がその相対 path を持つ。読み方は `summary.md` の課題の行 → `record.json` の
   session の行 → session のファイルの順。verb の引数と応答は transcript の JSON のまま、応答は worker が見た切れた本文のままで、
   切れの事実を抽出が隠さない。切れた応答は本文の末尾の英語の目印(ADR 0195 決定5)で見分ける。目印そのものが verb・返した bytes・予算を持つので、`response_truncated` event を呼び出しに結合しない(event は呼び出しの id を持たず、結合は順に頼ることになる)。出すのは盤面 verb(`mcp__tidepool__*`)の往復だけで、Bash / Read など他の tool の入出力は出さない(行動列は Episode の仕事)。task の下に session が並ぶので、issue 題の
   「task ごと」はそう読む —— 注入は session ごとに違い、task の prompt は定義できない。
5. **Episode は変えない。** 抽出は `projectEpisode` の verb 列(位置・`toolUseId`・failed)を使い、`toolUseId`(Codex は `item.id`)で同じ
   transcript 行から `tool_use.input` と `tool_result.content` を引く。行の解釈(2形式・3値)は Episode に1か所、本文の取り出しだけ id の結合。
6. **prompt の記録には盤面の DB と transcript の外の情報が無いので、抽出は開いてよい。** 部分の出所は registry の定義・authority・code の
   雛形・task の列・記憶の店で、token や env は載らない(ADR 0024)。秘密を含みうるのは引き続き `.stderr.log` だけで、抽出が開かない線(#2440)
   は変わらない。session のファイルに出る verb の応答も DB の内容で、同じ理由で全文を置ける。
7. **再構成の読み手は記録へ付け替え、再構成は消す(派生 issue)。** 帰責 judge(`agentDefinitionThen`)と self-RCA の証拠節
   (`historicalDefinitionSection`)の2つ。記録の無い session は無い(器が spawn を拒み、盤面は作り直す)ので fallback は持たない。
   ADR 0270 決定2 が self-RCA のために残す組み込みの旧本文の列も、そのときに評価し直す。盤面側の記録は初回走行 #2443 の前に着地する
   —— 後では初回の prompt が永久に失われる。

## 退けた案

- **再構成のみ(盤面 source を変えない、spec #2439 の Layout の文)** —— doctrine / protocol・記憶の節・self-RCA の節が戻らず、戻る部分にも
  組み込みの名簿が混ざる罠がある(派生 issue)。issue が改善したい「注入」の読みは、何を注入したか(id・版)ではなく、どう見えたか。
- **ベンチマーク時だけ記録する切替** —— 決定1 の理由。容量の心配に効くのは切替でなく置き場(次項)。
- **`worker_spawned` の隣の event に prompt を載せる** —— DB と、history や ADR 0195 の予算を読む全読み手に数 KB〜数十 KB が載る。
  ファイルなら盤面は読み返さず、`.stderr.log` と同じ「人間と抽出(と判事)だけが開く記録」になる。
- **逐語1欄(JSON 1文字列か Markdown 2節)** —— judge が持ち主で読めない。Markdown は節の区切りが prompt 本文と衝突する。
- **`EpisodeAction` に `input` / `result` の全文を足す** —— Precedent・meta-review など Episode の全読み手の形が変わる。
- **ベンチマークが transcript を自前で再解釈する** —— ADR 0083 追記2 の3値の解釈を2か所に持つ。
- **`record.json` に inline** —— 走行の記録が transcript の桁になり、課題の表を読む用途が重くなる。
- **応答の要約** —— verb ごとに残す欄を決める第2の `TOOL_ARGS` 表が要り、表に無い欄の不具合が見えない。読み手の目的は応答の形の改善。

## 帰結

- CONTEXT.md の Transcript の項(3本・再生できるかの線)とベンチマークの項(走行の記録の2層)。
- ADR 0149 決定1 は3本に(Status 追記)。ADR 0291 決定2 の再構成は決定7 の派生 issue で記録に置き換わる(Status 追記)。
- 派生 issue: 当時版の名簿に組み込みが混ざる罠(単独・high、初回走行の帰責の読みに先立つ)、読み手の付け替えと再構成の削除(high、本 issue に
  blocked-by)。
- 実装は盤面側(記録を書く)と抽出側(読む)の2面で、slice の数は `/to-spec` → `/to-tickets` で決める。
