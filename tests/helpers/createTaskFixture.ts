import { expect } from "vitest";
import type { TempPmContext } from "./withTempPmPath.js";

/** Create one open Task through the real CLI test harness. */
export function createTaskFixture(
  context: TempPmContext,
  id: string,
  description: string,
): void {
  const result = context.runCli(
    [
      "create",
      "--id",
      id,
      "--title",
      id,
      "--description",
      description,
      "--type",
      "Task",
      "--status",
      "open",
      "--json",
    ],
    { expectJson: true },
  );
  expect(
    result.code,
    `create ${id} failed: ${result.stderr || result.stdout}`,
  ).toBe(0);
}
