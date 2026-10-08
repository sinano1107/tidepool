import { expect, it } from "vitest";
import { isSettled } from "../src/task-status.js";

it("done and cancelled are settled; todo and in_progress are not", () => {
  expect(isSettled("done")).toBe(true);
  expect(isSettled("cancelled")).toBe(true);
  expect(isSettled("todo")).toBe(false);
  expect(isSettled("in_progress")).toBe(false);
});
