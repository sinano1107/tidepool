# Worker session は盤面が作る容器の中で生き、slot 解放は回収済み観測を待つ

2026-08-24 の grilling(issue #459)で決定。#195 のスパイクで、watchdog の force stop が CLI root だけを終了し子孫 process の回収を保証していないことが判明した。これは Codex 固有ではなく、Claude 経路でも同じ穴が実装調査で確認された(現状調査は issue #459 のコメントに置く)。残存 process は slot 解放後も workspace を書き、concurrency=1 と slot-release tree rule の前提を破る。

## 決定

1. **`WorkerAdapter` の seam は raw Unix signal ではなく意味を運ぶ。** 語彙は3つ — 畳み込み停止(graceful stop)・強制回収(force reclaim)・回収済み観測(reclaimed)。Harness 固有なのは畳み込みの合図だけ(Codex の canary では SIGINT が効いた)で、その選択は adapter に移る。watchdog は従来どおりタイミング(リミットと猶予)だけを持つ。
2. **回収 module は adapter の責務ではなく、盤面側の supervisor である。** 盤面が worker session ごとに process の容器(worker 容器)を先に作り、adapter は容器の中へ CLI を spawn するだけ。force と reclaimed は容器への操作として一度だけ書かれ、Harness 横断の床が構成で成立する — adapter が回収を間違える余地を残さない。
3. **slot の解放と再利用の前提は force の送達ではなく回収済み観測である。** watchdog は force 後に観測を待ち、空を観測してから failure question と slot 解放へ進む。観測できないまま timeout したら、失敗の記録(failure question)は残すが slot は解放せず、Containment quarantine の確認 question が解放の唯一の門になる。一回限りの process scan は観測に数えない(TOCTOU)。
4. **回収失敗の停止範囲は盤面全体である。** ADR 0098 決定6の「止められる最も狭い Provider / Harness 資源で止める」の基準はそのまま — 残存 process はどの Harness の次の worker とも同じホスト・workspace で同居しうるため、最も狭い資源が盤面全体になる。機構は既存の Containment quarantine を再利用し、新しい quarantine 族は立てない。
5. **platform 適格性は boot 時の機構前提検査で判定する。** 容器機構の前提(Linux: cgroup v2 と delegation、macOS: 実測で採用した機構の前提)を起動時に検査し、不成立の platform は黙って弱い回収へ落とさず worker pickup を platform-scoped に停止する。毎 boot の live kill canary は行わない — 証明は opt-in の実 process contract suite(敵対的子孫: graceful 無視・kill 中 fork・process group 分離)が担い、macOS ローカルと production Pi で機構ごとに一度 + CLI/OS 更新時に実行する。CI 常時実行はしない(ADR 0027 の線)。
6. **board/service shutdown に in-process の回収機構は足さない。** ADR 0001(graceful drain は作らない)は維持し、shutdown の回収は platform supervisor(Pi では systemd の control-group kill — 容器機構の親そのもの)への委譲で「同じ回収 module」を満たす。
7. **実行中タスクの明示 cancel は新設しない。** #459 の終了経路の列挙は「worker session を終わらせる経路は必ず同じ回収 module を通る」という contract であり、直接 cancel を実行中タスクへ広げる意図ではない(issue #130 の門は不変)。
8. **Board call の子 process(init ping・usage TUI)は範囲外。** 同じ残存クラスの穴だが、守る不変条件が別(ADR 0028 の no-orphan)なので issue を分離する。

## Considered options

- **adapter 責務型(各 adapter が force / reclaimed を実装し、共有は contract suite と型だけ)** —— 床が「全 adapter が正しく書かれていること」に依存し、Harness が増えるたび同じ回収を再実装・再証明する。容器なら共有が構成で成立する。
- **回収失敗を Harness 単位の quarantine に留める** —— 汚染がホスト規模である事実と合わない。基準(止められる最も狭い資源)は変えず、当てはめの結果が盤面全体になる。
- **boot 時に live kill canary を走らせる** —— 起動を遅くし、証明力は contract suite と重複する。boot 時は前提の存在検査で足りる。
- **in-process の shutdown handler を足す** —— ADR 0001 が退けた機構の再導入。platform supervisor が同じ保証を無償で供給する。
