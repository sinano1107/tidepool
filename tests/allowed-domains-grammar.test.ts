import { describe, expect, it } from "vitest";
import { loadRegistry } from "../src/registry.js";
import { makeRegistry } from "./registry-fixture.js";

describe("workspaces.yaml の allowed_domains 文法検証", () => {
  it("ドメイン名とサブドメインワイルドカードは workspace エントリに載る", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - registry.npmjs.org
    - "*.example.com"
`,
    });

    expect(loadRegistry(dir, "purely-local").workspaces.tidepool?.allowed_domains).toEqual([
      "registry.npmjs.org",
      "*.example.com",
    ]);
  });

  it("空文字は entry と理由を名指しして拒否する", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - ""
`,
    });

    expect(() => loadRegistry(dir, "purely-local")).toThrow(
      'invalid allowed_domains entry "": empty domain',
    );
  });

  it("scheme 付き URL はドメイン名ではないため拒否する", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - https://example.com
`,
    });

    expect(() => loadRegistry(dir, "purely-local")).toThrow(
      'invalid allowed_domains entry "https://example.com": expected a domain name',
    );
  });

  it("path 付き host はドメイン名ではないため拒否する", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - example.com/packages
`,
    });

    expect(() => loadRegistry(dir, "purely-local")).toThrow(
      'invalid allowed_domains entry "example.com/packages": expected a domain name',
    );
  });

  it("port 付き host はドメイン名ではないため拒否する", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - "example.com:443"
`,
    });

    expect(() => loadRegistry(dir, "purely-local")).toThrow(
      'invalid allowed_domains entry "example.com:443": expected a domain name',
    );
  });

  it("裸のワイルドカードは明示確認でも買えないため拒否する", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - "*"
`,
    });

    expect(() => loadRegistry(dir, "purely-local")).toThrow(
      'invalid allowed_domains entry "*": bare wildcard is not allowed',
    );
  });

  it("IPv4 リテラルは tailnet の名前 deny を迂回できるため拒否する", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - 100.100.100.100
`,
    });

    expect(() => loadRegistry(dir, "purely-local")).toThrow(
      'invalid allowed_domains entry "100.100.100.100": IP literals are not allowed',
    );
  });

  it("IPv6 リテラルも tailnet の名前 deny を迂回できるため拒否する", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - "fd7a:115c:a1e0::1"
`,
    });

    expect(() => loadRegistry(dir, "purely-local")).toThrow(
      'invalid allowed_domains entry "fd7a:115c:a1e0::1": IP literals are not allowed',
    );
  });

  it.each(["1684300900", "127.1", "0x7f000001", "*.100.100.100.100"])(
    "URL client が IP と解釈する %s は拒否する",
    async (entry) => {
      const dir = await makeRegistry({
        "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - ${JSON.stringify(entry)}
`,
      });

      expect(() => loadRegistry(dir, "purely-local")).toThrow(
        `invalid allowed_domains entry "${entry}": IP literals are not allowed`,
      );
    },
  );

  it("DNS label 以外の文字を含む値は拒否する", async () => {
    const dir = await makeRegistry({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  allowed_domains:
    - bad_domain.example
`,
    });

    expect(() => loadRegistry(dir, "purely-local")).toThrow(
      'invalid allowed_domains entry "bad_domain.example": expected a domain name',
    );
  });
});
