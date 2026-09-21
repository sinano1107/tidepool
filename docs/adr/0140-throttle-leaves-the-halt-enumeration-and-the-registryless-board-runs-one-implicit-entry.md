# throttle は盤面全体の停止の列挙から外れ、registry なしの盤面も暗黙の entry 1つで Provider 単位の経路を通る

2026-09-21 の grilling(issue #756)で決定。ADR 0068 決定1 は throttle を盤面全体の停止の順序つき列挙に入れたが、ADR 0098 決定6 が Throttle を止められる最も狭い Provider / Harness 資源へ移し、CONTEXT.md「盤面全体の停止」も「throttle はここに入らない」と書き換えた。registry を持つ盤面はすでに entry 単位の除外(ADR 0110 決定3)で動いており、列挙の throttle は一度も立たない。残っていたのは registry なしの盤面のための旧経路 —— 盤面全体の throttle・agent 名で外す fable 線と quarantine・agent 単位の Harness 検査 —— と、それを「盤面全体の停止の kind 語彙」として固定した `HALT_KINDS` だけである。

## 決定

1. **throttle は盤面全体の停止の列挙から外す。** 列挙は CONTEXT.md の5つ(トリアージ・Pause・回収済み観測の不成立・落ちた後始末・レジストリ到達性)と一致する。これは ADR 0068 決定1 の中身のうち throttle の1つを改訂するもので、「順序つき列挙を1つの module が持つ」という決定1 の形は無傷である。throttle entry の属性を定めた決定2 は entry と一緒に役目を終え、「答えは観測の鮮度を伴う」原則は CONTEXT.md のとおり Provider 単位の読み口に適用される。
2. **registry なしの盤面はテストと開発のための足場であり、運用形ではない。** 形は残す。運用する盤面は registry を持つ。
3. **registry なしの盤面にも候補表を与える。** 盤面の組み立てが合成の agent 定義を1つ持ち(Provider は anthropic だけ、tier は書かない)、registry を持つ盤面と同じ `executionSettingsFor` を通す —— ティアは盤面既定、モデルは Selector の表から決まる。scheduler の旧経路の分岐は消え、盤面はどちらの形でも entry 単位の除外という1本の経路で pickup する。
4. **代わりの盤面全体の表示は足さない。** 全候補が throttle で外れていても、それは行の `skipped` と Provider ごとの使用量の表示が言う。盤面が流れうる状態を「止まっている」と答えない(ADR 0068 決定1 が fable 線について退けたのと同じ理由)。

## Considered options

- **「Provider が1つしか無い盤面では throttle は実質盤面全体」と語彙に書き戻す** —— ADR 0098 決定6 が ADR 0097 決定2 の同じ例外を撤回した直後の線に戻る。足場のために運用の語彙を曲げることになる。
- **registry なしの盤面を廃止し registry を必須にする** —— 語彙のズレを直すのにテストの大半を registry ありへ移す必要はない。足場を残しても、経路が1本なら語彙は1つで済む。
- **旧分岐を残し、保存先だけ Provider 単位に差し替えて halt を行の `skipped` に変える** —— 分岐が2本並んだまま、旧分岐の中に3つ目の半端な経路が生まれる。
- **合成の定義を経ず、`ExecutionSetting` を固定値で1行作る** —— Selector の表を変えても registry なしの盤面にだけ効かなくなり、足場が本番と違う決め方をする。

## Consequences

- 旧経路の保存(盤面全体の throttle 状態とその Provider 単位への移行)、再観測中の旗の注入、agent 名で外す fable 線と quarantine の口、Board call の旧フォールバックは消える。リリース前なので移行は書かず、盤面は作り直す。
- `GET /pause` は throttle を返さなくなり、WebUI の throttle 用の slot 表示も消える。registry を持つ盤面ではもともと点かないので、運用上の見た目は変わらない。
- 測定と現状の実装の読みは issue #756 のコメントにある。
