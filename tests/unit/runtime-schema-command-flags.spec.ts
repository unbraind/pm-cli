import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureRuntimeSchemaFileScaffold,
  filePathForSchemaSection,
  loadRuntimeSchemaFromOptionalFiles,
  normalizeRuntimeSchemaSettings,
  normalizeStatusInputWithRegistry,
  runtimeFieldOptionTarget,
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  statusIsTerminal,
  type RuntimeFieldRegistry,
} from "../../src/core/schema/runtime-schema.js";
import {
  coerceRuntimeFieldValue,
  collectRuntimeCreateFieldValues,
  collectRuntimeUpdateFieldValues,
  readRuntimeFieldOptionValue,
} from "../../src/core/schema/runtime-field-values.js";
import {
  collectRuntimeFilterValues,
  matchesRuntimeFilters,
} from "../../src/core/schema/runtime-field-filters.js";
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

  it("normalizes type workflows, status roles, and runtime field defaults", () => {
    const normalized = normalizeRuntimeSchemaSettings({
      version: 2.8,
      statuses: [
        { id: "triage", aliases: ["To Do", "to-do"], roles: ["default_open", "active"], order: 20 },
        { id: "done", roles: ["terminal", "terminal_done", "default_close"], order: Number.NaN },
        { id: "blocked", roles: ["blocked"], description: " blocked work " },
        { id: "drafting", roles: ["draft"] },
      ],
      fields: [
        {
          key: "Customer Segment",
          front_matter_key: "customerSegment",
          cli_flag: "--segment",
          cli_aliases: ["--cust_seg", "segment"],
          description: " segment field ",
          type: "unknown" as "string",
          commands: [],
          allow_unset: false,
        },
        {
          key: "labels",
          type: "string_array",
        },
        {
          key: "labels",
          metadata_key: "label_values",
          type: "string_array",
          commands: ["list"],
        },
      ],
      workflow: {
        open_status: "To Do",
        close_status: undefined,
      },
      type_workflows: [
        { type: " Task ", allowed_transitions: [] },
        {
          type: "Issue",
          allowed_transitions: [["triage", "done"], ["triage", "done"], ["triage", ""], ["bad"] as [string, string]],
        },
        { type: "Bug", allowed_transitions: [["x", "y", "z"] as unknown as [string, string]] },
      ],
      unknown_field_policy: "REJECT",
    });

    expect(normalized.version).toBe(2);
    expect(normalized.unknown_field_policy).toBe("reject");
    expect(normalizeRuntimeSchemaSettings({ unknown_field_policy: "STRICT" }).unknown_field_policy).toBe("allow");
    expect(normalized.type_workflows).toEqual([
      { type: "Issue", allowed_transitions: [["triage", "done"]] },
      { type: "Task", allowed_transitions: [] },
    ]);
    expect(normalized.fields).toContainEqual(
      expect.objectContaining({
        key: "customer_segment",
        metadata_key: "customersegment",
        cli_flag: "segment",
        cli_aliases: ["cust-seg"],
        type: "string",
        commands: ["create", "update"],
        allow_unset: false,
      }),
    );
    expect(normalized.fields).toContainEqual(
      expect.objectContaining({
        key: "labels",
        metadata_key: "label_values",
        repeatable: true,
        commands: ["list"],
      }),
    );

    const statusRegistry = resolveRuntimeStatusRegistry(normalized);
    expect(statusRegistry.open_status).toBe("to_do");
    expect(statusRegistry.close_status).toBe("done");
    expect(statusRegistry.active_statuses.has("triage")).toBe(true);
    expect(statusRegistry.blocked_statuses.has("blocked")).toBe(true);
    expect(statusRegistry.draft_statuses.has("drafting")).toBe(true);
    expect(normalizeStatusInputWithRegistry("to do", statusRegistry)).toBe("triage");
    expect(statusIsTerminal("done", statusRegistry)).toBe(true);
    expect(statusIsTerminal("missing", statusRegistry)).toBe(false);

    const fieldRegistry = resolveRuntimeFieldRegistry(normalized);
    const segment = fieldRegistry.by_key.get("customer_segment");
    expect(segment).toBeDefined();
    expect(runtimeFieldOptionTarget(segment!)).toBe("customerSegment");
    expect(fieldRegistry.by_cli_token.get("cust-seg")).toBe(segment);
    expect(fieldRegistry.command_to_fields.get("list")?.map((field) => field.key)).toEqual(["labels"]);
  });

  it("scaffolds and loads runtime schema sections from multiple supported file shapes", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-runtime-schema-files-"));
    try {
      const absoluteFieldsPath = path.join(tempRoot, "absolute-fields.json");
      const schema = normalizeRuntimeSchemaSettings({
        files: {
          types: "custom/types.json",
          statuses: "custom/statuses.json",
          fields: absoluteFieldsPath,
          workflows: "custom/workflows.json",
        },
      });

      const scaffold = await ensureRuntimeSchemaFileScaffold(tempRoot, schema);
      expect(scaffold.created_paths.sort()).toEqual([
        absoluteFieldsPath,
        path.join(tempRoot, "custom", "statuses.json"),
        path.join(tempRoot, "custom", "types.json"),
        path.join(tempRoot, "custom", "workflows.json"),
      ].sort());
      expect(await ensureRuntimeSchemaFileScaffold(tempRoot, schema)).toEqual({ created_paths: [] });
      expect(filePathForSchemaSection(tempRoot, absoluteFieldsPath, "fallback.json")).toBe(absoluteFieldsPath);
      expect(filePathForSchemaSection(tempRoot, " relative.json ", "fallback.json")).toBe(path.join(tempRoot, "relative.json"));

      await writeFile(
        path.join(tempRoot, "custom", "types.json"),
        `${JSON.stringify({ item_types: { definitions: [{ name: "Spike", folder: "spikes" }] } })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(tempRoot, "custom", "statuses.json"),
        `${JSON.stringify({ definitions: [{ id: "review", aliases: ["in-review"], roles: ["active"] }] })}\n`,
        "utf8",
      );
      await writeFile(
        absoluteFieldsPath,
        `${JSON.stringify([{ key: "risk", type: "number", commands: ["create"] }])}\n`,
        "utf8",
      );
      await writeFile(
        path.join(tempRoot, "custom", "workflows.json"),
        `${JSON.stringify({
          workflows: { open_status: "review" },
          type_workflows: [{ type: "Spike", allowed_transitions: [["review", "closed"]] }],
        })}\n`,
        "utf8",
      );

      const loaded = await loadRuntimeSchemaFromOptionalFiles(tempRoot, schema);
      expect(loaded.warnings).toEqual([]);
      expect(loaded.type_definitions_from_file).toEqual([{ name: "Spike", folder: "spikes" }]);
      expect(loaded.schema.statuses).toContainEqual(expect.objectContaining({ id: "review", aliases: ["in_review"] }));
      expect(loaded.schema.fields).toContainEqual(expect.objectContaining({ key: "risk", type: "number", commands: ["create"] }));
      expect(loaded.schema.workflow.open_status).toBe("review");
      expect(loaded.schema.type_workflows).toEqual([{ type: "Spike", allowed_transitions: [["review", "closed"]] }]);

      await writeFile(path.join(tempRoot, "custom", "types.json"), "{}", "utf8");
      await writeFile(path.join(tempRoot, "custom", "statuses.json"), "\"bad\"", "utf8");
      await writeFile(absoluteFieldsPath, "{", "utf8");
      await writeFile(path.join(tempRoot, "custom", "workflows.json"), "[]", "utf8");
      const malformed = await loadRuntimeSchemaFromOptionalFiles(tempRoot, schema);
      expect(malformed.warnings.sort()).toEqual([
        "runtime_schema_fields_invalid_json",
        "runtime_schema_statuses_invalid_shape",
        "runtime_schema_types_invalid_shape",
        "runtime_schema_workflows_invalid_shape",
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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

function buildFieldRegistry(): RuntimeFieldRegistry {
  return resolveRuntimeFieldRegistry(
    normalizeRuntimeSchemaSettings({
      fields: [
        {
          key: "customer_segment",
          type: "string",
          commands: ["create", "update", "update_many", "list"],
          cli_aliases: ["segment", "cust-seg"],
          required_on_create: true,
          required_types: ["Task"],
        },
        {
          key: "story_points",
          type: "number",
          commands: ["create", "update", "list"],
        },
        {
          key: "verified",
          type: "boolean",
          commands: ["create", "update"],
        },
        {
          key: "labels",
          type: "string_array",
          commands: ["create", "update", "update_many", "list"],
          repeatable: true,
        },
        {
          key: "mandatory_everywhere",
          type: "string",
          commands: ["create"],
          required: true,
        },
      ],
    }),
  );
}

describe("runtime field value coercion", () => {
  const registry = buildFieldRegistry();
  const definition = (key: string) => {
    const resolved = registry.by_key.get(key);
    expect(resolved, `missing field definition ${key}`).toBeDefined();
    return resolved!;
  };

  it("reads option values through camelCase flag and alias candidates", () => {
    expect(readRuntimeFieldOptionValue({ customerSegment: "smb" }, definition("customer_segment"))).toBe("smb");
    expect(readRuntimeFieldOptionValue({ segment: "smb" }, definition("customer_segment"))).toBe("smb");
    expect(readRuntimeFieldOptionValue({ custSeg: "smb" }, definition("customer_segment"))).toBe("smb");
    expect(readRuntimeFieldOptionValue({ custSeg: undefined }, definition("customer_segment"))).toBeUndefined();
    expect(readRuntimeFieldOptionValue({}, definition("customer_segment"))).toBeUndefined();
  });

  it("coerces scalar number, boolean, and string values with usage errors", () => {
    expect(coerceRuntimeFieldValue(definition("story_points"), "5")).toBe(5);
    expect(coerceRuntimeFieldValue(definition("story_points"), 8)).toBe(8);
    expect(coerceRuntimeFieldValue(definition("story_points"), ["3", "5"])).toBe(5);
    expect(() => coerceRuntimeFieldValue(definition("story_points"), "many")).toThrow("must be a number");

    expect(coerceRuntimeFieldValue(definition("verified"), true)).toBe(true);
    expect(coerceRuntimeFieldValue(definition("verified"), 1)).toBe(true);
    expect(coerceRuntimeFieldValue(definition("verified"), 0)).toBe(false);
    expect(coerceRuntimeFieldValue(definition("verified"), "YES")).toBe(true);
    expect(coerceRuntimeFieldValue(definition("verified"), "no")).toBe(false);
    expect(() => coerceRuntimeFieldValue(definition("verified"), "maybe")).toThrow("true|false|1|0|yes|no");
    expect(() => coerceRuntimeFieldValue(definition("verified"), 7, "--verified")).toThrow("--verified");

    expect(coerceRuntimeFieldValue(definition("customer_segment"), 42)).toBe("42");
    expect(coerceRuntimeFieldValue(definition("customer_segment"), undefined)).toBeUndefined();
  });

  it("splits repeatable values on commas, pipes, and newlines", () => {
    expect(coerceRuntimeFieldValue(definition("labels"), "a, b|c\nd")).toEqual(["a", "b", "c", "d"]);
    expect(coerceRuntimeFieldValue(definition("labels"), ["a,b", ["c"], null, 4])).toEqual(["a", "b", "c", "4"]);
    expect(coerceRuntimeFieldValue(definition("labels"), undefined)).toEqual([]);
  });

  it("collects create values and reports missing type-scoped required flags", () => {
    const matched = collectRuntimeCreateFieldValues(
      { customerSegment: "smb", storyPoints: "3", mandatoryEverywhere: "x" },
      registry,
      "task",
    );
    expect(matched.values).toEqual({ customer_segment: "smb", story_points: 3, mandatory_everywhere: "x" });
    expect(matched.missing_required_flags).toEqual([]);

    const missing = collectRuntimeCreateFieldValues({}, registry, "Task");
    expect(missing.missing_required_flags).toEqual(["--customer-segment", "--mandatory-everywhere"]);

    // Type-scoped requirement does not fire for other types or unknown types,
    // but unconditional requirements always do.
    expect(collectRuntimeCreateFieldValues({}, registry, "Issue").missing_required_flags).toEqual([
      "--mandatory-everywhere",
    ]);
    expect(collectRuntimeCreateFieldValues({}, registry, undefined).missing_required_flags).toEqual([
      "--mandatory-everywhere",
    ]);
  });

  it("collects update values once per metadata key across command scopes", () => {
    const values = collectRuntimeUpdateFieldValues(
      { customerSegment: "enterprise", labels: "x,y" },
      registry,
      ["update", "update_many"],
    );
    expect(values).toEqual({ customer_segment: "enterprise", labels: ["x", "y"] });
    expect(collectRuntimeUpdateFieldValues({ verified: "true" }, registry)).toEqual({ verified: true });
    expect(collectRuntimeUpdateFieldValues({ verified: "true" }, registry, null)).toEqual({ verified: true });
    expect(collectRuntimeUpdateFieldValues({}, registry)).toEqual({});
  });
});

describe("runtime field filters", () => {
  const registry = buildFieldRegistry();

  it("collects list filters from provided options only", () => {
    expect(collectRuntimeFilterValues({ customerSegment: "smb", labels: "a,b" }, registry, "list")).toEqual({
      customer_segment: "smb",
      labels: ["a", "b"],
    });
    expect(collectRuntimeFilterValues({}, registry, "list")).toEqual({});
    expect(collectRuntimeFilterValues({ customerSegment: "smb" }, registry, "search")).toEqual({});
  });

  it("matches scalar filters and array filters with subset semantics", () => {
    expect(matchesRuntimeFilters({ customer_segment: "smb" }, { customer_segment: "smb" })).toBe(true);
    expect(matchesRuntimeFilters({ customer_segment: "ent" }, { customer_segment: "smb" })).toBe(false);
    expect(matchesRuntimeFilters({ labels: ["a", "b", "c"] }, { labels: ["a", "c"] })).toBe(true);
    expect(matchesRuntimeFilters({ labels: ["a"] }, { labels: ["a", "c"] })).toBe(false);
    // Array filter against scalar value falls back to last-entry equality.
    expect(matchesRuntimeFilters({ labels: "c" }, { labels: ["a", "c"] })).toBe(true);
    expect(matchesRuntimeFilters({ labels: "a" }, { labels: ["a", "c"] })).toBe(false);
    expect(matchesRuntimeFilters({}, {})).toBe(true);
  });
});
