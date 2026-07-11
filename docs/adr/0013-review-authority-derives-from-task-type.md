# review の権限はエージェントではなくタスク型に由来する: 強制床はコードに置く

issue #15 layer 2 のグリリングで決定。read-only は「review という行為の性質であって行為者の性質ではない」(CONTEXT.md の Review)— したがって review タスクは、実行エージェントが誰であっても(fix-forward RCA の self review を含め)、エージェント本来の authority profile ではなく**盤面固定の reviewer profile で spawn される**。task 型が profile を上書きする、権限モデルで唯一の場所である。

reviewer profile は registry の YAML ではなく**コード定数**とする。この profile はエージェントへの授権ではなく盤面自身の強制装置(branch discipline・quarantine と同じ側)であり、registry に置けば Condensation ループが自分の強制床への diff を提案できる位置に入る。また `outsideAuthority` は fail-open(allowlist 未記載 = 無制限)なので、床をデータの状態に依存させない。コード定数の `allowed_workspaces: []` により、明示された workspace への子登録はすべて人間への承認 question に変換される(workspace 未指定の修理タスクは親から継承するので変換されない — これがレビューの正規の出力経路)。

対で、registry 自身は**保護 workspace** とする: 保護 workspace を名指しする子登録は登録者の profile に関係なく無条件で承認 question に変換され、そこへの PR は merge ダイヤルに関係なく常に人間が merge する。「authority 変更は常に人間承認」は profile 側の状態(誰に何が許可されているか)から独立した、資源側の不変条件である。

同じコード定数は `assignable_to: []` も持つ — 明示された assignee への子登録も既定ではすべて承認 question に変換される。ただし唯一の例外として、review の分解子(修理タスク)がレビュー対象タスク(review の `parent_id` の先)自身の assignee と同じ宛先を指定する場合だけは、この allowlist に関わらず常時許可される(issue #15 の出力経路の設計判断: 「宛先はレビュー対象の実行者 — この割当だけ assignable_to に依らず常時許可(レビューという行為の定義の一部)」)。修理の宛先を委任ではなくレビューという行為自体の一部とみなすための exemption であり、assignee の一致だけを見る — workspace や risk_flag の検査には一切影響しない。

Considered options:

- **専用 reviewer エージェントを registry に立て、review タスクを全部そこへ割り当てる** — read-only の保証が割当の正しさに依存する。致命的なのは self RCA: self の実行者は定義上元のエージェントであり、この案では self review を read-only にする手段が存在しない。
- **instructions の散文だけで「直すな」を課す** — エージェントの判断が信用できなかった場面(異議)で走る RCA が善意頼みになる。構造保証ゼロ。
- **reviewer profile を registry の YAML として置く**(当初案)— 強制床が、その床が守るはずのデータの中に入る。registry-edit の連鎖で床自体を編集できてしまい、fail-open と合わさって「必ず承認を通る」が成立しない。
