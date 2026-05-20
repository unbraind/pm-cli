import { describe, expect, it } from "vitest";
import { normalizeRuntimeSchemaSettings, resolveRuntimeStatusRegistry } from "../../src/core/schema/runtime-schema.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createTaskWithSegment(
  context: TempPmContext,
  title: string,
  segment: string,
): void {
  const create = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--create-mode",
      "progressive",
      "--status",
      "open",
      "--priority",
      "1",
      "--customer-segment",
      segment,
    ],
    { expectJson: true },
  );
  expect(create.code).toBe(0);
}

describe("runtime schema command flag registration", () => {
  it("ignores malformed runtime schema tokens instead of throwing", () => {
    const normalized = normalizeRuntimeSchemaSettings({
      statuses: [
        {
          id: "open",
          aliases: ["todo", undefined] as unknown as string[],
          roles: ["default_open", undefined] as unknown as string[],
        },
        {
          id: undefined,
        } as unknown as { id: string },
      ],
      workflow: {
        open_status: undefined,
        close_status: "closed",
      },
      fields: [
        {
          key: "customer_segment",
          type: undefined,
          cli_aliases: ["segment", undefined] as unknown as string[],
          commands: ["create", undefined] as unknown as ["create"],
        },
      ],
      unknown_field_policy: undefined,
    });

    expect(normalized.statuses.map((status) => status.id)).toEqual(["open"]);
    expect(normalized.statuses[0]?.aliases).toEqual(["todo"]);
    expect(normalized.fields[0]).toMatchObject({
      key: "customer_segment",
      type: "string",
      cli_aliases: ["segment"],
      commands: ["create"],
    });

    const registry = resolveRuntimeStatusRegistry(normalized);
    expect(registry.alias_to_id.get("todo")).toBe("open");
  });

  it("supports runtime list flags on list command aliases", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "customer_segment",
          type: "string",
          commands: ["list", "create", "update", "search"],
          cli_aliases: ["segment"],
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");

      createTaskWithSegment(context, "Enterprise customer task", "enterprise");
      createTaskWithSegment(context, "SMB customer task", "smb");

      const filteredByPrimary = context.runCli(["list-open", "--json", "--customer-segment", "enterprise"], {
        expectJson: true,
      });
      expect(filteredByPrimary.code).toBe(0);
      const primaryJson = filteredByPrimary.json as {
        count: number;
        items: Array<{ title?: string }>;
      };
      expect(primaryJson.count).toBe(1);
      expect(primaryJson.items[0]?.title).toBe("Enterprise customer task");

      const filteredByAlias = context.runCli(["list-open", "--json", "--segment", "smb"], {
        expectJson: true,
      });
      expect(filteredByAlias.code).toBe(0);
      const aliasJson = filteredByAlias.json as {
        count: number;
        items: Array<{ title?: string }>;
      };
      expect(aliasJson.count).toBe(1);
      expect(aliasJson.items[0]?.title).toBe("SMB customer task");

      const filteredListAll = context.runCli(["list-all", "--json", "--customer-segment", "enterprise"], {
        expectJson: true,
      });
      expect(filteredListAll.code).toBe(0);
      expect((filteredListAll.json as { count: number }).count).toBe(1);
    });
  });
});
