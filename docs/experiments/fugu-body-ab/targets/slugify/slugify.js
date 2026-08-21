// slugify: turn a human title into a URL slug.
// Spec (docs/SPEC.md): lowercase; whitespace -> "-"; drop any char that is
// not [a-z0-9-]; collapse runs of "-" into one; no leading/trailing "-".
//
// Implemented as a single pass over the string rather than a regex chain so
// that each rule is visible as a branch. Performance is irrelevant at the
// sizes we handle (titles < 200 chars).
function slugify(title) {
  var out = "";
  var chars = String(title).toLowerCase();
  for (var i = 0; i < chars.length; i++) {
    var c = chars[i];
    if (c === " " || c === "\t" || c === "\n") {
      out += "-";
    } else if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-") {
      out += c;
    }
    // anything else is dropped
  }
  while (out.charAt(0) === "-") out = out.slice(1);
  return out;
}
module.exports = { slugify };
