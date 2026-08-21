const test = require("node:test");
const assert = require("node:assert");
const { slugify } = require("./slugify");
test("lowercases and hyphenates", () => assert.equal(slugify("Hello World"), "hello-world"));
test("drops punctuation", () => assert.equal(slugify("a.b,c"), "abc"));
test("strips leading hyphen", () => assert.equal(slugify(" lead"), "lead"));
