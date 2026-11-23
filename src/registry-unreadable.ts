import type { Db } from "./db.js";
import { quarantineUnlessClear, registerQuarantine } from "./quarantine.js";
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
 *  開いていれば重ねない(`registerQuarantine` は冪等)。名前ごとの解決の失敗はここを通らない。 */
export function loadRegistryOrStop(db: Db, source: RegistrySource, now: () => Date): Registry {
  try {
    return loadRegistry(source.dir, source.mode);
  } catch (err) {
    const error = new RegistryUnreadableError(err);
    const stop = () => registerQuarantine(db, "registryUnreadable", null, error.reason, now());
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
