/** 「なぜ外れたか」の語彙(ADR 0115 決定1)。配分評価(ADR 0111 決定4)と帰責
 *  (#563)が**同じ1本**を輸入する —— 分類が2本あると必ず漂流するので、どちらの
 *  module にも置かず、この中立の module が1つだけ持つ。`preference` /
 *  `requirement_change` は異議でしか現れないが、値域は1本である。`uncertain` は
 *  帰責では最終値にならない(決定2)が、配分評価では判定そのものの値。 */
export const CAUSES = [
  "capability",
  "task_ambiguity",
  "missing_information",
  "environment",
  "preference",
  "requirement_change",
  "uncertain",
] as const;
export type Cause = (typeof CAUSES)[number];
