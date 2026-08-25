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
  const runOk: RunOkFn = (command, args) => {
    // bwrap は梯子に2段あるので、コマンド名だけでは台本が段を区別できない —
    // ネストした userns を作る段は引数の `unshare` で見分ける
    const name = command === "bwrap" && args.includes("unshare") ? "bwrap(userns)" : command;
    calls.push(name);
    return !fails.includes(name);
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

  it("Linux: bwrap・ネスト userns・socat の3段が実際に動けば成立する", () => {
    const { runOk, calls } = scriptedRun();
    expect(checkSandboxCapability("linux", runOk)).toEqual({ available: true });
    expect(calls).toEqual(["bwrap", "bwrap(userns)", "socat"]);
  });

  it("Linux: bwrap が入っていても実行に失敗すれば不成立 — user namespace / AppArmor に塞がれた形を捉える", () => {
    const { runOk, calls } = scriptedRun(["bwrap"]);
    const result = checkSandboxCapability("linux", runOk);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toContain("bwrap");
    // 1段目で止まる — ネスト userns の段まで進まない
    expect(calls).toEqual(["bwrap"]);
  });

  it("Linux: bwrap は動くがネストした userns が塞がれていれば不成立 — reason が AppArmor の対処を名指す", () => {
    const { runOk } = scriptedRun(["bwrap(userns)"]);
    const result = checkSandboxCapability("linux", runOk);
    expect(result.available).toBe(false);
    const reason = result.available === false ? result.reason : "";
    expect(reason).toContain("apparmor_restrict_unprivileged_userns");
    expect(reason).toContain("bwrap-userns-restrict");
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
