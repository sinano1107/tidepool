/** ADR 0294 決定4: process 全体の床。fire-and-forget の鎖が reject しても process は
 *  落とさず、理由(Error なら stack ごと)を log に出す —— 人間面が開いたままなのが
 *  復旧経路(ADR 0036)。同期の throw(`uncaughtException`)は状態が壊れうるので登録しない。 */
export function installUnhandledRejectionFloor(
  emitter: NodeJS.EventEmitter = process,
  log: (reason: unknown) => void = console.error,
): void {
  emitter.on("unhandledRejection", (reason) => log(reason));
}
