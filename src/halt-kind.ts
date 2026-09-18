/** 盤面全体の停止の kind 語彙(ADR 0068 決定1 の表示優先順位そのものの並び)。
 *  順序つき列挙を返す唯一の場所は `board-halt.ts` のままで、ここが持つのは綴りだけ
 *  である。
 *
 *  依存ゼロの leaf module にしてあるのは、この語彙をブラウザ側のプログラムが
 *  `type HaltKind = import("../src/halt-kind").HaltKind;` で引くためである
 *  (ADR 0133 決定3)。`board-halt.ts` は Db を含む7本を import しており、そこから
 *  引くと node の世界が WebUI の型検査へ流れ込む。`board-halt.ts` が re-export する
 *  ので、サーバ側の importer から見た形は変わらない。 */
export const HALT_KINDS = [
  "triage",
  "pause",
  "containment",
  "failedTeardown",
  "registryReachability",
  "throttle",
] as const;
export type HaltKind = (typeof HALT_KINDS)[number];
