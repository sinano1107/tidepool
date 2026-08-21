# slugify spec
1. Output is lowercase.
2. Any whitespace becomes "-".
3. Characters outside [a-z0-9-] are dropped.
4. Runs of "-" collapse to a single "-".
5. No leading or trailing "-".
