import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("close-many branch coverage", () => {
  it("coerces non-string item titles to empty strings in dry-run plans", async () => {
    vi.doMock("../../../src/core/fs/fs-utils.js", () => ({
      pathExists: vi.fn(async () => true),
    }));
    vi.doMock("../../../src/core/store/paths.js", () => ({
      resolvePmRoot: vi.fn(() => "/tmp/pm-close-many-branch"),
      getSettingsPath: vi.fn(() => "/tmp/pm-close-many-branch/settings.json"),
    }));
    vi.doMock("../../../src/core/store/settings.js", () => ({
      readSettings: vi.fn(async () => ({
        author_default: "tester",
        item_format: "toon",
        id_prefix: "pm",
        governance: {
          require_close_reason: true,
          close_validation_default: "warn",
        },
        schema: {},
      })),
    }));
    vi.doMock("../../../src/core/schema/runtime-schema.js", () => ({
      resolveRuntimeStatusRegistry: vi.fn(() => ({
        close_status: "closed",
        terminal_statuses: new Set(["closed", "done", "canceled"]),
      })),
    }));
    vi.doMock("../../../src/core/extensions/index.js", () => ({
      getActiveExtensionRegistrations: vi.fn(() => []),
    }));
    vi.doMock("../../../src/core/item/type-registry.js", () => ({
      resolveItemTypeRegistry: vi.fn(() => ({ type_to_folder: new Map<string, string>() })),
    }));
    vi.doMock("../../../src/core/store/item-store.js", () => ({
      listAllFrontMatterLight: vi.fn(async () => []),
    }));
    vi.doMock("../../../src/core/item/status.js", () => ({
      isTerminalStatus: vi.fn((status: string, registry: { terminal_statuses: Set<string> }) => registry.terminal_statuses.has(status)),
    }));
    vi.doMock("../../../src/cli/commands/list.js", () => ({
      runList: vi.fn(async () => ({
        items: [{ id: "pm-1", title: 123, status: "open" }],
        filters: { ids: "pm-1" },
      })),
    }));
    vi.doMock("../../../src/core/checkpoint/mutation-checkpoint.js", () => ({
      createCheckpointId: vi.fn(() => "checkpoint-1"),
      loadMutationCheckpoint: vi.fn(),
      restoreCheckpointItems: vi.fn(),
      writeMutationCheckpoint: vi.fn(),
    }));
    vi.doMock("../../../src/cli/commands/close.js", () => ({
      runClose: vi.fn(),
    }));
    vi.doMock("../../../src/cli/commands/restore.js", () => ({
      runRestore: vi.fn(),
    }));

    const { runCloseMany } = await import("../../../src/cli/commands/close-many.js");
    const result = await runCloseMany(
      {
        list: { ids: "pm-1" },
        reason: "dry-run branch",
        dryRun: true,
      },
      { path: "/tmp/pm-close-many-branch" },
    );

    expect(result.mode).toBe("dry_run");
    expect(result.item_plans?.[0]?.title).toBe("");
  });
});
