/** ADR 0294 決定4 / ADR 0389 決定3: fire-and-forget の reject を log に出し、人間面を復旧経路として開いたままにする。 */
export function installUnhandledRejectionFloor(
  emitter: NodeJS.EventEmitter = process,
  log: (reason: unknown) => void = console.error,
): void {
  emitter.on("unhandledRejection", (reason) => log(reason));
}
