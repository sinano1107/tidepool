import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { json, type Request, Router } from "express";
import { z } from "zod";

/** issue #1075: 登録の入口で inputSchema を strict にし、未知の引数を tool error にする。
 *  schema の無い verb も空の strict object を持つ。共有 schema は `.strict()` の複製なので変わらない。
 *  ponytail: top-level のキーだけ —— 入れ子の object(decompose の children など)は strict にしない */
export function rejectUnknownArguments(server: McpServer): McpServer {
  const register = server.registerTool.bind(server) as (...args: any[]) => any;
  server.registerTool = ((name: string, config: { inputSchema?: z.ZodObject | z.ZodRawShape }, cb: unknown) => {
    const schema = config.inputSchema;
    const inputSchema = schema instanceof z.ZodObject ? schema.strict() : z.strictObject(schema ?? {});
    return register(name, { ...config, inputSchema }, cb);
  }) as McpServer["registerTool"];
  return server;
}

/** The shared per-request Streamable HTTP lifecycle for stateless MCP servers. */
export function createStatelessMcpRouter(buildServer: (req: Request) => McpServer): Router {
  const router = Router();
  router.use(json());
  router.post("/", async (req, res) => {
    const server = buildServer(req);
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
