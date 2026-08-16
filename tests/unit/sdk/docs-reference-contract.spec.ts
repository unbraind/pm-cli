import { describe, expect, it } from "vitest";
import { runDocs } from "../../../src/sdk/docs.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("docs reference input contract", () => {
  it("preserves markdown and CSV label-URL pairs as single remote docs", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "Docs reference contract",
          "--description",
          "Remote documentation fixture",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--json",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;

      const result = await runDocs(
        id,
        {
          add: [
            "[Pull request](https://github.com/unbraind/pm-cli/pull/1031)",
            "Issue report,https://github.com/unbraind/pm-cli/issues/1038",
          ],
          message: "Link remote project context",
        },
        { path: context.pmPath },
      );

      expect(result.docs).toHaveLength(2);
      expect(result.docs).toEqual(
        expect.arrayContaining([
          {
            path: "https://github.com/unbraind/pm-cli/pull/1031",
            scope: "project",
            note: "Pull request",
          },
          {
            path: "https://github.com/unbraind/pm-cli/issues/1038",
            scope: "project",
            note: "Issue report",
          },
        ]),
      );

      const blankMarkdownLabel = await runDocs(
        id,
        { add: ["[ ](https://example.com/context)"] },
        { path: context.pmPath },
      );
      expect(blankMarkdownLabel.docs).toContainEqual({
        path: "https://example.com/context",
        scope: "project",
        note: undefined,
      });
    });
  });
});
