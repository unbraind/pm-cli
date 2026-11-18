import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../../helpers/temp.js";

// A case-insensitive file system resolves any casing through stat while its
// directory listing keeps the real name. Linux cannot reproduce that, so the
// listing is replaced for one directory per test.
const listing = vi.hoisted(() => ({ directory: "", names: undefined as string[] | undefined, fail: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (directory: string, options?: unknown) => {
      if (directory === listing.directory && options === undefined) {
        if (listing.fail) throw Object.assign(new Error("listing refused"), { code: "EACCES" });
        if (listing.names !== undefined) return listing.names;
      }
      return actual.readdir(directory, options as never);
    }) as typeof actual.readdir,
  };
});

const { expandFileGlob } = await import("../../../../src/core/fs/file-glob.js");

afterEach(() => {
  listing.directory = "";
  listing.names = undefined;
  listing.fail = false;
});

describe("literal file glob casing (pm-gh1748)", () => {
  it("links a literal file only by the exact name its directory lists", async () => {
    await withTempDir("pm-glob-literal-case-", async (root) => {
      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "docs", "readme.md"), "x");
      expect(await expandFileGlob("docs/readme.md", root)).toEqual(["docs/readme.md"]);
      // The same file, as a case-insensitive file system lists it.
      listing.directory = path.join(root, "docs");
      listing.names = ["README.md"];
      expect(await expandFileGlob("docs/readme.md", root)).toEqual([]);
      listing.names = ["readme.md"];
      expect(await expandFileGlob("docs/readme.md", root)).toEqual(["docs/readme.md"]);
    });
  });

  it("checks the case of every literal directory of a relative pattern, but not an absolute root", async () => {
    await withTempDir("pm-glob-literal-dir-case-", async (root) => {
      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "docs", "readme.md"), "x");
      expect(await expandFileGlob("docs/readme.md", root)).toEqual(["docs/readme.md"]);
      expect(await expandFileGlob("docs/*.md", root)).toEqual(["docs/readme.md"]);
      // The directory as a case-insensitive file system lists it.
      listing.directory = root;
      listing.names = ["DOCS"];
      expect(await expandFileGlob("docs/readme.md", root)).toEqual([]);
      expect(await expandFileGlob("docs/*.md", root)).toEqual([]);
      // An absolute root is the caller's spelling; only the final name is checked.
      const absolute = `${root.replaceAll("\\", "/")}/docs/readme.md`;
      expect(await expandFileGlob(absolute, root)).toEqual([absolute]);
    });
  });

  it("matches nothing when the directory cannot be listed", async () => {
    await withTempDir("pm-glob-literal-unlisted-", async (root) => {
      await writeFile(path.join(root, "a.ts"), "x");
      listing.directory = root;
      listing.fail = true;
      expect(await expandFileGlob("a.ts", root)).toEqual([]);
    });
  });
});
