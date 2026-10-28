# 異議は従った agent 定義と workspace の文書にも帰責され、盤面の protocol 文は `environment`、どちらも worker 側には何も立てない

**Status 追記: 決定2 の当時版の束(再構成)は ADR 0314 決定1・3 で spawn 時に記録した prompt の部分(definition / authority / roster)の text になり、決定4 の「protocol 文は judge の入力に足さない」は ADR 0314 決定4 で反転した** —— 記録が版の刻印になり、盤面の文(doctrine / protocol / Interview の規律)も judge の入力に入る。持ち主が盤面で `environment` であることは変わらない(2026-10-26 の grilling、issue #2603)。

**Status 追記: skill は文書ではなく呼び出し時に注入される prompt で、scope(workspace / harness 同梱)は spawn の記録と worker の `init` 報告から、従った文面は transcript の投影から判事が読む(ADR 0325、issue #2682)** —— 決定3・4 の cause の割り当ては変わらない。退けた形「skill の使用を event に刻む」は盤面の event の話で、transcript の投影は別。

2026-10-21 の grilling(issue #1601、出どころは #1045 の sweep と ADR 0166 の既知の穴)で決定。帰責の judge の入力は
entry・steering・decision log・読んだ記憶だけで、worker が従った agent 定義・workspace の skill や文書・盤面の protocol 文は
渡らない。誤った定義や文書に従って外れた判断は `capability` か `uncertain` に倒れ、worker 宛の RCA と candidate が立ち、
学習器の負の信号に数えられる —— ADR 0166 が記憶について直した形がそのまま残っていた。事例は未観測だが、judge が文面を
見られない以上、起きても見分ける印が記録に残らない。観測を待たない。当時版の読み口・入力の組み方・読み手の全件は #1601 に置く。

## 決定

1. **cause の語彙に `agent_definition` を足す —— 持ち主は registry のその session の当時版。** 当時版は `worker_spawned` の
   `registry_commit` / `definition_version` から引く束(本文 + authority profile の散文 + roster の description)で、self RCA の
   spawn に注入するものと同じ(ADR 0020 / ADR 0270)。本文が盤面 code にある組み込み agent の外れは `environment`。語彙は
   1本のまま(ADR 0115 決定1)、持ち主で切る —— ADR 0213 が「分けない」としたのは同じ持ち主の中の2値で、ここは持ち主が
   worker(= ベース AI + skills + instructions + authority profile)でも外側でもない registry の著者である。名前を `registry` /
   `definition` にしないのは、Registry reachability(故障 = `environment`)と記憶の種別 Definition と読み違えるため。
2. **判定の入力に当時版の束を `memory_read` の横に足し、`agent_definition` の門は構造で引く。** 当時版が引けない session
   (記録の commit に定義が無い)は欄を空にし、空のまま `agent_definition` と答えた判定は `uncertain` に倒す —— 見せていない
   文面には帰責できない(ADR 0166 決定3 と同じ形)。名指す対象は session ごとに1つで記録から一意に引けるので、`entries` に
   当たる列は持たない。
3. **cause の語彙に `workspace_document` を足す —— 持ち主は workspace の中身。** `@workspace` の skill・AGENTS.md・README など、
   仕事の対象そのものに置かれた文書に従って外れた判断。`environment` と分けるのは修理子の振る舞いが違うからで(ADR 0213 の
   基準)、`environment` の修理子は同じ壁で escalate し、`workspace_document` の修理子は同じ workspace で走るので文書そのものを
   修理の中で直す。judge が名指せるのは decision log が文書を引いたときだけで、門は置かない。
4. **盤面の protocol 文(rules of the road)と `@host` の skill は `environment`。** 持ち主は盤面の開発側かベンダーで、修理子が
   触れない外側(ADR 0213 決定1 の読みの中)。判定 prompt にこの1文を足す。protocol 文は judge の入力に足さず、盤面の版も
   `worker_spawned` に刻まない —— worker が従ったときは decision log に文言が引かれ、judge はそこから名指す。
5. **新しい2値は worker 側に何も立てない。** commit 時は修理だけ(ADR 0115 決定3 の `environment` の列)、candidate は書かず、
   学習器の負の信号に数えず、配分評価の prompt には載せない(`memory` と同じ扱い、ADR 0166 決定1・4)。修理子は今の定義で走り
   (ADR 0019)、purpose が運ぶ判定(ADR 0213 決定3)の1点だけ逸れる —— registry が直るまで修理子を待たせる門は足さない。
6. **注入された記憶の Definition も読んだ集合に入る(#1069 を畳む)。** `memory_injected` の kind definition の entry を入力と
   `memory` の門の集合に足す。ADR 0166 が線を置かなかった理由は観測の不在だったが、決定2 で注入文面を入力に足す線が立つと
   費用がほぼ消える。
7. **`agent_definition` から修正案は流さない。** 人間が注釈の evidence(ADR 0213 決定4)を見て registry-edit か WebUI で直す。
   ADR 0166 の退けた理由のうち「起草 client に本文が無い」は決定2 で消えるが、「起草経路が2本になる」は残る。立てるなら盤面が
   registry workspace に registry-edit の work タスクを立て PR と人間 merge の門(ADR 0019)に乗せる形で、盤面は文面を書かない。
   既定 agent・Auditor・Interviewer の本文は構造的に空(ADR 0117 / 0275)なので、件数が見えてから。

## 退けた案

- **agent 定義を `environment` に含める** —— ADR 0213 決定1 の「worker の外側」を worker 自身の定義まで広げ、持ち主で切る語彙
  (ADR 0115 決定1)を崩す。
- **`@workspace` の skill を `environment` / `capability` / `missing_information` で受ける** —— 修理子が直せるものを「触れない外側」と
  呼ぶ、従うのが妥当な文書を腕の落ち度と書く、直した文書自体が記録になるのに Knowledge に写す。
- **skill の使用を event に刻む** —— 盤面の verb ではなく、Codex には skill の道具が無く shell の読みと区別がつかず、決定3 の値は
  文書一般に効くので「読んだファイル全部」になる。それは transcript(Precedent の行動行)の仕事で、帰責は transcript に依らない。
- **protocol 文の今の文面を注意書き付きで入力に足す** —— 版の刻印が無く、deploy をまたぐと judge が見る文と worker が従った文がずれる。
