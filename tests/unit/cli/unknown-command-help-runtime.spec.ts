import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("unknown command help routing", () => {
  it("returns usage failures for arbitrary and plausible unknown help paths", async () => {
    await withTempPmPath(async (context) => {
      for (const command of ["definitely-not-a-command", "link"]) {
        const result = context.runCli([command, "--help"]);
        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.stdout + result.stderr).toContain(
          `Unknown command ${command}`,
        );
      }
    });
  });
});
