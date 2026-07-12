import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemMetadata } from "../../../src/types.js";

const pathExistsMock = vi.fn<() => Promise<boolean>>();
const readFileIfExistsMock = vi.fn<() => Promise<string | null>>();
const writeFileAtomicMock = vi.fn<() => Promise<void>>();
const readSettingsMock = vi.fn<() => Promise<unknown>>();
const listAllItemMetadataMock = vi.fn<() => Promise<ItemMetadata[]>>();
const listAllItemMetadataWithBodyMock = vi.fn<() => Promise<Array<ItemMetadata & { body: string }>>>();

vi.mock("../../../src/core/fs/fs-utils.js", () => ({
  pathExists: pathExistsMock,
  readFileIfExists: readFileIfExistsMock,
  writeFileAtomic: writeFileAtomicMock,
}));

vi.mock("../../../src/core/store/settings.js", () => ({
  readSettings: readSettingsMock,
}));

vi.mock("../../../src/core/store/item-store.js", () => ({
  listAllItemMetadata: listAllItemMetadataMock,
  listAllItemMetadataWithBody: listAllItemMetadataWithBodyMock,
}));

describe("runList sorting branches", () => {
  beforeEach(() => {
    pathExistsMock.mockResolvedValue(true);
    readFileIfExistsMock.mockResolvedValue("{}");
    writeFileAtomicMock.mockResolvedValue(undefined);
    readSettingsMock.mockResolvedValue({});
    const baseItems: ItemMetadata[] = [
      {
        id: "pm-bbb",
        title: "same-time-id-b",
        description: "",
        type: "Task",
        status: "open",
        priority: 1,
        tags: [],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      {
        id: "pm-aaa",
        title: "same-time-id-a",
        description: "",
        type: "Task",
        status: "open",
        priority: 1,
        tags: [],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      {
        id: "pm-priority",
        title: "priority-wins",
        description: "",
        type: "Task",
        status: "open",
        priority: 0,
        tags: [],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:10:00.000Z",
      },
      {
        id: "pm-terminal",
        title: "terminal-item",
        description: "",
        type: "Task",
        status: "canceled",
        priority: 0,
        tags: [],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:20:00.000Z",
      },
      {
        id: "pm-updated-old",
        title: "updated-old",
        description: "",
        type: "Task",
        status: "open",
        priority: 3,
        tags: [],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:05:00.000Z",
      },
      {
        id: "pm-updated-new",
        title: "updated-new",
        description: "",
        type: "Task",
        status: "open",
        priority: 3,
        tags: [],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:06:00.000Z",
      },
    ];
    listAllItemMetadataMock.mockResolvedValue(baseItems);
    listAllItemMetadataWithBodyMock.mockResolvedValue(baseItems.map((item) => ({ ...item, body: "" })));
  });

  it("orders open items before terminal then applies priority/updated/id tie-breakers", async () => {
    const { runList } = await import("../../../src/cli/commands/list.js");
    const result = await runList(undefined, {}, { path: "/tmp/pm-list-sort" });
    expect(result.items.map((item) => item.id)).toEqual([
      "pm-priority",
      "pm-aaa",
      "pm-bbb",
      "pm-updated-new",
      "pm-updated-old",
      "pm-terminal",
    ]);
  });

  it("covers terminal-first comparator branch", async () => {
    listAllItemMetadataMock.mockResolvedValueOnce([
      {
        id: "pm-terminal-first",
        title: "terminal-first",
        description: "",
        type: "Task",
        status: "closed",
        priority: 1,
        tags: [],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      {
        id: "pm-open-second",
        title: "open-second",
        description: "",
        type: "Task",
        status: "open",
        priority: 1,
        tags: [],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
    ]);

    const { runList } = await import("../../../src/cli/commands/list.js");
    const result = await runList(undefined, {}, { path: "/tmp/pm-list-sort" });
    expect(result.items.map((item) => item.id)).toEqual(["pm-open-second", "pm-terminal-first"]);
  });

  it("covers configurable sort field and order branches", async () => {
    const { runList } = await import("../../../src/cli/commands/list.js");
    const byPriorityDesc = await runList(undefined, { sort: "priority", order: "desc" }, { path: "/tmp/pm-list-sort" });
    expect(byPriorityDesc.items.map((item) => item.priority)).toEqual([3, 3, 1, 1, 0, 0]);

    const byTitleAsc = await runList(undefined, { sort: "title", order: "asc" }, { path: "/tmp/pm-list-sort" });
    expect(byTitleAsc.items.map((item) => item.title)).toEqual([
      "priority-wins",
      "same-time-id-a",
      "same-time-id-b",
      "terminal-item",
      "updated-new",
      "updated-old",
    ]);
  });

  it("covers nullable deadline and parent sort branches", async () => {
    listAllItemMetadataMock.mockResolvedValueOnce([
      {
        id: "pm-parent-a",
        title: "parent-a",
        description: "",
        type: "Task",
        status: "open",
        priority: 1,
        tags: [],
        parent: "pm-aaa",
        deadline: "2026-02-19T00:00:00.000Z",
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      {
        id: "pm-parent-null",
        title: "parent-null",
        description: "",
        type: "Task",
        status: "open",
        priority: 1,
        tags: [],
        deadline: undefined,
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      {
        id: "pm-parent-b",
        title: "parent-b",
        description: "",
        type: "Task",
        status: "open",
        priority: 1,
        tags: [],
        parent: "pm-bbb",
        deadline: "2026-02-20T00:00:00.000Z",
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
    ]);

    const { runList } = await import("../../../src/cli/commands/list.js");
    const byDeadlineAsc = await runList(undefined, { sort: "deadline", order: "asc" }, { path: "/tmp/pm-list-sort" });
    expect(byDeadlineAsc.items.map((item) => item.id)).toEqual(["pm-parent-a", "pm-parent-b", "pm-parent-null"]);

    listAllItemMetadataMock.mockResolvedValueOnce([
      {
        id: "pm-parent-a",
        title: "parent-a",
        description: "",
        type: "Task",
        status: "open",
        priority: 1,
        tags: [],
        parent: "pm-aaa",
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      {
        id: "pm-parent-null",
        title: "parent-null",
        description: "",
        type: "Task",
        status: "open",
        priority: 1,
        tags: [],
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
      {
        id: "pm-parent-b",
        title: "parent-b",
        description: "",
        type: "Task",
        status: "open",
        priority: 1,
        tags: [],
        parent: "pm-bbb",
        created_at: "2026-02-18T00:00:00.000Z",
        updated_at: "2026-02-18T00:00:00.000Z",
      },
    ]);
    const byParentAsc = await runList(undefined, { sort: "parent", order: "asc" }, { path: "/tmp/pm-list-sort" });
    expect(byParentAsc.items.map((item) => item.id)).toEqual(["pm-parent-a", "pm-parent-b", "pm-parent-null"]);
  });
});
