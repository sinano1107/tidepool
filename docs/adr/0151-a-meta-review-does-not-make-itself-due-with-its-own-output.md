# meta-review は自分の産物で次の周期を due にしない

2026-09-24 の grilling(issue #936)で決定。ADR 0120 決定2(周期は間隔の下限、材料があれば登録)と ADR 0150 決定1
(routing の材料に `execution_settings_changed` を含む)を前提に、材料から何を外すかを決める。観測・実測と `file:line` は
issue #936 のコメントに置く。

## 決定

1. **同じ主題の meta-review 自身の産物は、次の meta-review の材料に数えない。** 産物とは、review が直接書いたもの
   (memory の define / fold / move / invalidate)と、その提案 question への回答が刻んだもの(approve・reject・修正値つきの
   approve のすべて)。due は「前回から新しい証拠が入った」の意味であり、承認は人間の同意でも中身は前回の review の判断、
   直接書き込みには人間が関与しない。数えると、提案が approve されるたびに frontier の review が1本余分に走る
   (#936 で routing について実測、memory は直接書き込みだけで同じ形になる)。回答の中身と修正値は `read_routing_settings`・
   `list_memory_candidates` が返すので、材料から外しても次の周期で読まれる。
2. **routing の「人間が変えた行」は人間の直接編集(settings タブ・管理MCP)だけを返す。** 承認の適用は上の読み口と二重に
   なり、名前とも食い違う。
3. **識別は event の payload の印で行う。** 回答が刻む event は `question_id` を、review の直接書き込みによる無効化は書き手の
   activity を持つ(`memory_entry_approved` / `memory_entry_created` が既に持つ形)。材料の問い合わせはこの印で除外する。

## 退けた案

- **承認の適用だけ外す(routing だけ、または両主題)** —— memory の直接書き込みと reject で同じ自己給餌が残る。
- **修正値つきの approve だけ材料に数える** —— 修正値は回答の読み口で読まれる。単独で review を起こす理由は観測されていない。
- **`events.task_id` に review / question を入れる** —— 盤面イベント(task_id NULL)の意味が変わり、task 単位で event を
  読む側すべてに波及する。
- **同時刻の `question_answered` との突き合わせ** —— 推測で、壊れやすい。
