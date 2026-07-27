import { describe, expect, it, vi } from "vitest";
import * as sdk from "../../../src/sdk/index.js";
import {
  renderGuideShellPackageOutput,
  runCompletionPackage,
  runCompletionStatusesPackage,
  runCompletionTagsPackage,
  runCompletionTypesPackage,
  runGuidePackage,
} from "../../../packages/pm-guide-shell/extensions/guide-shell/runtime.ts";

describe("guide-shell static SDK runtime", () => {
  it("normalizes guide and completion inputs through public SDK functions", async () => {
    const guide = vi.spyOn(sdk, "runGuide").mockResolvedValue({ topic: "sdk" } as never);
    await runGuidePackage([" sdk "], { list: true, format: "json", depth: "deep" }, { path: "/tmp/pm" });
    expect(guide).toHaveBeenCalledWith(
      { topic: " sdk ", list: true, format: "json", depth: "deep" },
      { path: "/tmp/pm" },
    );
    await runGuidePackage([], { topic: "commands", list: false }, {});
    expect(guide).toHaveBeenLastCalledWith(
      { topic: "commands", list: undefined, format: undefined, depth: undefined },
      {},
    );
    await runGuidePackage(["   "], {}, {});
    expect(guide).toHaveBeenLastCalledWith(
      { topic: undefined, list: undefined, format: undefined, depth: undefined },
      {},
    );

    vi.spyOn(sdk, "pathExists").mockResolvedValue(false);
    const completion = vi.spyOn(sdk, "runCompletion").mockReturnValue({ script: "complete" } as never);
    await runCompletionPackage([" zsh "], { itemTypes: "Task,Issue", tags: "one,two", eagerTags: true }, {});
    expect(completion).toHaveBeenCalledWith("zsh", ["Task", "Issue"], ["one", "two"], true, {});
    await runCompletionPackage([], { shell: "fish", item_types: "Feature", eager_tags: false }, {});
    expect(completion).toHaveBeenLastCalledWith("fish", ["Feature"], [], false, {});
    await runCompletionPackage([], {}, {});
    expect(completion).toHaveBeenLastCalledWith("bash", [], [], false, {});
    vi.restoreAllMocks();
  });

  it("builds completion registries and list helpers across schema shapes", async () => {
    vi.spyOn(sdk, "pathExists").mockResolvedValue(true);
    vi.spyOn(sdk, "readSettings").mockResolvedValue({
      item_format: "json_markdown",
      schema: {},
    } as never);
    vi.spyOn(sdk, "getActiveExtensionRegistrations").mockReturnValue([] as never);
    const typeRegistry = vi.spyOn(sdk, "resolveItemTypeRegistry").mockReturnValue({
      types: ["Task", "Task", "", 3],
      type_to_folder: { Task: "tasks" },
    } as never);
    vi.spyOn(sdk, "resolveRuntimeStatusRegistry").mockReturnValue({
      definitions: [{ id: "open" }, { id: "" }, { id: 3 }, { id: "closed" }],
    } as never);
    vi.spyOn(sdk, "resolveRuntimeFieldRegistry").mockReturnValue({
      command_to_fields: new Map([
        ["list", [{ cli_flag: "customer_impact" }, { cli_flag: "assignee" }, { cli_flag: "customer_impact" }, { cli_flag: "" }, { cli_flag: 3 }]],
      ]),
    } as never);
    const completion = vi.spyOn(sdk, "runCompletion").mockReturnValue({ script: "ok" } as never);

    await runCompletionPackage(["bash"], {}, { path: "/tmp/pm" });
    expect(completion).toHaveBeenCalledWith(
      "bash",
      [],
      [],
      false,
      {
        item_types: ["Task"],
        statuses: ["closed", "open"],
        command_flags: { list: ["--assignee", "--customer-impact"] },
      },
    );

    vi.spyOn(sdk, "listAllItemMetadata").mockResolvedValue([
      { tags: ["beta", " alpha ", "", 3] },
      {},
      { tags: ["beta"] },
    ] as never);
    await expect(runCompletionTagsPackage({ path: "/tmp/pm" })).resolves.toEqual({
      tags: ["alpha", "beta"],
      count: 2,
    });
    await expect(runCompletionStatusesPackage({ path: "/tmp/pm" })).resolves.toEqual({
      statuses: ["closed", "open"],
      count: 2,
    });
    await expect(runCompletionTypesPackage({ path: "/tmp/pm" })).resolves.toEqual({
      types: ["Task"],
      count: 1,
    });

    typeRegistry.mockReturnValue({
      types: ["Issue"],
      type_to_folder: { Issue: "issues" },
    } as never);
    await expect(runCompletionTypesPackage({ path: "/tmp/pm" })).resolves.toEqual({
      types: ["Issue"],
      count: 1,
    });
    await runCompletionTagsPackage({ path: "/tmp/pm" });
    expect(sdk.listAllItemMetadata).toHaveBeenLastCalledWith(
      "/tmp/pm",
      "json_markdown",
      { Issue: "issues" },
      undefined,
      {},
    );

    typeRegistry.mockReturnValue({ types: [], type_to_folder: {} } as never);
    vi.mocked(sdk.resolveRuntimeStatusRegistry).mockReturnValue({ definitions: [] } as never);
    vi.mocked(sdk.resolveRuntimeFieldRegistry).mockReturnValue({
      command_to_fields: new Map(),
    } as never);
    await runCompletionPackage([], {}, { path: "/tmp/pm" });
    expect(completion).toHaveBeenLastCalledWith(
      "bash",
      [],
      [],
      false,
      { item_types: undefined, statuses: undefined, command_flags: undefined },
    );
    await expect(runCompletionTypesPackage({ path: "/tmp/pm" })).resolves.toEqual({
      types: [],
      count: 0,
    });
    await runCompletionTagsPackage({ path: "/tmp/pm" });

    vi.mocked(sdk.pathExists).mockResolvedValue(false);
    await expect(runCompletionTagsPackage({ path: "/tmp/missing" })).resolves.toEqual({
      tags: [],
      count: 0,
    });
    vi.restoreAllMocks();
  });

  it("renders guide, completion, and word-list result families", () => {
    const renderGuide = vi.spyOn(sdk, "renderGuideMarkdown").mockReturnValue("# guide");
    const format = vi.spyOn(sdk, "resolveGuideOutputFormat");
    format.mockReturnValueOnce("markdown");
    expect(
      renderGuideShellPackageOutput({
        command: "guide",
        payload: { result: { topic: "sdk" } },
      } as never),
    ).toBe("# guide\n");
    expect(renderGuide).toHaveBeenCalled();

    format.mockReturnValueOnce("json");
    expect(
      renderGuideShellPackageOutput({
        command: "guide",
        payload: { result: { topic: "sdk" } },
      } as never),
    ).toContain('"topic": "sdk"');
    format.mockReturnValueOnce("toon" as never);
    expect(
      renderGuideShellPackageOutput({
        command: "guide",
        payload: { format: "json", result: { topic: "sdk" } },
      } as never),
    ).toContain('"topic": "sdk"');
    format.mockReturnValueOnce("toon" as never);
    expect(renderGuideShellPackageOutput({ command: "guide", payload: {} } as never)).toBeNull();

    expect(
      renderGuideShellPackageOutput({
        command: "completion",
        payload: { result: { script: "complete" } },
      } as never),
    ).toBe("complete\n");
    expect(
      renderGuideShellPackageOutput({
        command: "completion",
        payload: { result: { script: "complete\n" } },
      } as never),
    ).toBe("complete\n");
    expect(
      renderGuideShellPackageOutput({
        command: "completion",
        payload: { result: {} },
      } as never),
    ).toBeNull();
    expect(
      renderGuideShellPackageOutput({
        command: "completion",
        payload: { format: "json", result: { script: "complete" } },
      } as never),
    ).toContain('"script": "complete"');

    for (const [command, key] of [
      ["completion-tags", "tags"],
      ["completion-statuses", "statuses"],
      ["completion-types", "types"],
    ] as const) {
      expect(
        renderGuideShellPackageOutput({
          command,
          payload: { result: { [key]: ["a", 2, "b"] } },
        } as never),
      ).toBe("a b\n");
      expect(
        renderGuideShellPackageOutput({
          command,
          payload: { format: "json", result: { [key]: ["a"] } },
        } as never),
      ).toContain(`"${key}"`);
    }
    expect(
      renderGuideShellPackageOutput({
        command: "completion-tags",
        payload: { result: null },
      } as never),
    ).toBe("\n");
    expect(
      renderGuideShellPackageOutput({
        command: "completion-tags",
        payload: { result: { tags: "not-an-array" } },
      } as never),
    ).toBe("\n");
    expect(renderGuideShellPackageOutput({ command: "unknown", payload: null } as never)).toBeNull();
    vi.restoreAllMocks();
  });
});
