import { type Clock, SystemClock } from "./clock.js";
import type { Db } from "./db.js";
import { openQuarantineQuestion, quarantineUnlessClear, registerQuarantine } from "./quarantine.js";
import { loadRegistry, type Registry, type RegistryAvailabilityCheck, type RegistrySource } from "./registry.js";

/** Candidate-time fail-closed gate. The open Confirmation question is the durable
 *  half of this board-wide quarantine: it short-circuits the live check so repair
 *  cannot silently resume pickup before a human confirms it. */
export function registryUnreadablePickupBlocked(
  db: Db,
  reachability: RegistryAvailabilityCheck,
  now: () => Date,
): Promise<boolean> {
  return quarantineUnlessClear(
    db,
    "registryUnreadable",
    null,
    async () => {
      const result = await reachability();
      return result.available
        ? { available: true }
        : { available: false, reason: result.reason ?? "registry check failed" };
    },
    now,
  );
}

/** 盤面全体の registry の止まりが開いているか —— 収束と poll の catch が、自分の question・計測・行を足さない判定(ADR 0403 決定5)。 */
export function registryUnreadableOpen(db: Db): boolean {
  return openQuarantineQuestion(db, "registryUnreadable", null) !== undefined;
}

/** 盤面の registry の読み込み(YAML・schema・git)の失敗の1つの型。文は止まりを名指し、`reason` は読み込みの失敗そのもの。 */
export class RegistryUnreadableError extends Error {
  readonly reason: string;
  constructor(cause: unknown) {
    const reason = `the board could not read the registry: ${cause instanceof Error ? cause.message : String(cause)}`;
    super(`${reason}; pickup and landing are stopped until the registry question is answered`, { cause });
    this.reason = reason;
  }
}

/** 盤面の registry を読む1点(ADR 0403 決定5): 読めなければ `registryUnreadable` を立ててから投げる —— 呼び手は何もしない。
 *  開いていれば重ねない(`registerQuarantine` は冪等)。名前ごとの解決の失敗はここを通らない。止まりは拒否の前に書く記録で、
 *  呼び手の状態の変化が起きても起きなくても真なので、呼び手の transaction の外に置く(ADR 0405 決定3(a))。 */
export function loadRegistryOrStop(db: Db, source: RegistrySource, clock: Pick<Clock, "now"> = new SystemClock()): Registry {
  try {
    return loadRegistry(source.dir, source.mode);
  } catch (err) {
    const error = new RegistryUnreadableError(err);
    const stop = () => registerQuarantine(db, "registryUnreadable", null, error.reason, clock.now());
    stop();
    // ADR 0403 決定5: 止まりは呼び手の transaction の rollback で消えない —— 同じ接続しか無い(:memory: も、書き込み中の transaction の
    // 下の2本目の接続も使えない)ので、transaction の中なら抜けた後にもう一度立てる。commit されていれば2度目は何もしない
    if (db.inTransaction) {
      queueMicrotask(() => {
        try {
          stop();
        } catch (stopErr) {
          console.error("[registry] could not raise the registry stop after the caller's transaction ended:", stopErr);
        }
      });
    }
    throw error;
  }
}
