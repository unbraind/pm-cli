import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractPmInvocationArgsFromSegment,
  isPmCliScriptToken,
} from "../../../src/sdk/test/linked-command-detection.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("linked command executable identity", () => {
  it("does not treat an unrelated dist/cli.js as pm, including through env", async () => {
    await withTempPmPath(async ({ tempRoot }) => {
      await mkdir(path.join(tempRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({ name: "unrelated-cli" }),
        "utf8",
      );
      await writeFile(path.join(tempRoot, "dist", "cli.js"), "", "utf8");

      expect(isPmCliScriptToken("dist/cli.js", tempRoot)).toBe(false);
      expect(isPmCliScriptToken("missing/dist/cli.js", tempRoot)).toBe(false);
      expect(
        extractPmInvocationArgsFromSegment(
          "READ_ONLY=1 node dist/cli.js schema research --format json",
          tempRoot,
        ),
      ).toBeNull();
    });
  });

  it("recognizes checkout-relative and absolute pm CLI scripts by package identity", () => {
    const repositoryRoot = process.cwd();
    const absoluteCli = path.join(repositoryRoot, "dist", "cli.js");

    expect(isPmCliScriptToken("dist/cli.js", repositoryRoot)).toBe(true);
    expect(isPmCliScriptToken(absoluteCli, path.dirname(repositoryRoot))).toBe(
      true,
    );
    expect(
      extractPmInvocationArgsFromSegment(
        `node ${absoluteCli} get pm-example --json`,
        path.dirname(repositoryRoot),
      ),
    ).toEqual(["get", "pm-example", "--json"]);
  });
});
