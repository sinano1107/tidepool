import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../vitest.config.js";

// #3334: the real vitest.config.ts with only `include` swapped, so the child run goes through the real globalSetup wiring.
// The fixture is named outside vitest's default include, so the parent suite never collects it.
export default mergeConfig(base, defineConfig({ test: { include: ["tests/fixtures/repo-location-git-env/*.fixture.ts"] } }));
