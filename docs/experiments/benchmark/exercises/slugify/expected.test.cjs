// The expected answer: every rule of SPEC.md, run in the landed workspace (the harness's cwd).
// Kept outside workspace/ so the worker never sees it.
const test = require("node:test");
const assert = require("node:assert");
const { join } = require("node:path");
const { slugify } = require(join(process.cwd(), "slugify.js"));

test("1. lowercase", () => assert.equal(slugify("ABC"), "abc"));
test("2. any whitespace becomes a hyphen", () => assert.equal(slugify("a\tb\nc\rd"), "a-b-c-d"));
test("3. characters outside [a-z0-9-] are dropped", () => assert.equal(slugify("a.b,c!"), "abc"));
// planted defect 1
test("4. runs of hyphens collapse", () => assert.equal(slugify("a  b--c"), "a-b-c"));
// planted defect 2
test("5. no trailing hyphen", () => assert.equal(slugify("trail "), "trail"));
test("5. no leading hyphen", () => assert.equal(slugify("  lead"), "lead"));
