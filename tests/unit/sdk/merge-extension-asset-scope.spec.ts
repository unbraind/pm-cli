import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMergeAttributePatterns } from "../../../src/sdk/merge/install.js";

describe("merge fence extension asset scope", () => {
  it("keeps contributed item folders protected while excluding package assets", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pm-merge-assets-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const patterns = buildMergeAttributePatterns(".agents/pm", ["tasks"]);
      writeFileSync(
        path.join(root, ".gitattributes"),
        `${patterns.join("\n")}\n`,
      );

      const attributes = (file: string) =>
        execFileSync("git", ["check-attr", "merge", "--", file], {
          cwd: root,
          encoding: "utf8",
        }).trim();
      expect(
        attributes(".agents/pm/tasks/pm-1.toon").endsWith(
          "merge: pm-item-toon",
        ),
      ).toBe(true);
      expect(
        attributes(".agents/pm/custom-items/pm-2.toon").endsWith(
          "merge: pm-item-toon",
        ),
      ).toBe(true);
      expect(
        attributes(".agents/pm/extensions/demo/README.md").endsWith(
          "merge: unset",
        ),
      ).toBe(true);
      expect(
        attributes(".agents/pm/extensions/demo/manifest.json").endsWith(
          "merge: unset",
        ),
      ).toBe(true);
      expect(
        attributes(".agents/pm/extensions/.managed-extensions.json").endsWith(
          "merge: pm-json",
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
