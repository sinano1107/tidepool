import { afterEach, expect, it } from "vitest";
import { AUTH_HEADERS, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

// The design-system mirror files (styles.css / _ds_bundle.js) are served from
// the repo root, not public/. Without them the WebUI white-screens to the
// "recompile the design system" fallback (issue #108).
//
// These assets 404'd when the board booted from a checkout whose absolute path
// carries a dot-directory ancestor (e.g. a git worktree under `.claude/`):
// `res.sendFile(absolutePath)` with no `root` option lets Express's `send`
// run its dotfile check over the WHOLE resolved path, and `dotfiles: 'ignore'`
// (the default) then refuses any segment starting with `.`. The fix routes the
// send through the `root`-option path (like express.static), so only the URL's
// relative segment is dotfile-checked. This test reproduces the bug directly
// whenever the suite itself runs from a `.claude/worktrees/...` checkout.
it("GET /styles.css serves the stylesheet, not a dotfile 404 (issue #108)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/styles.css`, { headers: AUTH_HEADERS });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("css");
});

it("GET /_ds_bundle.js serves the design-system bundle (issue #108)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/_ds_bundle.js`, { headers: AUTH_HEADERS });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
});
