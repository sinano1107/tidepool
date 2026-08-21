import { beforeAll, describe, expect, it } from "vitest";
import { createWorker } from "../src/worker.js";

let appPrivateKey = "";
const env = {
	GITHUB_APP_ID: "12345",
	get GITHUB_APP_PRIVATE_KEY() {
		return appPrivateKey;
	},
	GITHUB_CLIENT_ID: "Iv1.tidepool-client",
	GITHUB_CLIENT_SECRET: "client-secret-value",
};

function tokenRequest(userToken = "ghu-user-token") {
	return new Request("https://broker.example/token", {
		body: JSON.stringify({ repo: "owner/project" }),
		headers: {
			Authorization: `Bearer ${userToken}`,
			"Content-Type": "application/json",
		},
		method: "POST",
	});
}

beforeAll(async () => {
	const key = await crypto.subtle.generateKey(
		{
			hash: "SHA-256",
			modulusLength: 2048,
			name: "RSASSA-PKCS1-v1_5",
			publicExponent: new Uint8Array([1, 0, 1]),
		},
		true,
		["sign", "verify"],
	);
	const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
	const base64 = btoa(String.fromCharCode(...bytes));
	appPrivateKey = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
});

describe("token broker", () => {
	it("rejects every route except POST /token", async () => {
		const githubRequests: Request[] = [];
		const worker = createWorker(async (input) => {
			githubRequests.push(new Request(input));
			return new Response(null, { status: 500 });
		});

		for (const request of [
			new Request("https://broker.example/token"),
			new Request("https://broker.example/other", { method: "POST" }),
		]) {
			const response = await worker.fetch(request, env);

			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "route_not_found" });
		}
		expect(githubRequests).toEqual([]);
	});

	it("rejects a user token not issued by this App", async () => {
		const userToken = "ghu-foreign-user-token";
		const githubRequests: Request[] = [];
		const worker = createWorker(async (input, init) => {
			githubRequests.push(new Request(input, init));
			return Response.json({ message: "Bad credentials" }, { status: 404 });
		});

		const response = await worker.fetch(tokenRequest(userToken), env);
		const body = await response.text();

		expect(response.status).toBe(401);
		expect(JSON.parse(body)).toEqual({ error: "invalid_user_token" });
		expect(body).not.toContain(userToken);
		expect(githubRequests).toHaveLength(1);
		expect(githubRequests[0]?.url).toBe(
			"https://api.github.com/applications/Iv1.tidepool-client/token",
		);
		expect(githubRequests[0]?.method).toBe("POST");
		expect(await githubRequests[0]?.json()).toEqual({ access_token: userToken });
	});

	it("refuses a repo the user cannot push to", async () => {
		const userToken = "ghu-read-only-user-token";
		const githubRequests: Request[] = [];
		const githubResponses = [
			Response.json({ id: 1 }),
			Response.json({ permissions: { push: false } }),
		];
		const worker = createWorker(async (input, init) => {
			githubRequests.push(new Request(input, init));
			return githubResponses.shift() ?? new Response(null, { status: 500 });
		});

		const response = await worker.fetch(tokenRequest(userToken), env);
		const body = await response.text();

		expect(response.status).toBe(403);
		expect(JSON.parse(body)).toEqual({ error: "push_denied" });
		expect(body).not.toContain(userToken);
		expect(githubRequests).toHaveLength(2);
		expect(githubRequests[1]?.url).toBe(
			"https://api.github.com/repos/owner/project",
		);
		expect(githubRequests[1]?.method).toBe("GET");
		expect(githubRequests[1]?.headers.get("Authorization")).toBe(
			`Bearer ${userToken}`,
		);
	});

	it("reports a repo the user cannot see as not found", async () => {
		const userToken = "ghu-user-without-repo-visibility";
		const githubResponses = [
			Response.json({ id: 1 }),
			Response.json(
				{ message: `GitHub rejected ${userToken}` },
				{ status: 404 },
			),
		];
		const worker = createWorker(async () =>
			githubResponses.shift() ?? new Response(null, { status: 500 }),
		);

		const response = await worker.fetch(tokenRequest(userToken), env);
		const body = await response.text();

		expect(response.status).toBe(404);
		expect(JSON.parse(body)).toEqual({ error: "repo_not_found" });
		expect(body).not.toContain(userToken);
	});

	it("reports an App installation missing from the repo with a distinct forbidden code", async () => {
		const userToken = "ghu-user-token-for-uninstalled-repo";
		const upstreamToken = "ghs-upstream-error-token";
		const githubRequests: Request[] = [];
		const githubResponses = [
			Response.json({ id: 1 }),
			Response.json({ permissions: { push: true } }),
			Response.json(
				{ message: "Not Found", token: upstreamToken },
				{ status: 404 },
			),
		];
		const worker = createWorker(async (input, init) => {
			githubRequests.push(new Request(input, init));
			return githubResponses.shift() ?? new Response(null, { status: 500 });
		});

		const response = await worker.fetch(tokenRequest(userToken), env);
		const body = await response.text();

		expect(response.status).toBe(403);
		expect(JSON.parse(body)).toEqual({ error: "app_not_installed" });
		expect(githubRequests).toHaveLength(3);
		expect(githubRequests[2]?.url).toBe(
			"https://api.github.com/repos/owner/project/installation",
		);
		const appAuthorization = githubRequests[2]?.headers.get("Authorization");
		expect(appAuthorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
		for (const token of [
			userToken,
			upstreamToken,
			env.GITHUB_CLIENT_SECRET,
			appAuthorization?.slice("Bearer ".length) ?? "missing-app-token",
		]) {
				expect(body).not.toContain(token);
			}
	});

	it("returns a token scoped to only the requested repo", async () => {
		const installationToken = "ghs-repo-installation-token";
		const expiresAt = "2026-08-21T06:00:00Z";
		const githubRequests: Request[] = [];
		const githubResponses = [
			Response.json({ id: 1 }),
			Response.json({ permissions: { push: true } }),
			Response.json({ id: 9876 }),
			Response.json({ expires_at: expiresAt, token: installationToken }),
		];
		const worker = createWorker(async (input, init) => {
			githubRequests.push(new Request(input, init));
			return githubResponses.shift() ?? new Response(null, { status: 500 });
		});

		const response = await worker.fetch(tokenRequest(), env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			expires_at: expiresAt,
			token: installationToken,
		});
		expect(githubRequests).toHaveLength(4);
		expect(githubRequests[3]?.url).toBe(
			"https://api.github.com/app/installations/9876/access_tokens",
		);
		expect(githubRequests[3]?.method).toBe("POST");
		expect(await githubRequests[3]?.json()).toEqual({
			repositories: ["project"],
		});
	});
});
