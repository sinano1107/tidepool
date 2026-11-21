import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** 何が観測された要求か: 仲介が受け取った repo と bearer(= 差し替え可能な user
 *  token の実物)。GitHub の REST の代役として立てたときは method・path・body も読む(ADR 0396)。 */
export interface BrokerRequest {
  repo: string;
  bearer: string | undefined;
  method: string | undefined;
  path: string | undefined;
  body: Record<string, unknown>;
}

export interface BrokerAnswer {
  status?: number;
  body?: unknown;
  /** 応答せずに接続を切る —— 到達失敗(timeout も同じ catch 節)の再現。 */
  destroy?: boolean;
  /** 応答しないまま接続を持ち続ける —— 呼び手の上限の再現。 */
  hang?: boolean;
}

export interface FakeBroker {
  url: string;
  requests: BrokerRequest[];
  close: () => Promise<void>;
}

/** ADR 0093 の仲介(Cloudflare Worker)の代役。**盤面の外側**に実 HTTP で立てる
 *  ので、テストは `GitHubAuth` のキャッシュや fetch の順序ではなく、仲介との
 *  往復と子プロセス env という2つの観測点だけを見る。`reply` は要求ごとに応答を
 *  決められるので、期限(`expires_at`)を動かすだけで「残り5分」の境界を実時間
 *  なしで踏める。 */
export async function startFakeBroker(
  reply: (request: BrokerRequest, index: number) => BrokerAnswer,
): Promise<FakeBroker> {
  const requests: BrokerRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const authorization = req.headers.authorization;
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      const request: BrokerRequest = {
        repo: String(body.repo),
        method: req.method,
        path: req.url,
        body,
        bearer: authorization?.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : undefined,
      };
      requests.push(request);
      const answer = reply(request, requests.length - 1);
      if (answer.destroy) {
        res.socket?.destroy();
        return;
      }
      if (answer.hang) return;
      res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 期限つきの成功応答。`minutesLeft` が 5 を切れば次の `ensure` で撃ち直される。 */
export function issuedToken(token: string, minutesLeft = 60): BrokerAnswer {
  return { body: { token, expires_at: new Date(Date.now() + minutesLeft * 60_000).toISOString() } };
}
