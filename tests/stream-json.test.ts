import { describe, expect, it } from "vitest";
import { parseStreamLine, readInitMcpServers } from "../src/stream-json.js";

/** ADR 0108 決定2: 封じ込めの3つ目の問いが MCP 軸で見るのは init 行の
 *  `mcp_servers[].name` であって `tools` の `mcp__` 接頭辞ではない — サーバは
 *  **面に付いていながらツールを1本も出さない**状態(認証待ち・接続失敗)を持ち、
 *  ベンダー側の門が動いたとき最初に現れるのはまさにその状態だからである。
 *
 *  この射影が読むのは**名前だけ**である。`status` を返さないことが、照合側で
 *  「`tidepool` が `status: "failed"` で現れても不成立にしない」(ADR 0039 決定3 の
 *  欠落側)を構造として守っている。 */
describe("readInitMcpServers", () => {
  const init = (extra: Record<string, unknown>) =>
    parseStreamLine(JSON.stringify({ type: "system", subtype: "init", ...extra }));

  it("init 行の `mcp_servers` から名前が取れる — status は読まない", () => {
    expect(
      readInitMcpServers(
        init({
          mcp_servers: [
            { name: "tidepool", status: "failed" },
            { name: "computer-use", status: "connected" },
          ],
        }),
      ),
    ).toEqual(["tidepool", "computer-use"]);
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
});
