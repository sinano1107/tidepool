import { expect, it } from "vitest";
import { whyInvalidRegistryName } from "../src/registry-name.js";

it("registry names accept the shared charset but refuse reserved names and path separators", () => {
  for (const name of ["tako", "Agent_2.0-test"]) expect(whyInvalidRegistryName(name)).toBeUndefined();
  for (const name of [".", "..", "a/b", ""]) {
    expect(whyInvalidRegistryName(name)).toBe("must contain only letters, digits, '-', '_', '.' and not be '.' or '..'");
  }
});
