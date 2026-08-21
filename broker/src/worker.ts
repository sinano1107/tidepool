type GitHubFetch = typeof fetch;

interface Env {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
}

function json(error: string, status: number): Response {
	return Response.json({ error }, { status });
}

function githubHeaders(authorization: string): HeadersInit {
	return {
		Accept: "application/vnd.github+json",
		Authorization: authorization,
		"Content-Type": "application/json",
		"User-Agent": "tidepool-token-broker",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

function der(
	tag: number,
	content: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
	const length =
		content.length < 128
			? [content.length]
			: (() => {
					const bytes: number[] = [];
					for (let value = content.length; value > 0; value >>= 8) {
						bytes.unshift(value & 0xff);
					}
					return [0x80 | bytes.length, ...bytes];
				})();
	return Uint8Array.from([tag, ...length, ...content]);
}

function privateKeyBytes(pem: string): Uint8Array<ArrayBuffer> {
	const pkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
	const base64 = pem
		.replace(/-----BEGIN (RSA )?PRIVATE KEY-----/, "")
		.replace(/-----END (RSA )?PRIVATE KEY-----/, "")
		.replace(/\s/g, "");
	const key = Uint8Array.from(atob(base64), (character) =>
		character.charCodeAt(0),
	);
	if (!pkcs1) return key;

	const algorithm = Uint8Array.from([
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
		0x01, 0x05, 0x00,
	]);
	return der(
		0x30,
		Uint8Array.from([
			0x02,
			0x01,
			0x00,
			...algorithm,
			...der(0x04, key),
		]),
	);
}

function base64Url(value: string | Uint8Array): string {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	return btoa(String.fromCharCode(...bytes))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

async function appJwt(appId: string, privateKey: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({ exp: now + 9 * 60, iat: now - 60, iss: appId }))}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		privateKeyBytes(privateKey),
		{ hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsigned),
	);
	return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export function createWorker(githubFetch: GitHubFetch = fetch) {
	return {
		async fetch(request: Request, config: Env): Promise<Response> {
			const url = new URL(request.url);
			if (request.method !== "POST" || url.pathname !== "/token") {
				return json("route_not_found", 404);
			}

			const authorization = request.headers.get("Authorization") ?? "";
			const tokenMatch = /^Bearer ([^\s]+)$/.exec(authorization);
			if (!tokenMatch) return json("invalid_user_token", 401);

			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return json("invalid_request", 400);
			}
			const repo =
				typeof body === "object" && body !== null && "repo" in body
					? body.repo
					: undefined;
			if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
				return json("invalid_request", 400);
			}

			if (
				!config.GITHUB_APP_ID ||
				!config.GITHUB_APP_PRIVATE_KEY ||
				!config.GITHUB_CLIENT_ID ||
				!config.GITHUB_CLIENT_SECRET
			) {
				return json("configuration_error", 500);
			}

			const userToken = tokenMatch[1];
			try {
				const checked = await githubFetch(
					`https://api.github.com/applications/${encodeURIComponent(config.GITHUB_CLIENT_ID)}/token`,
					{
						body: JSON.stringify({ access_token: userToken }),
						headers: githubHeaders(
							`Basic ${btoa(`${config.GITHUB_CLIENT_ID}:${config.GITHUB_CLIENT_SECRET}`)}`,
						),
						method: "POST",
					},
				);
				if (!checked.ok) return json("invalid_user_token", 401);

				const [owner, name] = repo.split("/") as [string, string];
				const repository = await githubFetch(
					`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
					{
						headers: githubHeaders(`Bearer ${userToken}`),
						method: "GET",
					},
				);
				if (repository.status === 404) return json("repo_not_found", 404);
				if (!repository.ok) return json("github_error", 502);
				const repositoryBody = (await repository.json()) as {
					permissions?: { push?: unknown };
				};
				if (typeof repositoryBody?.permissions?.push !== "boolean") {
					return json("github_error", 502);
				}
				if (!repositoryBody.permissions.push) return json("push_denied", 403);

				const jwt = await appJwt(
					config.GITHUB_APP_ID,
					config.GITHUB_APP_PRIVATE_KEY,
				);
				const installation = await githubFetch(
					`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
					{
						headers: githubHeaders(`Bearer ${jwt}`),
						method: "GET",
					},
				);
				if (installation.status === 404) {
					return json("app_not_installed", 403);
				}
				if (!installation.ok) return json("github_error", 502);
				const installationBody = (await installation.json()) as {
					id?: unknown;
				};
				const installationId = installationBody?.id;
				if (
					typeof installationId !== "number" ||
					!Number.isSafeInteger(installationId) ||
					installationId < 1
				) {
					return json("github_error", 502);
				}

				const issued = await githubFetch(
					`https://api.github.com/app/installations/${installationId}/access_tokens`,
					{
						body: JSON.stringify({ repositories: [name] }),
						headers: githubHeaders(`Bearer ${jwt}`),
						method: "POST",
					},
				);
				if (!issued.ok) return json("github_error", 502);
				const issuedBody = (await issued.json()) as {
					expires_at?: unknown;
					token?: unknown;
				};
				if (
					typeof issuedBody?.token !== "string" ||
					issuedBody.token.length === 0 ||
					typeof issuedBody.expires_at !== "string" ||
					issuedBody.expires_at.length === 0
				) {
					return json("github_error", 502);
				}
				return Response.json({
					expires_at: issuedBody.expires_at,
					token: issuedBody.token,
				});
			} catch {
				return json("github_error", 502);
			}
		},
	};
}

export default createWorker();
