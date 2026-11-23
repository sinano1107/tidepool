import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findCurrentTimeDates } from "./current-time-date-guard.js";

const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"], strict: true, types: [], noEmit: true };
// lib の .d.ts は fixture ごとに parse し直すと遅いので、program を跨いで使い回す
const libFiles = new Map<string, ts.SourceFile | undefined>();

function detect(source: string, permanent: string[] = []) {
  const host = ts.createCompilerHost(options);
  const fixture = "/fixture/a.ts";
  const defaultGetSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === fixture) return ts.createSourceFile(fileName, source, languageVersion);
    if (!libFiles.has(fileName)) libFiles.set(fileName, defaultGetSourceFile(fileName, languageVersion));
    return libFiles.get(fileName);
  };
  const defaultFileExists = host.fileExists;
  host.fileExists = (fileName) => fileName === fixture || defaultFileExists(fileName);
  return findCurrentTimeDates(ts.createProgram([fixture], options, host), "/fixture", new Set(permanent));
}

describe("the current-time Date detector", () => {
  it("reports an untyped parameter that an interface types as Date, on a Promise-returning method", () => {
    const source = `
      interface Landing { tick(kind: string, now: Date): Promise<void> }
      export function createLanding(): Landing {
        return { async tick(kind, now) { void kind; void now; } };
      }`;
    expect(detect(source)).toEqual({ reports: ["a.ts tick(now)"], exempted: [] });
  });

  it("reports a Date member of an object parameter, naming the member", () => {
    const source = `export async function capture(board: { id: string; now?: Date }) { void board; }`;
    expect(detect(source)).toEqual({ reports: ["a.ts capture(board.now)"], exempted: [] });
  });

  it("reports a Date member of an optional object parameter", () => {
    const source = `export async function capture(board?: { now: Date }) { void board; }`;
    expect(detect(source)).toEqual({ reports: ["a.ts capture(board.now)"], exempted: [] });
  });

  it("does not report a clock, a member whose method returns Date", () => {
    const source = `export async function capture(clock: { now(): Date }) { void clock; }`;
    expect(detect(source)).toEqual({ reports: [], exempted: [] });
  });

  it("reports an async arrow, named by what it is assigned to", () => {
    const source = `export const present = async (now: Date) => { void now; };`;
    expect(detect(source)).toEqual({ reports: ["a.ts present(now)"], exempted: [] });
  });

  it("reports a function that returns a Promise without async", () => {
    const source = `
      declare function check(): Promise<boolean>;
      export function blocked(now: Date) { void now; return check(); }`;
    expect(detect(source)).toEqual({ reports: ["a.ts blocked(now)"], exempted: [] });
  });

  it("does not report a synchronous function taking a Date", () => {
    const source = `export function stamp(now: Date) { return now.toISOString(); }`;
    expect(detect(source)).toEqual({ reports: [], exempted: [] });
  });

  it("does not report an allowlisted member, and says the allowlist entry was used", () => {
    const source = `export async function startServer(given: { cliAuthExpiresAt?: Date }) { void given; }`;
    expect(detect(source, ["cliAuthExpiresAt"])).toEqual({ reports: [], exempted: ["cliAuthExpiresAt"] });
  });

  const clocked = `
    declare const clock: { now(): Date };
    declare function probe(...args: unknown[]): Promise<void>;
    declare function record(...args: unknown[]): void;
    declare function read(...args: unknown[]): AsyncIterable<number>;`;

  it("reports a clock.now() local referenced after an await", () => {
    const source = `${clocked}
      export async function observe() { const now = clock.now(); record(now); await probe(); record(now); }`;
    expect(detect(source)).toEqual({ reports: ["a.ts observe: now"], exempted: [] });
  });

  it("reports a clock.now() local referenced after an await as a shorthand property", () => {
    const source = `${clocked}
      export async function observe() { const now = clock.now(); await probe(); record({ now }); }`;
    expect(detect(source)).toEqual({ reports: ["a.ts observe: now"], exempted: [] });
  });

  it("does not report a clock.now() local referenced only before an await, or one read after it", () => {
    const source = `${clocked}
      export async function observe() {
        const started = clock.now(); record(started); await probe(started);
        const finished = clock.now(); record(finished);
      }`;
    expect(detect(source)).toEqual({ reports: [], exempted: [] });
  });

  it("reports a clock.now() local referenced in the body of a for await", () => {
    const source = `${clocked}
      export async function drain() { const now = clock.now(); for await (const item of read()) record(now, item); }`;
    expect(detect(source)).toEqual({ reports: ["a.ts drain: now"], exempted: [] });
  });

  it("does not report a clock.now() local referenced only in the header of a for await", () => {
    const source = `${clocked}
      export async function drain() { const now = clock.now(); for await (const item of read(now)) record(item); }`;
    expect(detect(source)).toEqual({ reports: [], exempted: [] });
  });

  it("reports a clock.now() local referenced in a loop before the loop's await, which the next pass runs after it", () => {
    const source = `${clocked}
      export async function sweep(xs: number[]) { const now = clock.now(); for (const x of xs) { record(now); await probe(x); } }`;
    expect(detect(source)).toEqual({ reports: ["a.ts sweep: now"], exempted: [] });
  });

  it("does not report a clock.now() local read afresh in each pass of a loop with an await", () => {
    const source = `${clocked}
      export async function sweep(xs: number[]) { for (const x of xs) { const now = clock.now(); record(now); await probe(x); } }`;
    expect(detect(source)).toEqual({ reports: [], exempted: [] });
  });

  it("does not report Date.now(), a number read for a deadline", () => {
    const source = `${clocked}
      export async function wait() { const started = Date.now(); await probe(); record(Date.now() - started); }`;
    expect(detect(source)).toEqual({ reports: [], exempted: [] });
  });

  it("reports a clock.now() local referenced in a synchronous callback written after an await", () => {
    const source = `${clocked}
      export async function f(rows: number[]) { const now = clock.now(); await probe(); rows.forEach(() => record(now)); }`;
    expect(detect(source)).toEqual({ reports: ["a.ts f: now"], exempted: [] });
  });

  it("reports a clock.now() local captured by an async function that references it after its own await", () => {
    const source = `${clocked}
      export function schedule(run: (task: () => Promise<void>) => void) {
        const now = clock.now();
        run(async () => { await probe(); record(now); });
      }`;
    expect(detect(source)).toEqual({ reports: ["a.ts schedule: now"], exempted: [] });
  });

  it("reports a local made by calling a () => Date", () => {
    const source = `${clocked}
      export async function settle(now: () => Date) { const at = now(); await probe(); record(at); }`;
    expect(detect(source)).toEqual({ reports: ["a.ts settle: at"], exempted: [] });
  });

  it("reports the getTime() and toISOString() forms of a current-time read", () => {
    const source = `${clocked}
      export async function settle() {
        const ms = clock.now().getTime(); const iso = clock.now().toISOString();
        await probe(); record(ms); record(iso);
      }`;
    expect(detect(source)).toEqual({ reports: ["a.ts settle: ms", "a.ts settle: iso"], exempted: [] });
  });

  it("reports the toISOString() of a current-time local, converted in a second step", () => {
    const source = `${clocked}
      export async function settle() { const now = clock.now(); const iso = now.toISOString(); record(now); await probe(); record(iso); }`;
    expect(detect(source)).toEqual({ reports: ["a.ts settle: iso"], exempted: [] });
  });

  it("does not report the toISOString() of a Date parameter on a synchronous function", () => {
    const source = `${clocked}
      export function stamp(now: Date) { const iso = now.toISOString(); return async () => { await probe(); record(iso); }; }`;
    expect(detect(source)).toEqual({ reports: [], exempted: [] });
  });
});

