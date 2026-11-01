import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { json, type Request, Router } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { floorResponse, type ResponseSurface } from "./response-budget.js";
import { sendJson } from "./send-json.js";
import { isBoardDbRefusal, type TerminateOnBoardDbRefusal } from "./unhandled-rejection-floor.js";

/** issue #1075: 登録の入口で inputSchema を strict にし、未知の引数を tool error にする。
 *  schema の無い verb も空の strict object を持つ。共有 schema は `.strict()` の複製なので変わらない。
 *  shortcut: top-level のキーだけ —— 入れ子の object(decompose の children など)は strict にしない。
 *  入れ子のキーの綴り違いが観測されたら shape を辿って strict にする */
export function rejectUnknownArguments(server: McpServer): McpServer {
  const register = server.registerTool.bind(server) as (...args: any[]) => any;
  server.registerTool = ((name: string, config: { inputSchema?: z.ZodObject | z.ZodRawShape }, cb: unknown) => {
    const schema = config.inputSchema;
    const inputSchema = schema instanceof z.ZodObject ? schema.strict() : z.strictObject(schema ?? {});
    return register(name, { ...config, inputSchema }, cb);
  }) as McpServer["registerTool"];
  return server;
}

/** ADR 0195 決定5: 全 verb の応答を出口の床に掛ける。verb の名前を知っているのは登録の層だけなので、ここで callback を包む。 */
export function floorEveryResponse(
  server: McpServer,
  context: { db: Db; clock: Clock; surface: ResponseSurface; taskId?: string | null },
): McpServer {
  const register = server.registerTool.bind(server) as (...args: any[]) => any;
  server.registerTool = ((name: string, config: unknown, cb: (...args: any[]) => any) =>
    register(name, config, async (...args: any[]) =>
      floorResponse(await cb(...args), { ...context, verb: name, at: context.clock.now() }),
    )) as McpServer["registerTool"];
  return server;
}

/** ADR 0342 決定4: SDK は投げた verb を tool error にするので、再 throw は底に届かない —— 盤面 DB の拒否は終了の関数を直接呼び、
 *  何も答えない(process は終わる途中で、tool error を読んだ worker が続けない)。`terminate` が無ければ包まない(再 throw)。
 *  `floorEveryResponse` より先に掛ける —— 後に掛けた包みほど内側で走るので、床の記録の拒否もここで受ける。 */
export function endOnBoardDbRefusal(server: McpServer, terminate: TerminateOnBoardDbRefusal | undefined, taskId?: string | null): McpServer {
  if (!terminate) return server;
  const register = server.registerTool.bind(server) as (...args: any[]) => any;
  server.registerTool = ((name: string, config: unknown, cb: (...args: any[]) => any) =>
    register(name, config, async (...args: any[]) => {
      try {
        return await cb(...args);
      } catch (err) {
        if (!isBoardDbRefusal(err)) throw err;
        terminate(err, { operation: name, ...(taskId && { taskId }) });
        return new Promise(() => {});
      }
    })) as McpServer["registerTool"];
  return server;
}

/** The shared per-request Streamable HTTP lifecycle for stateless MCP servers.
 *  `buildServer` returning a string refuses the request (initialize included) with that message. */
export function createStatelessMcpRouter(buildServer: (req: Request) => McpServer | string): Router {
  const router = Router();
  router.use(json());
  router.post("/", async (req, res) => {
    const server = buildServer(req);
    if (typeof server === "string") {
      // 403 にしない: Claude CLI は 403 を受けた server 名を `~/.claude/mcp-needs-auth-cache.json` に記録し、以後その名前の
      // server を繋ぎに行かず `needs-auth` と報告する(実測 2026-10-31、macOS、CLI 2.1.314 / 2.1.286)—— 古い probe 1回で
      // 同じホストの `tidepool` を使う worker が全部繋がらなくなる。404 / 400 / 401 は `failed` で記録は残らなかった
      sendJson(res.status(404), { jsonrpc: "2.0", error: { code: -32000, message: server }, id: null });
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    // issue #1075: arguments の省略は空の引数 —— strict の空 object を持つ verb が省略で拒否しないように
    for (const message of [req.body].flat())
      if (message?.method === "tools/call" && message.params) message.params.arguments ??= {};
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return router;
}
