import { existsSync, writeFileSync } from "node:fs";

import { test } from "vitest";

test("passes only after one transient attempt", () => {
  const statePath = process.env.PM_VITEST_RETRY_STATE;
  if (!statePath) {
    throw new Error("PM_VITEST_RETRY_STATE is required");
  }
  if (!existsSync(statePath)) {
    writeFileSync(statePath, "attempted\n", "utf8");
    throw new Error("synthetic transient timeout control");
  }
});
