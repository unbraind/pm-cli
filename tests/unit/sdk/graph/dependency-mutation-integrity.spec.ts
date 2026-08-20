import { describe, expect, it } from "vitest";
import { mutateItemWithHistoryContext } from "../../../../src/core/store/item-store.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { runCreate } from "../../../../src/sdk/lifecycle/create.js";
import {
  _testOnlyUpdateCommand,
  runUpdate,
} from "../../../../src/sdk/lifecycle/update.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("dependency mutation integrity", () => {
  it("applies one malformed-shorthand grammar to additions and removals", () => {
    expect(() =>
      _testOnlyUpdateCommand.parseDependencyAdditions(
        ["OTHER,related"],
        "pm-",
        "2026-08-20T00:00:00.000Z",
        "agent",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "dependency_flag_value_invalid",
        context: expect.objectContaining({ flag: "--dep" }),
      }),
    );
    expect(() =>
      _testOnlyUpdateCommand.parseDependencyRemovals(
        ["OTHER,related"],
        "pm-",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "dependency_flag_value_invalid",
        context: expect.objectContaining({ flag: "--dep-remove" }),
      }),
    );
  });

  it("returns a typed refusal when a removal selector matches no edge", async () => {
    await withTempPmPath(async (context) => {
      const created = await runCreate(
        {
          title: "Zero-match dependency holder",
          type: "Task",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );

      await expect(
        runUpdate(
          created.item.id,
          { depRemove: ["pm-missing"], message: "remove missing edge" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        code: "dependency_remove_no_match",
        exitCode: EXIT_CODE.NOT_FOUND,
        context: expect.objectContaining({
          reason: "selector_not_found",
          unmatched_selectors: [{ id: "pm-missing" }],
          available_dependencies: [],
        }),
      });
    });
  });

  it("collapses a touched duplicate identity without removing the edge", async () => {
    await withTempPmPath(async (context) => {
      const target = await runCreate(
        {
          title: "Duplicate dependency target",
          type: "Task",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      const holder = await runCreate(
        {
          title: "Duplicate dependency holder",
          type: "Task",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      const duplicate = {
        id: target.item.id,
        kind: "related" as const,
        created_at: "2026-08-20T00:00:00.000Z",
        author: "legacy-import",
        source_kind: "manual",
      };
      await mutateItemWithHistoryContext({
        pmRoot: context.pmPath,
        settings: await readSettings(context.pmPath),
        id: holder.item.id,
        op: "seed_duplicate_dependency_fixture",
        author: "test",
        mutate(document) {
          document.metadata.dependencies = [duplicate, { ...duplicate }];
          return { changedFields: ["dependencies"] };
        },
      });

      const remediated = await runUpdate(
        holder.item.id,
        {
          dep: [
            `id=${target.item.id},kind=related,source_kind=manual`,
          ],
          message: "normalize touched dependency identity",
        },
        { path: context.pmPath },
      );

      expect(remediated.changed_fields).toContain("dependencies");
      expect(remediated.item.dependencies).toEqual([duplicate]);
    });
  });
});
