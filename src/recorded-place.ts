import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { examineeCheckoutPath, interviewRoomPath } from "./tasks.js";

export type RecordedPlaceKind = "interview_room_opened" | "examinee_checkout_opened";

/** 開く手順・修理の予告・回答が共有する分類。event があれば repo まで作った記録がある(ADR 0329)。 */
export function recordedPlace(db: Db, taskId: string, kind: RecordedPlaceKind): { path: string; hasRepository: boolean } | undefined {
  const path = kind === "interview_room_opened" ? interviewRoomPath(db, taskId) : examineeCheckoutPath(db, taskId);
  return path === undefined ? undefined : { path, hasRepository: placeHasRepository(path) };
}

/** sparse snapshot の「checkout が消えた」と同じ述語(ADR 0277 追記 決定1)。 */
export const placeHasRepository = (path: string): boolean => existsSync(join(path, ".git"));

