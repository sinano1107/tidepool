// slugify: turn a human title into a URL slug. See SPEC.md.
function slugify(title) {
  let out = "";
  for (const c of String(title).toLowerCase()) {
    if (/\s/.test(c)) {
      out += "-";
    } else if (/[a-z0-9-]/.test(c)) {
      out += c;
    }
  }
  while (out.startsWith("-")) out = out.slice(1);
  return out;
}

module.exports = { slugify };
