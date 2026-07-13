# Issue-backed task は内容を live 参照で持つ — 登録時 snapshot ではなく

精緻に書かれた GitHub issue をタスクとして盤面に流すにあたり、登録時に issue の内容をタスクへコピーする案(snapshot)を退け、盤面には参照(workspace 名 + issue 番号)だけを保存し、内容(title / purpose / completion_criteria)は使用の瞬間 — spawn と UI 表示 — に issue から展開すると決めた(2026-07-13 の grilling)。「issue」はタイトル + 本文 + 全コメントのスレッド全体を指す。

根拠: source of truth を GitHub 一本に保つため。登録後に issue を磨けば pickup の瞬間に最新の内容が worker へ届き、コメント1本で追加指示が渡る。snapshot 型は登録時のコピペを省くだけで、「issue を直したのに盤面が古い」という二重管理を生む。登録ゲートの不足サジェストも人間の承認を経て issue のコメントへ追記する(盤面側に補足を持たない)のは同じ理由。

帰結のうち非自明なもの:

- **workspace の焼き込み**: 通常タスクの workspace は「使用時に解決される参照」(ADR 0009)だが、issue-backed task に限り登録時必須・確定値。issue 番号は repo とセットで初めて内容を同定するため、ここでの workspace は実行場所ではなく内容の同一性を担う — 既定 workspace の差し替えで別リポジトリの同番号 issue に黙って化けることを許さない。
- **live 参照の失敗経路**: 一時的失敗(ネットワーク・GitHub 障害)はそのサイクルの pickup skip(Throttle と同じ fail-closed の環境事象)、確定的失敗(not found・close 済み)は retry / abandon の failure question(Watchdog と同じ形)に落ちる。既存の2姿勢に写しただけで、新しい停止機構は増やしていない。
- **登録ゲートは不変条件ではない**: 「3要素を見いだせるか」の LLM 検査は登録時の一度きりで、登録後の issue 編集による劣化は防がない(Assignee の「登録時に検査、spawn 時に解決」と同型)。
- **完了の逆方向は GitHub ネイティブ**: PR 本文への `Closes #N` 自動付与だけで、盤面が issue を close する書き込み経路は持たない。PR を伴わない完了と cancel は issue に触れない。
