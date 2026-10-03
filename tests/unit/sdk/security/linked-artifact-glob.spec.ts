import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandAddGlobEntries } from "../../../../src/sdk/linked-artifacts.js";
import { withTempDir } from "../../../helpers/temp.js";

describe("linked artifact glob security and file-only compatibility", () => {
  it("handles deeply nested brace input without exhausting the stack", async () => {
    await withTempDir("pm-glob-depth-", async (root) => {
      await writeFile(path.join(root, "context.ts"), "context\n");
      const pattern = "{".repeat(4500) + "a,b" + "}".repeat(4500);
      expect(await expandAddGlobEntries([{ pattern, scope: "project" }], root, root)).toEqual([]);
    });
  });

  it("preserves directory exclusion and brace/extglob matching from a nested invocation", async () => {
    await withTempDir("pm-glob-files-", async (root) => {
      const invocation = path.join(root, "workspace");
      await mkdir(invocation);
      for (const name of ["context.ts", "notes.md", ".hidden.ts", "ignored.txt"]) {
        await writeFile(path.join(invocation, name), name);
      }
      const child = path.join(invocation, "child");
      await mkdir(child);
      await writeFile(path.join(child, "nested.ts"), "nested\n");
      for (const pattern of [".", "./", invocation, "child", child, "missing", "missing/**"]) {
        expect(await expandAddGlobEntries([{ pattern, scope: "project" }], root, invocation)).toEqual([]);
      }
      expect(await expandAddGlobEntries([{ pattern: "child/**", scope: "project" }], root, invocation)).toEqual([
        { path: "workspace/child/nested.ts", scope: "project" },
      ]);
      for (const pattern of ["*.{ts,md}", "*.@(ts|md)", `${invocation.replaceAll("\\", "/")}/*.{ts,md}`]) {
        const absolute = path.isAbsolute(pattern);
        expect(await expandAddGlobEntries([{ pattern, scope: "global", note: "evidence" }], root, invocation)).toEqual(
          [".hidden.ts", "context.ts", "notes.md"].map((name) => ({
            path: absolute ? path.join(invocation, name).replaceAll("\\", "/") : `workspace/${name}`,
            scope: "global",
            note: "evidence",
          })),
        );
      }
    });
  });
});
