import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

interface PageResult {
  items?: Array<{ id: string }>;
  high_level?: Array<{ id: string }>;
  low_level?: Array<{ id: string }>;
  next_cursor?: string;
  has_more?: boolean;
  truncated?: boolean;
}

function createPaginationItems(
  runCli: (args: string[], options: { expectJson: boolean }) => {
    code: number;
  },
): void {
  for (let index = 0; index < 6; index += 1) {
    const created = runCli(
      [
        "create",
        "--create-mode",
        "progressive",
        "--title",
        `Pagination item ${index}`,
        "--type",
        index % 3 === 0 ? "Feature" : "Task",
        "--status",
        "open",
        "--priority",
        String(index % 2),
        "--author",
        "pagination-test",
        "--json",
      ],
      { expectJson: true },
    );
    expect(created.code).toBe(0);
  }
}

function focusIds(result: PageResult): string[] {
  return [
    ...(result.high_level ?? []).map((item) => item.id),
    ...(result.low_level ?? []).map((item) => item.id),
  ];
}

describe("query cursor pagination", () => {
  it("continues list, search, and context without duplicate rows", async () => {
    await withTempPmPath(async ({ runCli, tempRoot }) => {
      createPaginationItems(runCli);

      const firstListRun = runCli(
        ["list", "--status", "open", "--limit", "2", "--brief", "--json"],
        { expectJson: true },
      );
      const firstList = firstListRun.json as PageResult;
      expect(firstListRun.code).toBe(0);
      expect(firstList.has_more).toBe(true);
      expect(firstList.truncated).toBe(true);
      expect(firstList.next_cursor).toBeTypeOf("string");
      const secondListRun = runCli(
        [
          "list",
          "--status",
          "open",
          "--limit",
          "2",
          "--brief",
          "--after",
          firstList.next_cursor!,
          "--json",
        ],
        { expectJson: true },
      );
      const secondList = secondListRun.json as PageResult;
      expect(secondListRun.code).toBe(0);
      expect(
        secondList.items?.some((item) =>
          firstList.items?.some((first) => first.id === item.id),
        ),
      ).toBe(false);

      const firstSearchRun = runCli(
        ["search", "Pagination", "--limit", "2", "--compact", "--json"],
        { expectJson: true },
      );
      const firstSearch = firstSearchRun.json as PageResult;
      expect(firstSearchRun.code).toBe(0);
      expect(firstSearch.next_cursor).toBeTypeOf("string");
      const secondSearchRun = runCli(
        [
          "search",
          "Pagination",
          "--limit",
          "2",
          "--compact",
          "--after",
          firstSearch.next_cursor!,
          "--json",
        ],
        { expectJson: true },
      );
      const secondSearch = secondSearchRun.json as PageResult;
      expect(secondSearchRun.code).toBe(0);
      expect(
        secondSearch.items?.some((item) =>
          firstSearch.items?.some((first) => first.id === item.id),
        ),
      ).toBe(false);

      const firstContextRun = runCli(
        ["context", "--limit", "2", "--section", "progress", "--json"],
        { expectJson: true, cwd: tempRoot },
      );
      const firstContext = firstContextRun.json as PageResult;
      expect(firstContextRun.code).toBe(0);
      expect(firstContext.next_cursor).toBeTypeOf("string");
      const secondContextRun = runCli(
        [
          "context",
          "--limit",
          "2",
          "--section",
          "progress",
          "--after",
          firstContext.next_cursor!,
          "--json",
        ],
        { expectJson: true, cwd: tempRoot },
      );
      const secondContext = secondContextRun.json as PageResult;
      expect(secondContextRun.code).toBe(0);
      expect(
        focusIds(secondContext).some((id) => focusIds(firstContext).includes(id)),
      ).toBe(false);
    });
  });

  it("rejects cursor conflicts and query mismatches with usage errors", async () => {
    await withTempPmPath(async ({ runCli }) => {
      createPaginationItems(runCli);
      const first = runCli(
        ["list", "--status", "open", "--limit", "2", "--json"],
        { expectJson: true },
      ).json as PageResult;
      expect(
        runCli(
          [
            "list",
            "--status",
            "open",
            "--offset",
            "1",
            "--after",
            first.next_cursor!,
            "--json",
          ],
          { expectJson: true },
        ).code,
      ).toBe(2);
      expect(
        runCli(
          [
            "list",
            "--status",
            "closed",
            "--after",
            first.next_cursor!,
            "--json",
          ],
          { expectJson: true },
        ).code,
      ).toBe(2);
      expect(
        runCli(
          ["search", "Pagination", "--count", "--after", "bad", "--json"],
          { expectJson: true },
        ).code,
      ).toBe(2);
    });
  });
});
