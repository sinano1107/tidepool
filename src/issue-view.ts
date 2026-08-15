import type { GitHubClient } from "./github.js";
import { type BoardTask, contentSourceFor, type TaskContent } from "./tasks.js";

/** How fresh an issue-backed task's displayed content is (issue #49 §6):
 *  `live` — fetched within the cache TTL. `stale` — a refresh failed, the
 *  last successful fetch is shown. `unavailable` — no fetch has ever
 *  succeeded, the "#N" placeholder is all there is. Ordinary tasks never
 *  carry this field. */
export type IssueLiveState = "live" | "stale" | "unavailable";

/** A row of any board read口, live-expanded. Generic in the row so a read口
 *  with fields of its own (`listYourTasks`'s `blocking`) keeps them — `present`
 *  spreads the task it was handed, so this is what it actually returns. */
export type Live<T extends BoardTask> = T & { issue_live_state?: IssueLiveState };

export type LiveBoardTask = Live<BoardTask>;

/** The UI-display use-moment of ADR 0016's live 参照, as a process-wide
 *  short-TTL cache: the board's GET endpoints poll every 15s, and every
 *  issue-backed row would otherwise hit GitHub on each poll. The UI is a
 *  convenience view (the canonical reads are spawn and the registration
 *  gate), so content up to a TTL old is fine. The fetch itself still goes
 *  through contentSourceFor — this class only decides *when* to fetch, never
 *  *what* a task's content source is. */
const TTL_MS = 30_000;

export class IssueContentCache {
  // keyed by workspace path + issue number — the same pair that identifies
  // the content (ADR 0016's workspace 焼き込み rationale)
  private readonly entries = new Map<string, { content: TaskContent; fetchedAt: number }>();
  // one fetch per key at a time: overlapping polls (/tasks and /queue fire
  // together, or several tasks reference the same issue) share the in-flight
  // promise instead of each hitting GitHub
  private readonly inFlight = new Map<string, Promise<TaskContent>>();

  async present<T extends BoardTask>(
    task: T,
    github: GitHubClient | undefined,
    workspacePath: () => string | undefined,
    now: Date,
  ): Promise<Live<T>> {
    if (task.github_issue_number == null) return task;
    const path = workspacePath();
    // without a workspace path (or a GitHub seam at all) the content can't
    // even be identified — nothing to fetch, nothing to key a cache on
    if (path === undefined || !github) return { ...task, issue_live_state: "unavailable" };
    const key = `${path}#${task.github_issue_number}`;
    const cached = this.entries.get(key);
    if (cached && now.getTime() - cached.fetchedAt < TTL_MS) {
      return { ...task, ...cached.content, issue_live_state: "live" };
    }
    try {
      let fetch = this.inFlight.get(key);
      if (!fetch) {
        fetch = contentSourceFor(task, github, () => path).expand();
        this.inFlight.set(key, fetch);
      }
      const content = await fetch;
      this.entries.set(key, { content, fetchedAt: now.getTime() });
      return { ...task, ...content, issue_live_state: "live" };
    } catch {
      // a failed refresh keeps the entry's fetchedAt, so every later poll
      // retries GitHub until one succeeds and flips the row back to live
      if (cached) return { ...task, ...cached.content, issue_live_state: "stale" };
      // never fetched: the row already carries the "#N" placeholder
      // (fillContentPlaceholder) — surface that it's all there is
      return { ...task, issue_live_state: "unavailable" };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
