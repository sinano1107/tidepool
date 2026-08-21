const test = require("node:test");
const assert = require("node:assert");
const { parseDuration } = require("./duration");
test("single units", () => {
  assert.equal(parseDuration("1h"), 3600000);
  assert.equal(parseDuration("2m"), 120000);
  assert.equal(parseDuration("3s"), 3000);
});
test("combined, any order", () => {
  assert.equal(parseDuration("1h30m15s"), 5415000);
  assert.equal(parseDuration("15s1h"), 3615000);
});
test("rejects bad input", () => {
  assert.throws(() => parseDuration(""), TypeError);
  assert.throws(() => parseDuration("1x"), TypeError);
  assert.throws(() => parseDuration("1h1h"), TypeError);
  assert.throws(() => parseDuration("h1"), TypeError);
  assert.throws(() => parseDuration(42), TypeError);
});
