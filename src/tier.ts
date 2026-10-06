import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import type { QuestionProposal, TierNeighbour } from "./tasks.js";

/** 必要品質のティア(CONTEXT.md「要求」/ ADR 0200 決定1)の名前。段は盤面の DB が持つ順序付きの一覧で(`readTiers`)、
 *  コードは名前を列挙しない —— 型が言えるのは「段の名前」であることだけ。 */
export type Tier = string;

/** 段の盤面内部の id(ADR 0200 決定2)。盤面の中の参照(行・task の要求・盤面設定・提案)は id で段を指し、外へは出さない。 */
export type TierId = number;

/** 要求のもう1列: 要求ティアの候補を並べる鍵(CONTEXT.md「要求」/ ADR 0114 決定1)。
 *  `quality` = Provider 順位 → 価格、`cost` = 価格 → Provider 順位。ティアは床
 *  なので、どちらも床を下回る許可ではない。`speed` は落とした —— 締め切りは
 *  ティアの申告で表し、所要時間は学習器の outcome として観測される。 */
export const PRIORITIES = ["quality", "cost"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 配布される種の段(ADR 0200 決定1・3)。表と同じく DB へ一度だけ初期化し、以後は DB が正本。説明は「1つ下の段では
 *  足りず、この段なら足りる仕事」を書く(文面は #1346 のコメント)。並びが段の順序である。 */
export const SEED_TIERS: readonly { name: string; description: string }[] = [
  { name: "economy", description: "Work that follows a pattern already in the codebase: adding tests, routine wiring, mechanical edits." },
  { name: "standard", description: "Work where the approach has to be worked out: a multi-file implementation or a larger refactor." },
  { name: "frontier", description: "A hard problem that has already resisted an attempt, or long autonomous work where a wrong call is expensive." },
];

/** 種の盤面設定が指す段(ADR 0200 決定4): 盤面既定(未指定の task と下書き)と、盤面自身の判断の段(振り返り Board call と
 *  周期 meta-review)。配布される既定は最小の床で、上げるのは運用者の判断である(ADR 0094 の線)。 */
export const SEED_BOARD_TIERS = { default_tier: "economy", judgement_tier: "frontier" } as const;

/** 名前で喋る書き込みの入口が段の id に解決する式(ADR 0200 決定2)。消した段(position が NULL)は見えない ——
 *  消した名前は使い直せるので、名前で引けるのは生きている段だけである。id で読む側は消した段の名前も読む。 */
export const liveTierId = (param: string) => `(SELECT id FROM tiers WHERE name = ${param} AND position IS NOT NULL)`;

/** 盤面の段の一覧を id つきで順序どおりに。消した段は載らない。id は盤面の中の照合だけが読む。 */
export function liveTierRows(db: Db): { id: TierId; name: Tier; description: string }[] {
  return db.prepare("SELECT id, name, description FROM tiers WHERE position IS NOT NULL ORDER BY position").all() as {
    id: TierId;
    name: Tier;
    description: string;
  }[];
}

/** 盤面の段の一覧を順序どおりに(ADR 0200 決定1)。消した段は載らない。 */
export function readTiers(db: Db): { name: Tier; description: string }[] {
  return liveTierRows(db).map(({ id: _, ...tier }) => tier);
}

/** 生きている段の名前を id に引く。呼び手は名前を検査済み(`assertKnownTier`)であること。 */
export function tierIdOf(db: Db, name: Tier): TierId {
  return (db.prepare(`SELECT ${liveTierId("?")} AS id`).get(name) as { id: TierId }).id;
}

/** 段の id を名前に引く。消した段は消したときの名前(決着した提案の履歴が読む)。 */
export function tierNameOf(db: Db, id: TierId): Tier {
  return (db.prepare("SELECT name FROM tiers WHERE id = ?").get(id) as { name: Tier }).name;
}

/** 提案が id で持つ段を、いまの名前に引いた形(issue #1436): 外へ見せる口(提案 question の応答・提案の履歴)と、
 *  承認の書き込み(名前で喋る扉)が読む。 */
export function proposalTierNames(db: Db, proposal: QuestionProposal): QuestionProposal<Tier> {
  const name = (id: TierId) => tierNameOf(db, id);
  const row = <R extends { tier: TierId }>(r: R) => ({ ...r, tier: name(r.tier) });
  const neighbour = (n: TierNeighbour | null) => n && { name: name(n.id), description: n.description };
  if (proposal.kind === "registry") return { ...proposal, to: name(proposal.to), pin: { tier: name(proposal.pin.tier), rows: proposal.pin.rows.map(row) } };
  if (proposal.kind === "memory") return proposal;
  switch (proposal.op) {
    case "row": {
      const { tier, ...change } = proposal.change;
      return { ...proposal, change: { ...change, ...(tier !== undefined && { tier: name(tier) }) }, pin: row(proposal.pin) };
    }
    case "add_tier":
      return { ...proposal, pin: { row: row(proposal.pin.row), below: neighbour(proposal.pin.below), above: neighbour(proposal.pin.above) } };
    case "tier_description":
      return { ...proposal, tier: name(proposal.tier) };
    default:
      return proposal;
  }
}

/** 段の名前を順序どおりに。 */
export function tierNames(db: Db): Tier[] {
  return readTiers(db).map((tier) => tier.name);
}

/** 名前で喋る入口の検査(ADR 0200 決定2): 一覧に無い名前は、いまの一覧を添えて拒む。 */
export function assertKnownTier(db: Db, field: string, name: string): void {
  const names = tierNames(db);
  if (!names.includes(name)) throw new DomainError(`unknown ${field} "${name}" — one of ${names.join(", ")}`);
}
