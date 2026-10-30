# pickup の gate を抜けた資源の故障は観測点によらず資源に帰属し、0ターンで終わった session は資源の停止を先に登録して先頭へ戻る —— Worker MCP 到達性は Harness ごとの資源

2026-10-30 の grilling(issue #2700、族の根。member は #2701 / #2702 / #2703)で決定。pickup の gate は資源の可用性を**代理の述語**で見る(moonshot の鍵はファイルの存否、sandbox の proxy は `socat` の有無、盤面の Worker MCP は検査なし)のに対し、spawn と走行は**実使用**で見る(鍵を読んで空でない、proxy が起動する、init で接続する)。2つの述語の同一性を担保する構造は無く、gate を抜けた資源の故障は観測点ごとに別の記録(`spawn_failed` / 報告なき exit / watchdog の底)に落ち、どれも task 単位の failure question(retry 推奨)になる。資源は止まらないので retry が同じ故障を踏む。ADR 0118 決定4 の「決定的な失敗は gate が先に弾く二重防御であり、届いたら盤面のバグ」はこの同一性を前提にしていた。実測の表と `file:line` は #2700 のコメントに置く。

## 決定

1. **gate を抜けた資源の故障は、観測点によらず資源に帰属し、資源の停止(Quarantine か除外)を先に登録する。** ADR 0118 決定4 の2文目を置き換える。ADR 0274 決定1 が spawn の前に引いた線 ——「task に帰属しうるか資源に帰属するかの線で、観測点の数ではない」—— を spawn の後まで延ばす。残る「盤面のバグ」は資源の署名を持たない throw(fs / git の一過性の失敗)だけで、そちらは `spawn_failed` → failure question のまま。
2. **task 側は「ターンが走ったか」で分かれる。** root がモデルの応答を1つも出さずに終わった session(0ターン)は、資源の停止を登録したうえで failure question を立てず todo の先頭へ戻す(ADR 0274 / ADR 0184 決定4 の形)。ターンが走った session は ADR 0145 のまま —— 途中の成果がありうるので retry / abandon に判断価値があり、資源の question と2枚になる(ADR 0145 決定5)。2つの条件はどちらも必須で、資源の停止を登録せずに先頭へ戻すと毎 poll 同じ故障を黙って踏む。ADR 0145 決定1「走った時間では切らない」とは矛盾しない —— 切るのは時間ではなくターンの有無である。
3. **0ターンの exit を資源へ返す鍵は、記録から読める資源の署名である。** 今ある3本(401 → Provider 認証、404 → 行、cap)に、init 行の `mcp_servers[].status`、Codex の `required` な MCP の起動時 exit、Claude の `failIfUnavailable` の起動時 exit を足す(後2つの署名は member issue で実測)。署名を持たない0ターンの exit は資源を名指せないので ADR 0145 のまま —— fail-closed 側で、人間に届く。署名は transcript の行か exit の事実にあるものに限る(起動時の復旧が同じ読み手で読める形、ADR 0316 決定1)。
4. **既存の 401 と drift にも決定2 を当てる。** どちらも最初のターンの前に決着する(401 は最初の API 呼び出し、drift は init 行の強制回収)ので、資源の停止 + 先頭復帰、question 無し。ADR 0145 の退けた案が「今回は決めない」と保留した問いの答えである。session 途中の失効はターンが走っているので2枚のまま。
5. **spawn の前に実使用の読みが手元にある資源は、gate がその読みをそのまま使う(1つの関数)。** moonshot の「不在」(ADR 0116 決定4)は「鍵ファイル無し」から「読めて空でない鍵が無い」に改める。openai は ADR 0098 決定5 が `auth.json` の中身を読まないので存否のまま。`socat` は binary の有無までしか spawn 前に読めないので対象外。
6. **Claude の init 行の欠落側を観測し、`tidepool` が `failed` なら最初のターンの前に強制回収する。** 実測(CLI 2.1.314、pin 2.1.286 は未確認): 到達不能な URL を渡すと init 行に `{name:"tidepool", status:"failed"}` が載り、CLI は exit せず1ターン完走する。channel の無い worker は作業できても報告できず、watchdog の時間制限まで slot を握る。Codex の `mcp_servers.tidepool.required=true` はこの決定が根拠。`status` は server 名で振り分ける —— `tidepool` は決定7 の資源、代理 MCP(ADR 0327)の名前はそのサーバの故障(ADR 0327 決定7)。
7. **Worker MCP 到達性(Worker MCP reachability)を Quarantine の9種目の資源にする。単位は Harness ごと。** 封じ込め能力には入れない —— 封じ込めは「worker が閉じ込められているか」(安全)、到達性は「worker が盤面に報告できるか」(報告可能性)で、別の性質である。ADR 0039 決定3 が欠落側を外した理由(「盤面の MCP が落ちている」が封じ込めの不成立に化ける)はこの分離で消える。盤面全体にしないのは、経路が Harness の sandbox の loopback 許可と CLI の MCP client で決まり、止められるより狭い資源が存在するから。listener は盤面と同じ process なので、両 Harness が同時に止まるのは同じ原因で止まった集積(封じ込め能力と同じ読み)。
8. **解放の検証は受理時だけの実接続 probe。** 盤面が持つ probe 名義の固定の `--mcp-config` でその Harness の sandbox から listener へ繋ぎ、init 行の `status`(Codex は起動の成否)を読む。MCP router に probe の帰属を受ける扉が1つ要る。ADR 0108 決定3 が probe に `--mcp-config` を運ばせなかったのは「task 単位の生成物」だからで、probe 名義の固定設定はその線の外。起動時と pickup ごとには撃たない —— 実 session の init 行が毎 spawn 観測しており、封じ込めの正本が pickup ごとに撃つのは実 session では手遅れになる安全の問いだからである。
9. **spawn 後の0ターン復帰は新しい1つの event kind を刻む**(`ResourceStop` の payload + `worker_spawned_event_id`)。`pickup_stopped` は流用しない —— 後始末の導出が「process を持たなかった」と読み(ADR 0274 決定3)、task ブランチに用意済みの checkout に退避・tree rule・休止位置を当てなくなる。

## 退けた案

- **0ターンの exit を一律に先頭へ(資源の停止なし)** —— 毎 poll 同じ故障を黙って踏む。今より悪い。
- **資源の停止 + failure question の2枚を0ターンにも残す(ADR 0145 決定5 のまま)** —— 判断の無い question が立つ。ADR 0274 が spawn 前で退けた形。
- **Worker MCP 到達性を Harness の封じ込め能力の6つ目の問いにする** —— 封じ込めに問題が無いのに「封じ込め不成立」が立ち、listener が別ホストへ動けば(ADR 0327 の host relay の延長)到達性は封じ込めの性質ですらなくなる。
- **盤面全体の停止(ADR 0266 の形)** —— 別 Harness の worker まで止める。
- **空鍵を spawn に通して 401 で失効にする** —— 1 spawn 分のトークンと「置いていない鍵を壊れたと言う」文面を払う。

## 帰結

- #2703(proxy 起動失敗)の資源はその Harness の封じ込め能力(gate の `socat` と同じ)。観測点は実測後に member issue が決める —— 起動時 exit なら決定3 の署名、egress 無しで走るなら署名が無い限り観測できず、別の問い(ADR 0072 の形)になる。
- Codex の `required=true` が本当に起動時 exit かは未実測。走り続けるなら Codex 側の観測点は #2701 が決める。
- 再起動を跨いだ0ターンの exit は、復旧が分類を撃ち直さない(401 / 404 も同じ)ので署名なし側に落ちる。既存の非対称で、ここでは変えない。
- 学習器・配分評価は0ターンの session を分母に入れない(404 の既存規則)。pin の子(Interview の受験者)が資源の停止に当たれば skipped の待ちで、`target_refused` ではない —— 資源は回復する。
- session 途中の MCP 不通は verb の失敗 → escalate か報告なき exit で ADR 0145 のまま。
- spec #2710 の代理 MCP の故障は決定6 の振り分けに乗る。
