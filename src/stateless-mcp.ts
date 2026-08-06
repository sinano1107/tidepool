import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { json, type Request, Router } from "express";

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
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return router;
}
