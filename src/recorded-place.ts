import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { interviewRoomPath } from "./tasks.js";

/** 記録された場所は面接室だけ —— 受験者は task の checkout で走る(ADR 0356 決定1)。 */
export type RecordedPlaceKind = "interview_room_opened";

/** 開く手順・修理の予告・回答が共有する分類。event があれば repo まで作った記録がある(ADR 0329)。 */
export function recordedPlace(db: Db, rootId: string): { path: string; hasRepository: boolean } | undefined {
  const path = interviewRoomPath(db, rootId);
  return path === undefined ? undefined : { path, hasRepository: placeHasRepository(path) };
}

/** sparse snapshot の「checkout が消えた」と同じ述語(ADR 0277 追記 決定1)。 */
export const placeHasRepository = (path: string): boolean => existsSync(join(path, ".git"));

