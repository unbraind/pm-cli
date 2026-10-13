import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
          "merge: text",
        ),
      ).toBe(true);
      expect(
        attributes(".agents/pm/extensions/demo/manifest.json").endsWith(
          "merge: text",
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

  it.each([
    { mode: "disjoint", autocrlf: false },
    { mode: "disjoint", autocrlf: true },
    { mode: "overlap", autocrlf: false },
    { mode: "binary", autocrlf: false },
  ] as const)("preserves native Git $mode merges with autocrlf=$autocrlf", ({ mode, autocrlf }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pm-merge-native-assets-"));
    const relative = ".agents/pm/extensions/demo/index.ts";
    const file = path.join(root, relative);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Merge Fixture", "-c", "user.email=merge@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      git("init", "-q", "--initial-branch=main");
      git("config", "core.autocrlf", String(autocrlf));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(path.join(root, ".gitattributes"), buildMergeAttributePatterns(".agents/pm", ["tasks"]).join("\n") + "\n");
      const base = mode === "binary" ? Buffer.from([0, 1, 2]) : Buffer.from("header\nfirst\nseparator\nlast\nfooter\n");
      const left = mode === "binary" ? Buffer.from([0, 3, 2]) : Buffer.from(base.toString().replace("first", "left"));
      const right = mode === "binary" ? Buffer.from([0, 4, 2]) : Buffer.from(base.toString().replace(mode === "overlap" ? "first" : "last", "right"));
      writeFileSync(file, base);
      git("add", "."); git("commit", "-qm", "Seed extension assets");
      git("switch", "-qc", "left"); writeFileSync(file, left); git("commit", "-qam", "Edit left extension");
      git("switch", "-qc", "right", "main"); writeFileSync(file, right); git("commit", "-qam", "Edit right extension");
      if (mode === "disjoint") {
        git("merge", "left", "--no-edit");
        const expected = "header\nleft\nseparator\nright\nfooter\n";
        expect(readFileSync(file, "utf8")).toBe(autocrlf ? expected.replaceAll("\n", "\r\n") : expected);
        expect(git("ls-files", "--unmerged", "--", relative)).toBe("");
      } else {
        expect(() => git("merge", "left", "--no-edit")).toThrow();
        expect(git("ls-files", "--unmerged", "--", relative).trim().split("\n")).toHaveLength(3);
        if (mode === "binary") expect(readFileSync(file)).toEqual(right);
        else expect(readFileSync(file, "utf8")).toMatch(/<<<<<<<[\s\S]*right[\s\S]*=======[\s\S]*left[\s\S]*>>>>>>>/u);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
