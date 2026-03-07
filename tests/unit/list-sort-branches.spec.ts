import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemFrontMatter } from "../../src/types.js";

const pathExistsMock = vi.fn<() => Promise<boolean>>();
const readFileIfExistsMock = vi.fn<() => Promise<string | null>>();
const writeFileAtomicMock = vi.fn<() => Promise<void>>();
const readSettingsMock = vi.fn<() => Promise<unknown>>();
const listAllFrontMatterMock = vi.fn<() => Promise<ItemFrontMatter[]>>();

vi.mock("../../src/fs-utils.js", () => ({
  pathExists: pathExistsMock,
  readFileIfExists: readFileIfExistsMock,
  writeFileAtomic: writeFileAtomicMock,
}));

vi.mock("../../src/core/fs/fs-utils.js", () => ({
  pathExists: pathExistsMock,
  readFileIfExists: readFileIfExistsMock,
  writeFileAtomic: writeFileAtomicMock,
}));

vi.mock("../../src/settings.js", () => ({
  readSettings: readSettingsMock,
}));

vi.mock("../../src/core/store/settings.js", () => ({
  readSettings: readSettingsMock,
}));

vi.mock("../../src/item-store.js", () => ({
  listAllFrontMatter: listAllFrontMatterMock,
}));

vi.mock("../../src/core/store/item-store.js", () => ({
  listAllFrontMatter: listAllFrontMatterMock,
}));

describe("runList sorting branches", () => {
  beforeEach(() => {
    pathExistsMock.mockResolvedValue(true);
    readFileIfExistsMock.mockResolvedValue("{}");
    writeFileAtomicMock.mockResolvedValue(undefined);
    readSettingsMock.mockResolvedValue({});
    listAllFrontMatterMock.mockResolvedValue([
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
    ]);
  });

  it("orders open items before terminal then applies priority/updated/id tie-breakers", async () => {
    const { runList } = await import("../../src/cli/commands/list.js");
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
    listAllFrontMatterMock.mockResolvedValueOnce([
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

    const { runList } = await import("../../src/cli/commands/list.js");
    const result = await runList(undefined, {}, { path: "/tmp/pm-list-sort" });
    expect(result.items.map((item) => item.id)).toEqual(["pm-open-second", "pm-terminal-first"]);
  });
});
