---
name: webui-e2e
description: Drive tidepool's WebUI (public/index.html) in a real browser with Playwright — to smoke-check a screen, reproduce a UI-wiring bug, or promote a check into a lasting smoke test. Use when the user wants to verify the browser UI, not the server (server-boundary logic is covered by vitest). Do NOT fire on a generic "run the tests".
---

# WebUI E2E — real-browser checks for `public/index.html`

tidepool stops automated tests at the server boundary (ADR 0027). The one layer that
leaves unguarded is the JSX React wiring compiled into `public/app.js` — no source
type-checking. This skill drives that layer in a real browser. The agent owns this
check now; there is no separate human acceptance step (ADR 0029).

Full harness type and gotchas: `docs/webui-e2e-harness.md`. Read it before writing a
spec — it is the source of truth; this skill is the workflow around it.

## Default: write a throwaway scratch check

Unless the user explicitly asks to promote, every check is **throwaway**:

1. Write `e2e/<name>.scratch.spec.ts` (`.scratch.spec.ts` is `.gitignore`d — it never
   gets committed).
2. Import from `./fixtures.js`, boot with `boot(opts)`, injecting only the seams the
   screen needs (`hostSkills`, `agentAdmin`, `workspaceAdmin`, …). See
   `tests/harness.ts` `BootOptions` for the full seam list.
3. `page.goto(t.baseUrl)`, then assert with auto-waiting locators. The human surface
   requires a credential (ADR 0036 / issue #153), but `boot()` already walks the
   bootstrap URL to set the cookie — a spec that wants the *unauthenticated* view calls
   `page.context().clearCookies()` first.
4. Run `npm run e2e` (add `<name>.scratch` to target just yours).

```ts
import { expect, test } from "./fixtures.js";

test("...", async ({ boot, page }) => {
  const t = await boot({ hostSkills: async () => ["deep-research"] });
  await page.goto(t.baseUrl);
  await expect(page.getByText("...")).toBeVisible();
});
```

The first paint waits on: local vendor scripts → DS bundle → prebuilt app → React mount
→ `/api` fetch. Lean on locator auto-wait; do **not** wait on `networkidle`.

## Selectors

- Prefer `getByRole` / `getByLabel`. Playwright matches accessible name / textContent,
  so the CSS `text-transform` uppercase mismatch is gone.
- Japanese UI copy changes (the quality bar is high, issue #48). Do **not** couple a
  lasting spec to wording. For fragile critical-path elements, add a `data-testid` to
  the owning JSX source (`webui/app.jsx`, a shared component under `design-system/components/`,
  or a kit-only component under `ui_kits/`) and target that.
- `fill()` / `type()` dispatch the events React's `onChange` needs — no native
  value-setter tricks.

## Promotion: only on explicit instruction

Never auto-commit a check. Keep everything scratch by default. When you notice a check
covers a critical path where a regression would hurt, you may **propose** promotion with
that rationale — but wait for the user's go-ahead.

Promotion is `rename + tidy selectors`: `e2e/<name>.scratch.spec.ts` →
`e2e/<name>.spec.ts`, replace any brittle selectors with role/testid, keep the `test()`
shape (scratch and promoted use the same form, which is why promotion is cheap).

**Promotion infrastructure already exists (ADR 0055).** WebUI scripts are prebuilt and
served same-origin, CI has an independent e2e job using Playwright's pinned Chromium,
and committed `e2e/*.spec.ts` files are typechecked. Do not regress those conditions;
`tests/generated-assets.test.ts` guards the committed build outputs. Google Fonts remain
external by design and fall back at the CSS layer; the executable WebUI does not depend
on them.

## Keep it few

E2E is expensive to maintain. Promote only critical paths; let the rest stay scratch and
be deleted. A large brittle suite is exactly what ADR 0027 warns against.

## References

- `docs/webui-e2e-harness.md` — the harness type, gotchas, and CI promotion infrastructure
- ADR 0027 (tests stop at the server boundary) / ADR 0029 (agent drives browser checks)
- `e2e/fixtures.ts` (`boot`) / `e2e/settings-drilldown.spec.ts` (the first promoted smoke)
- `tests/harness.ts` (`bootTidepool`, `BootOptions` seam list)
