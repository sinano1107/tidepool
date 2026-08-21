// parseDuration("1h30m15s") -> milliseconds. Units: h, m, s. Order-free,
// each unit at most once. Throws on anything else.
const UNIT_MS = { h: 3600000, m: 60000, s: 1000 };
function parseDuration(input) {
  if (typeof input !== "string" || input.length === 0) throw new TypeError("duration must be a non-empty string");
  const re = /^(\d+)([hms])/;
  let rest = input, total = 0;
  const seen = new Set();
  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m) throw new TypeError(`invalid duration: ${JSON.stringify(input)}`);
    const [, n, unit] = m;
    if (seen.has(unit)) throw new TypeError(`unit ${unit} repeated in ${JSON.stringify(input)}`);
    seen.add(unit);
    total += Number(n) * UNIT_MS[unit];
    rest = rest.slice(m[0].length);
  }
  return total;
}
module.exports = { parseDuration };
