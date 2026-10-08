import { defineConfig, type UserConfig } from "vitest/config";
import repositoryConfig from "../../../vitest.config.ts";

const config = repositoryConfig as UserConfig;

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    // Each retry control is one file; do not inherit the repository's projects.
    projects: undefined,
    include: ["tests/fixtures/vitest-reliability/*.test.ts"],
  },
});
