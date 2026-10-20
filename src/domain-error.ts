export class DomainError extends Error {}

/** 回答の書き込みの時点で question がもう開いていなかった(ADR 0288 決定1)。submitAnswer は閉じた理由で応答を分ける(決定4)。 */
export class QuestionClosedError extends DomainError {
  constructor() {
    super("this question was settled while the answer was being checked — read it again");
  }
}
