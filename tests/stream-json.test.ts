import { describe, expect, it } from "vitest";
import { collectRefusal, parseStreamLine, readInitAutoMemoryPath, readInitMcpServers } from "../src/stream-json.js";
import { syntheticRefusalLine } from "./fakes.js";

/** ADR 0108 決定2: 封じ込めの3つ目の問いが MCP 軸で見るのは init 行の
 *  `mcp_servers[].name` であって `tools` の `mcp__` 接頭辞ではない — サーバは
 *  **面に付いていながらツールを1本も出さない**状態(認証待ち・接続失敗)を持ち、
 *  ベンダー側の門が動いたとき最初に現れるのはまさにその状態だからである。
 *
 *  読み手は名前と `status` の両方を返す(ADR 0331 決定6): `tidepool` の status は Worker MCP 到達性が読み、
 *  封じ込めの照合は名前だけに写して読む。 */
describe("readInitMcpServers", () => {
  const init = (extra: Record<string, unknown>) =>
    parseStreamLine(JSON.stringify({ type: "system", subtype: "init", ...extra }));

  it("init 行の `mcp_servers` から名前と status が取れる", () => {
    expect(
      readInitMcpServers(
        init({
          mcp_servers: [
            { name: "tidepool", status: "failed" },
            { name: "computer-use", status: "connected", source: "dynamic" },
          ],
        }),
      ),
    ).toEqual([
      { name: "tidepool", status: "failed" },
      { name: "computer-use", status: "connected" },
    ]);
  });

  it("MCP サーバが1つも無い面は空配列 — probe が撃つ形がこれである", () => {
    expect(readInitMcpServers(init({ mcp_servers: [] }))).toEqual([]);
  });

  it("init 行でなければ null — 「init 報告ではない」を空の答えと読ませない", () => {
    expect(readInitMcpServers(parseStreamLine('{"type":"assistant","mcp_servers":[]}'))).toBeNull();
    expect(readInitMcpServers(parseStreamLine("not json"))).toBeNull();
  });

  it("`mcp_servers` が配列でなければ null", () => {
    expect(readInitMcpServers(init({ mcp_servers: { tidepool: "connected" } }))).toBeNull();
    expect(readInitMcpServers(init({}))).toBeNull();
  });

  it("要素が名前を持たなければ null — 半分だけ読めた面を面として通さない", () => {
    expect(readInitMcpServers(init({ mcp_servers: [{ status: "connected" }] }))).toBeNull();
    expect(readInitMcpServers(init({ mcp_servers: ["tidepool"] }))).toBeNull();
  });

  it("要素が文字列の status を持たなければ null — 読めない init 報告", () => {
    expect(readInitMcpServers(init({ mcp_servers: [{ name: "tidepool" }] }))).toBeNull();
    expect(readInitMcpServers(init({ mcp_servers: [{ name: "tidepool", status: null }] }))).toBeNull();
  });
});

/** ADR 0156 決定3: auto-memory の読みが閉じていることは init 行の `memory_paths.auto`
 *  の不在として観測する。null が「閉じている」、それ以外は観測値(呼び出し側が不成立に
 *  倒す)。`auto` だけを読むので、ベンダーが別種の memory を足しても誤停止しない。 */
describe("readInitAutoMemoryPath", () => {
  const init = (extra: Record<string, unknown>) =>
    parseStreamLine(JSON.stringify({ type: "system", subtype: "init", ...extra }));

  it("`memory_paths.auto` の文字列をそのまま返す", () => {
    expect(readInitAutoMemoryPath(init({ memory_paths: { auto: "/home/pi/.claude/projects/x/memory/" } }))).toBe(
      "/home/pi/.claude/projects/x/memory/",
    );
  });

  it("`memory_paths` が無い / `auto` 以外の項目だけなら null(閉じている)", () => {
    expect(readInitAutoMemoryPath(init({}))).toBeNull();
    expect(readInitAutoMemoryPath(init({ memory_paths: { team: "/x" } }))).toBeNull();
  });

  it("読めない形は閉じているとみなさない — 観測値を JSON で返して不成立に倒させる", () => {
    expect(readInitAutoMemoryPath(init({ memory_paths: { auto: { dir: "/x" } } }))).toBe('{"dir":"/x"}');
    expect(readInitAutoMemoryPath(init({ memory_paths: "/x" }))).toBe('"/x"');
    expect(readInitAutoMemoryPath(init({ memory_paths: null }))).toBe("null");
  });
});

/** root の拒否の数え方(ADR 0215 決定3 / ADR 0416 決定1・2)。worker session と Board call はこれを呼ぶだけ。 */
describe("collectRefusal", () => {
  // 1段目の拒否の通知の実物(2.1.286、`-p` stream-json、2026-11-25、VM、#1615)。逐語
  const notice = { type: "system", subtype: "informational", content: "Sonnet 5.5's safeguards stopped the response above · continuing once with that noted", level: "notice", uuid: "58544d22-17dc-4145-a0ab-413d7cc0216e", session_id: "297d86fe-1ed4-4a7f-a77f-e58a4cbe0bb7" };
  const collect = (...lines: object[]) => {
    const refusals = new Map<unknown, string | null>();
    for (const line of lines) collectRefusal(refusals, parseStreamLine(JSON.stringify(line)));
    return [...refusals.values()];
  };

  it("1段目の拒否の通知は分類 null の1件(ADR 0416 決定1)", () => {
    expect(collect(notice)).toEqual([null]);
  });

  it("level が notice でない、または文面の末尾が違う informational の行は数えない(ADR 0416 決定1)", () => {
    expect(collect({ ...notice, level: "info" }, { ...notice, content: "Sonnet 5.5's safeguards stopped the response above" })).toEqual([]);
  });

  it("合成の拒否行は message.id ごとに1つで、分類の無い行は null、subagent の行は数えない(ADR 0215 決定3 / ADR 0416 決定2)", () => {
    expect(
      collect(
        syntheticRefusalLine("a", "cyber"),
        syntheticRefusalLine("a", "cyber"),
        { ...syntheticRefusalLine("sub", "bio"), parent_tool_use_id: "toolu_task" },
        syntheticRefusalLine("b"),
      ),
    ).toEqual(["cyber", null]);
  });

  it("通知と合成の拒否行は出た順に並び、通知は1行ごとに1件で重複を除かない(ADR 0416 決定1・2)", () => {
    expect(collect(notice, syntheticRefusalLine("a", "cyber"), notice)).toEqual([null, "cyber", null]);
  });
});
