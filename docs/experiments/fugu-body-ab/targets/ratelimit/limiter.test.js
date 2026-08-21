const test = require("node:test");
const assert = require("node:assert");
const { Limiter } = require("./limiter");
test("allows up to limit then rejects", () => {
  let t = 0;
  const l = new Limiter(3, 1000, () => t);
  assert.deepEqual([l.allow("k"), l.allow("k"), l.allow("k"), l.allow("k")], [true, true, true, false]);
});
test("window resets", () => {
  let t = 0;
  const l = new Limiter(1, 1000, () => t);
  assert.equal(l.allow("k"), true);
  assert.equal(l.allow("k"), false);
  t = 1000;
  assert.equal(l.allow("k"), true);
});
test("keys are independent", () => {
  const l = new Limiter(1, 1000, () => 0);
  assert.equal(l.allow("a"), true);
  assert.equal(l.allow("b"), true);
});
