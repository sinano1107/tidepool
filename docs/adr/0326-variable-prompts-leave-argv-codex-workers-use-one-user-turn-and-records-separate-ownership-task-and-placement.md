# 伸びる prompt は argv の外へ出し、Codex worker は1つの user turn にまとめ、記録は持ち主・task・配置を区別する

2026-10-29 の triage → grilling(issue #2692、spec #2691 の派生)で決定。Board call と worker が長い文面を argv の1引数で渡し、
Linux の引数長の制限で推論を始める前に落ちうる。固定版の受け口・profile の優先順位・設定の合成の実測は #2692 のコメントに置く。

## 決定

1. **伸びる prompt は argv に置かず、切らずに渡す。** 答えを取りに行く Board call の用途の prompt と、両 Harness の worker の
   user turn は標準入力に送り、送り終えたら EOF を送る。Board call の短い定数の system prompt(ADR 0296 決定6)は argv に残す。
   App Server の応答が揃うまで stdin を開けておく probe の契約は変えない。
2. **Claude worker の盤面の文は、system prompt への追記のまま file で渡す。** 読み込みに要る期間は session 専用の file を保ち、
   後始末は既存の session のライフサイクルに従う。保持する監査の正本は従来どおり prompt の記録である。
3. **Codex worker は盤面の文を先頭、task 固有の文面を末尾として区切り、1つの user turn にまとめる。** `developer_instructions` へ
   盤面の文を渡す形はやめる。CLI 自身の組み込み指示は置換せず、`--ignore-user-config`・`--ignore-rules` と既存の封じ込めを保つ。
   ADR 0124 決定1・2・4 の「両 Harness で上の層」「Codex は developer の層」「その層への到達を観測」はこの形に改める。
   文面の中身と持ち主は変わらず、sandbox・道具の閉鎖・盤面 verb の権限の門は文面の role とは独立して残る。
4. **prompt の記録は、持ち主つきの部分・task 固有の文面・実際の配置を区別して持つ。** 部分の語彙と出所の印は保ち、記録から CLI に
   渡した文を区切りも含め逐語に戻せる。Codex の user turn 全体を task 本文として扱わず、盤面の文を system 層に渡したとも記録しない。
   ADR 0313 決定2 の `system` / `user` の二分はこの契約に改める。判事の `task` と RCA 子の材料の親の文面(ADR 0320 / 0321)は、
   記録から task 固有の部分だけを読む。定義・Authority・Roster・盤面の文・注入した記憶の出所は配置に依らず保ち、記録から読む。

## 選んだ理由と退けた形

- **user turn への統合を選ぶ。** Codex だけ盤面の文の優先層が下がる代償は受け入れる。遵守率への影響は未測定であり、同等とは主張しない。
  層を揃えるために既存の設定の隔離を緩めることや、worker の対話プロトコルを移すことより、今回の欠陥に範囲を絞れる。
- **session ごとの profile** —— 長い developer 指示を file から渡せるが、`--ignore-user-config` が profile も落とす。外すと trusted project
  が盤面の developer 指示を上書きでき、追加の MCP 設定も合成される。既存の workspace 検査が保証していない設定面まで広げない。
- **App Server への移行** —— developer 指示を JSON-RPC で渡す口はあるが、worker の起動・通知・応答・終了の契約を移す仕事はここではしない。
- **組み込み指示の置換・専用の `CODEX_HOME`・argv の長さで拒む門** —— ベンダーの動作規則や共有状態を盤面が肩代わりせず、長い正当な入力も渡す。

実装と検証の契約は #2692 の Agent Brief。未実装の Codex の答えを取りに行く runner(#2417)も、決定1 の受け渡しに従う。
