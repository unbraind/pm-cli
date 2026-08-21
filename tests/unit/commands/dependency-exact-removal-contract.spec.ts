import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  _testOnlyUpdateCommand,
  runUpdate,
} from "../../../src/cli/commands/update.js";
import { runGet } from "../../../src/cli/commands/get.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { clearItemMetadataEnvelopeMemo } from "../../../src/core/store/item-metadata-cache.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

function createTask(context: TempPmContext, id: string): void {
  const result = context.runCli(
    [
      "create",
      "--id",
      id,
      "--title",
      id,
      "--description",
      "Exact dependency removal fixture",
      "--type",
      "Task",
      "--status",
      "open",
      "--json",
    ],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
}

describe("exact dependency removal contract", () => {
  it("parses and matches author/timestamp coordinates without broadening", () => {
    expect(
      _testOnlyUpdateCommand.parseDependencyRemovals(
        [
          "id=pm-target,type=related,source_kind=import,author=Owner,created_at=2026-01-02T00:00:00Z",
        ],
        "pm",
      ),
    ).toEqual([
      {
        id: "pm-target",
        kind: "related",
        source_kind: "import",
        author: "Owner",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(
      _testOnlyUpdateCommand.matchesDependencySelector(
        {
          id: "pm-target",
          kind: "related",
          source_kind: "import",
          author: "Owner",
          created_at: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "pm-target",
          kind: "related",
          source_kind: "import",
          author: "owner",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ),
    ).toBe(true);
    expect(
      _testOnlyUpdateCommand.matchesDependencySelector(
        {
          id: "pm-target",
          kind: "related",
          author: "Owner",
          created_at: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "pm-target",
          kind: "related",
          author: "Other",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ),
    ).toBe(false);
    expect(() =>
      _testOnlyUpdateCommand.parseDependencyRemovals(
        ["id=pm-target,created_at=not-a-date"],
        "pm",
      ),
    ).toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE }));
  });

  it("retires one legacy row while preserving a sibling with the same id and kind", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "pm-holder");
      createTask(context, "pm-target");
      const holderPath = path.join(context.pmPath, "tasks", "pm-holder.toon");
      writeFileSync(
        holderPath,
        readFileSync(holderPath, "utf8").replace(
          /^(priority:.*)$/m,
          '$1\ndependencies[2]{id,kind,created_at,author,source_kind}:\n  pm-target,related,"2026-01-01T00:00:00.000Z",first,import\n  pm-target,related,"2026-01-02T00:00:00.000Z",second,import',
        ),
        "utf8",
      );
      clearItemMetadataEnvelopeMemo();

      await runUpdate(
        "pm-holder",
        {
          depRemove: [
            "id=pm-target,kind=related,source_kind=import,author=first,created_at=2026-01-01T00:00:00.000Z",
          ],
        },
        { path: context.pmPath },
      );
      const remaining = await runGet("pm-holder", { path: context.pmPath });
      expect(remaining.item.dependencies).toEqual([
        expect.objectContaining({
          id: "pm-target",
          kind: "related",
          author: "second",
          created_at: "2026-01-02T00:00:00.000Z",
          source_kind: "import",
        }),
      ]);

      await expect(
        runUpdate(
          "pm-holder",
          {
            depRemove: [
              "id=pm-target,kind=related,author=missing,created_at=2026-01-02T00:00:00.000Z",
            ],
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        code: "dependency_remove_no_match",
        context: expect.objectContaining({
          available_dependencies: [
            expect.objectContaining({
              author: "second",
              created_at: "2026-01-02T00:00:00.000Z",
            }),
          ],
        }),
      });
    });
  });
});