// ADR 0404 決定5: Promise を返す関数に現在時刻を Date で渡す形を、型検査器で src から拒む。
// 振る舞いを assert しない静的な検査で、ADR 0107 決定1 の seam ではない。
describe("the current-time Date guard over src", () => {
  // ADR 0404 決定4: 現在時刻でない事実の時刻。型では区別できないので、引数か欄の名で当て、理由を添える
  const permanent = new Map([["cliAuthExpiresAt", "a recorded expiry, not the current time"]]);
  // 今の違反と、それを直す ticket。直した ticket が自分の行を消す
  const pending: Record<string, string[]> = {
    "#3686": ["src/landing.ts tick(now)"],
    "#3687": [
      "src/push.ts pollNotifications(now)",
      "src/push.ts fireMorningDigest(now)",
      "src/push.ts run(now)",
      "src/quarantine.ts quarantineUnlessClear(now)",
      "src/containment.ts containmentPickupBlocked(now)",
      "src/harness-containment.ts harnessContainmentPickupBlocked(now)",
      "src/registry-unreadable.ts registryUnreadablePickupBlocked(now)",
      "src/scheduler.ts observeProviderUsage: now",
      "src/codex-worker.ts recheckUsage(now)",
      "src/codex-app-server.ts createCodexAppServerProbe(now)",
      "src/claude-cli-conformance.ts SURFACES(now)",
      "src/claude-cli-conformance.ts judgeConformance(now)",
      "src/workspace.ts openHumanContentWorkbench(now)",
      "src/workspace.ts captureFirstBaseline(board.now)",
      "src/execution-setting.ts changeExecutionSettings(at)",
      "src/issue-view.ts present(now)",
    ],
    "#3688": [
      "src/board-call-usage.ts recordedAnswer(now)",
      "src/retrospective.ts fireSpan(now)",
      "src/retrospective.ts attributeObjections(now)",
      "src/retrospective.ts attributeSecondRound(now)",
      "src/retrospective.ts reviewAllocation(now)",
      "src/retrospective.ts attributeStop(now)",
      "src/retrospective.ts draftBehaviorCandidate(now)",
      "src/retrospective.ts draftStopBehaviorCandidate(now)",
      "src/retrospective.ts draftCandidate(now)",
      "src/translation.ts translateFragments(now)",
      "src/translation.ts translateSource(now)",
      "src/translation.ts translateLogEntry(now)",
      "src/translation.ts translateLogEntries(now)",
      "src/translation.ts translateMemoryEntry(now)",
      "src/translation.ts translateHandoff(now)",
      "src/translation.ts translateQuestion(now)",
      "src/draft.ts draftTask(now)",
      "src/draft.ts draftHandoff(now)",
    ],
  };

  // src の型検査は数秒かかり、vitest の既定 5 s に近い
  it("reports exactly the allowlist", { timeout: 60_000 }, () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    if (!config) throw new Error("tsconfig.json did not parse");
    const sources = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(root, "src", name));
    const found = findCurrentTimeDates(ts.createProgram(sources, config.options), root, new Set(permanent.keys()));
    expect(found.reports.sort()).toEqual(Object.values(pending).flat().sort());
    expect(found.exempted.sort()).toEqual([...permanent.keys()].sort());
  });
});
