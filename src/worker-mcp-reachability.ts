import { randomUUID } from "node:crypto";
import type { ContainmentCapability } from "./containment.js";
import type { Harness } from "./registry.js";

/** Harness ごとの Worker MCP 到達性の probe(ADR 0331 決定8): その Harness の CLI を `url` の listener へ繋ぎ、繋がったかを返す。
 *  封じ込めの検査と同じ `{available}` の形だが、問いは封じ込めではなく報告可能性(決定7)。 */
export type WorkerMcpReachabilityProbe = (harness: Harness, url: string) => Promise<ContainmentCapability>;

/** 盤面の側の1回: 使い捨ての id を発行して `?probe=` に載せ、probe が終われば無効にする —— 投げても timeout でも
 *  (Board call の上限は null で返り、probe はそれを不成立に倒すので、どちらも finally を通る)。無効にし損ねた id は
 *  古い process に initialize を開けたままにする。 */
export async function probeWorkerMcpReachability(
  ids: Set<string>,
  mcpUrl: string,
  harness: Harness,
  probe: WorkerMcpReachabilityProbe,
): Promise<ContainmentCapability> {
  const id = randomUUID();
  ids.add(id);
  try {
    return await probe(harness, `${mcpUrl}?probe=${id}`);
  } finally {
    ids.delete(id);
  }
}
