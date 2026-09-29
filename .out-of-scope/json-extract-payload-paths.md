# 呼び手の SQL の `json_extract` の path を `EventPayload` の型の下に置く

events モジュールの外の SQL が `json_extract(payload, '$.x')` で payload のフィールドを参照するのを、型から導く path・読み口への
移設・lint のいずれでも縛らない。payload の rename からの守りは振る舞いのテストが担う(CONTEXT.md「イベント履歴の読みの線」)。

## なぜ範囲外か

型の守りは無いが、テストの守りはある。main `4215714` で payload のフィールドを型と書き手の側だけ rename し、呼び手の path は
元のまま残して流した3件は、いずれも tsc を黙って通り、いずれも既存テストが述語の空振りを落とした(payload の形を直接見る
assertion を直したあとも失敗が残った)。

| rename したフィールド | 読む SQL | 残った失敗 |
| --- | --- | --- |
| `allocation_reviewed.review_task_id` | allocation-review の未評価の `NOT EXISTS` | 3件(注釈が2件載る) |
| `memory_entry_created.restored_from` | memory の `restoredAs` | 復元系(2件目と合わせて15件) |
| `meta_review_registered.material_watermark` | meta-review の周期と読み口の窓 | 周期・窓の系(同上) |

型の下に置く代価は守りの差に見合わない。`$.entry.author.activity` や `$.target.id` のような入れ子の path はキーの型から
導けず、約30本の SQL が文字列の埋め込みになって読みにくくなる。

`tasks.question_proposal` 列への `json_extract`(8か所)も同じ扱いにする。events の payload ではなく型 `QuestionProposal`
を持つ別の列だが、守りの形は同じである。

## 再開条件

payload(または `question_proposal`)の rename が既存テストをすり抜けたことを1度観測したとき。3件の標本は約30か所の一部で、
coverage を取っていないので、どのテストも通らない行が無いことまでは確かめていない。

## Prior requests

- #1150 — 呼び手の SQL の json_extract は payload の形を型なしで参照している(events.ts の外に36か所、守るものが無い)
