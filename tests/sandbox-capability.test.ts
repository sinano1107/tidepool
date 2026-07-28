import { describe, expect, it } from "vitest";
import { checkSandboxCapability, type RunOkFn } from "../src/sandbox.js";

/** ADR 0033 の fail-closed: サンドボックスが成立しない環境では worker を裸で
 *  走らせない。この検査は「入っているか」ではなく「実際に動くか」を見る —
 *  Linux の bwrap は user namespace / AppArmor に塞がれれば入っていても動かず、
 *  それこそが調査時に踏んだ既知の失敗形だから。
 *
 *  ここでのシナリオは、実測した実コマンド(macOS の
 *  `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`、Linux の
 *  `bwrap … /bin/true` と `socat -V`)を台本にしたもの。実 OS が本当に拒否する
 *  ことの確認は実機スモークの担当(ADR 0027)。 */
function scriptedRun(fails: string[] = []): { runOk: RunOkFn; calls: string[] } {
  const calls: string[] = [];
  const runOk: RunOkFn = (command) => {
    calls.push(command);
    return !fails.includes(command);
  };
  return { runOk, calls };
}

describe("checkSandboxCapability", () => {
  it("macOS: Seatbelt が実際に起動できれば成立する", () => {
    const { runOk, calls } = scriptedRun();
    expect(checkSandboxCapability("darwin", runOk)).toEqual({ available: true });
    expect(calls).toEqual(["/usr/bin/sandbox-exec"]);
  });

  it("macOS: sandbox-exec が起動できなければ不成立(理由つき)", () => {
    const { runOk } = scriptedRun(["/usr/bin/sandbox-exec"]);
    const result = checkSandboxCapability("darwin", runOk);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toContain("sandbox-exec");
  });

  it("Linux: bwrap と socat の両方が実際に動けば成立する", () => {
    const { runOk, calls } = scriptedRun();
    expect(checkSandboxCapability("linux", runOk)).toEqual({ available: true });
    expect(calls).toEqual(["bwrap", "socat"]);
  });

  it("Linux: bwrap が入っていても実行に失敗すれば不成立 — user namespace / AppArmor に塞がれた形を捉える", () => {
    const { runOk } = scriptedRun(["bwrap"]);
    const result = checkSandboxCapability("linux", runOk);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toContain("bwrap");
  });

  it("Linux: socat が無ければ不成立(サンドボックスのネットワークプロキシが立たない)", () => {
    const { runOk } = scriptedRun(["socat"]);
    const result = checkSandboxCapability("linux", runOk);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toContain("socat");
  });

  it("対応外のプラットフォームは不成立に倒す(fail-open にしない)", () => {
    const { runOk, calls } = scriptedRun();
    const result = checkSandboxCapability("win32", runOk);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toContain("win32");
    // 検査すら走らせない — 走らせて「たまたま 0 で返る」余地を残さない
    expect(calls).toEqual([]);
  });
});
