import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { glob } from "tinyglobby";
import { describe, expect, it } from "vitest";
import { _testOnly, expandFileGlob } from "../../../../src/core/fs/file-glob.js";
import { withTempDir } from "../../../helpers/temp.js";

const posix = process.platform !== "win32";
const FILES = [
  "a.ts", "b.md", ".hidden.ts", "{a}.ts", "x[1].ts", "x1.ts", "a b.ts", "(p).ts", "1.ts", "2.ts", "10.ts",
  "A.TS", "ab.ts", "aab.ts", "c.ts", "!x.ts", "]x.ts", "a,b.ts", "é.ts", "[é].ts", "[a-c].ts", "[x]y[z].ts", "xyz.ts",
  "child/n.ts", "child/deep/d.ts", ".dotdir/x.ts", "sub/s.md", "app/[slug]/page.tsx", "app/s/page.tsx",
  ...(posix ? ["a|b.ts", "@(q.ts", "lit*.ts"] : []),
];

/** Build the shared fixture: a workspace with files, a sibling directory and (on POSIX) links. */
async function fixture(root: string): Promise<string> {
  const workspace = path.join(root, "w");
  for (const file of FILES) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), file);
  }
  await mkdir(path.join(root, "other"));
  await writeFile(path.join(root, "other", "o.ts"), "o");
  if (posix) {
    await symlink("child", path.join(workspace, "linkdir"));
    await symlink("a.ts", path.join(workspace, "link.ts"));
    await symlink("missing", path.join(workspace, "dangling.ts"));
  }
  return workspace;
}

/** Expand through tinyglobby with the options the linked-artifact path used before pm-gh1748. */
async function reference(pattern: string, cwd: string): Promise<string[]> {
  const matches = await glob(pattern, {
    cwd, absolute: path.isAbsolute(pattern), onlyFiles: true, dot: true, expandDirectories: false, followSymbolicLinks: true,
  });
  return matches.map((match) => match.replaceAll("\\", "/")).sort();
}

/** Expand through the in-repo walker. */
async function expanded(pattern: string, cwd: string): Promise<string[]> {
  return (await expandFileGlob(pattern, cwd)).sort();
}

const PARITY_PATTERNS = [
  "*.ts", "**/*.ts", "*", "**", "child/**", "child", "child/", "{a}.ts", "{a,b}.*", "{1..2}.ts", "{2..1}.ts", "x[1].ts", "x[12].ts",
  "[1]0.ts", "x\\[1\\].ts", "lit\\*.ts", "[ab].ts", "[!a].ts", "[^a].ts", "[a-c].ts", "[c-a].ts", "[!]]x.ts", "[]x].ts", "[",
  "x[.ts", "[[:alpha:]].ts", "[[:digit:]].ts", "[é].ts", "[x]y[z].ts", "*.@(ts|md)", "?(a).ts", "*(a).ts", "+(a).ts",
  "+(a)b.ts", "*(a|b).ts", "@(a|@(b|c)).ts", "a.{ts,md}", "{child,sub}/*", "{child/deep,sub}/*", "./*.md", "./child/n.ts",
  "child/./n.ts", "child/../a.ts", "**/", "*/", "*.TS", "a b.ts", "(p).ts", "**.md", "***", "child/**/d.ts", "child/**/",
  "**/deep/*", "**/**", "*/**", "**/child/*", "\\a.ts", "a.ts/", "{,child/}n.ts", "{a,{b,1}}.*", ".*", "{a,}.ts", "{,}.ts",
  "{}.ts", "{01..03}.ts", "{a..c}.ts", "{a..c}*", "??.ts", "{x.ts", "a,b.ts", "app/[slug]/*.tsx", "*/[slug]/*", "app/*/page.tsx",
  "../other/*.ts", "../other/o.ts", "missing/**", "missing", "a.ts/*",
  "*/./n.ts", "child/*/../n.ts", "child//n.ts", "*//n.ts", "c*/./deep/d.ts", "./*/deep/../n.ts", "@(**/d.ts|*.md)",
  "child/@(**/d.ts|n.ts)", "app/@(**/page.tsx)", "*(**/d.ts)", "*/@(**|x)", "*/@(x|**)", "{**,x}/n.ts",
  ...(posix ? ["@(q.ts", "a|b.ts", "linkdir/*", "linkdir/../a.ts", "link.ts", "dangling.ts", "*link*", "**/d.ts"] : []),
];

describe("file glob parity with the previous tinyglobby expansion (pm-gh1748)", () => {
  it("returns the same files for every supported pattern form", async () => {
    await withTempDir("pm-glob-parity-", async (root) => {
      const workspace = await fixture(root);
      let matching = 0;
      for (const pattern of PARITY_PATTERNS) {
        const files = await expanded(pattern, workspace);
        expect({ pattern, files }).toEqual({ pattern, files: await reference(pattern, workspace) });
        if (files.length > 0) matching += 1;
      }
      // Guard against a vacuous comparison where both sides match nothing.
      expect(matching).toBeGreaterThanOrEqual(Math.floor(PARITY_PATTERNS.length * 0.7));
      expect(await expanded("**", workspace)).toEqual(expect.arrayContaining(["a.ts", ".dotdir/x.ts", "app/[slug]/page.tsx", "child/deep/d.ts"]));
      const absolute = workspace.replaceAll("\\", "/");
      for (const pattern of [`${absolute}/*.{ts,md}`, `${absolute}/child/**`, `${absolute}/a.ts`, `${absolute}/child`, `${absolute}/missing/*`]) {
        expect({ pattern, files: await expanded(pattern, root) }).toEqual({ pattern, files: await reference(pattern, root) });
      }
    });
  });
});

describe("file glob semantics", () => {
  it("refuses negation, whether leading or as a closed extglob", async () => {
    await withTempDir("pm-glob-negation-", async (root) => {
      for (const pattern of ["!a.ts", "!", "!(a).ts", "src/!(a|b)/*.ts", "{x,!(a)}.ts"]) {
        await expect(expandFileGlob(pattern, root)).rejects.toMatchObject({ name: "PmCliError", exitCode: 2, message: expect.stringContaining("negated patterns") });
      }
      await writeFile(path.join(root, "!x.ts"), "x");
      await writeFile(path.join(root, "!(x.ts"), "x");
      expect(await expanded("\\!x.ts", root)).toEqual(["!x.ts"]);
      expect(await expanded("*!x.ts", root)).toEqual(["!x.ts"]);
      expect(await expanded("!(x.ts".replace("!", "\\!"), root)).toEqual(["!(x.ts"]);
      expect(await expanded("*(x.ts", root)).toEqual(["!(x.ts"]);
    });
  });

  it("does not re-enter a linked directory that is already on the walk path", async () => {
    if (!posix) return;
    await withTempDir("pm-glob-cycle-", async (root) => {
      await mkdir(path.join(root, "d"));
      await writeFile(path.join(root, "d", "f.ts"), "f");
      await symlink(".", path.join(root, "loop"));
      await symlink("..", path.join(root, "d", "up"));
      expect(await expanded("**/*.ts", root)).toEqual(["d/f.ts"]);
      expect(await expanded("loop/*.ts", root)).toEqual([]);
    });
  });

  it("skips entries that are neither files nor directories, links to them, and unreadable directories", async () => {
    if (!posix) return;
    await withTempDir("pm-glob-special-", async (root) => {
      const socketPath = path.join(root, "s.sock");
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        await symlink("s.sock", path.join(root, "link.sock"));
        await mkdir(path.join(root, "locked"));
        await writeFile(path.join(root, "locked", "hidden.sock"), "x");
        await chmod(path.join(root, "locked"), 0o000);
        expect(await expanded("*.sock", root)).toEqual([]);
        expect(await expanded("**/*", root)).toEqual([]);
      } finally {
        await chmod(path.join(root, "locked"), 0o700);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("treats a bound-exceeding pattern as matching nothing", async () => {
    await withTempDir("pm-glob-bounds-", async (root) => {
      await writeFile(path.join(root, "1.ts"), "1");
      await writeFile(path.join(root, "a.ts"), "a");
      expect(await expanded(`${"a".repeat(4097)}`, root)).toEqual([]);
      expect(await expanded(`${"{".repeat(33)}1${"}".repeat(33)}.ts`, root)).toEqual([]);
      expect(await expanded(`${"@(".repeat(32)}a${")".repeat(32)}.ts`, root)).toEqual(["a.ts"]);
      expect(await expanded(`${"@(".repeat(33)}a${")".repeat(33)}.ts`, root)).toEqual([]);
      expect(await expanded("{1..1001}.ts", root)).toEqual([]);
      expect(await expanded("{1..1000}.ts", root)).toEqual(["1.ts"]);
      expect(await expanded("{1..1000}".repeat(14), root)).toEqual([]);
      expect(await expanded("{z..a}.ts", root)).toEqual(["a.ts"]);
      // A "[:" without a closing ":]" is an ordinary member, never a POSIX class.
      expect(await expanded("[[:ab].ts", root)).toEqual(["a.ts"]);
      expect(await expanded("[[:a:x].ts", root)).toEqual(["a.ts"]);
    });
  });

  it("parses POSIX classes, escapes and edge brackets without widening them", async () => {
    if (!posix) return;
    await withTempDir("pm-glob-classes-", async (root) => {
      for (const name of ["a.ts", "B.ts", "_.ts", "-.ts", "].ts", "z.ts", "[[:bogus:]].ts", "[a\\]].ts"]) await writeFile(path.join(root, name), name);
      expect(await expanded("[[:upper:][:punct:]].ts", root)).toEqual(["-.ts", "B.ts", "].ts", "_.ts"]);
      expect(await expanded("[[:bogus:]].ts", root)).toEqual(["[[:bogus:]].ts"]);
      expect(await expanded("[[:alpha:].ts", root)).toEqual([]);
      expect(await expanded("[a\\]].ts", root)).toEqual(["].ts", "a.ts"]);
      expect(await expanded("[a-\\z].ts", root)).toEqual(["a.ts", "z.ts"]);
      expect(await expanded("[a-].ts", root)).toEqual(["-.ts", "a.ts"]);
      expect(await expanded("[\\", root)).toEqual([]);
      expect(await expanded("a\\", root)).toEqual([]);
      expect(await expanded("[[:word:]].ts", root)).toEqual(["B.ts", "_.ts", "a.ts", "z.ts"]);
    });
  });

  it("keeps an escaped trailing slash and matches nothing through it", async () => {
    await withTempDir("pm-glob-slash-", async (root) => {
      await writeFile(path.join(root, "a.ts"), "a");
      expect(await expanded("a.ts\\/", root)).toEqual([]);
      expect(await expanded("a.ts//", root)).toEqual(["a.ts"]);
    });
  });

  it("stays linear on repeated extglobs and star chains that backtrack exponentially in regex engines", async () => {
    await withTempDir("pm-glob-linear-", async (root) => {
      const name = `${"a".repeat(200)}.md`;
      await writeFile(path.join(root, name), "x");
      const started = performance.now();
      expect(await expanded(`${"+(*)".repeat(40)}.ts`, root)).toEqual([]);
      expect(await expanded(`${"*a".repeat(60)}b`, root)).toEqual([]);
      expect(await expanded(`${"*(a|aa)".repeat(30)}.md`, root)).toEqual([name]);
      expect(performance.now() - started).toBeLessThan(5_000);
    });
  });

  it("resets the bounded DFA cache without changing results", () => {
    const matcher = _testOnly.compile("*(a|b)c", { nodes: 2, edges: 4, stateIds: 100 });
    let node = matcher.start;
    for (const char of "ababab") node = matcher.step(node, char.codePointAt(0)!);
    expect(matcher.advance(node, "c").accepting).toBe(true);
    expect(matcher.advance(matcher.start, "abx").states).toEqual([]);
    expect(matcher.advance(matcher.advance(matcher.start, "abx"), "c").accepting).toBe(false);
  });

  it("bounds every node, transition and state id the DFA retains, not just its index", () => {
    // "*a" then fourteen "?": distinct a/b names reach a fresh subset per suffix.
    const limits = { nodes: 64, edges: 256, stateIds: 2_000 };
    const matcher = _testOnly.compile(`*a${"?".repeat(14)}`, limits);
    const reference = /^.*a.{14}$/u;
    let peak = { nodes: 0, edges: 0, stateIds: 0 };
    for (let value = 0; value < 4096; value += 1) {
      const name = Array.from({ length: 15 }, (_, bit) => ((value * 2654435761) >>> bit) & 1 ? "a" : "b").join("");
      expect(matcher.advance(matcher.start, name).accepting).toBe(reference.test(name));
      const retained = matcher.retained();
      peak = { nodes: Math.max(peak.nodes, retained.nodes), edges: Math.max(peak.edges, retained.edges), stateIds: Math.max(peak.stateIds, retained.stateIds) };
    }
    expect(peak.nodes).toBeLessThanOrEqual(limits.nodes);
    expect(peak.edges).toBeLessThanOrEqual(limits.edges);
    expect(peak.stateIds).toBeLessThanOrEqual(limits.stateIds);
    const tight = _testOnly.compile("*a?", { nodes: 100, edges: 100, stateIds: 3 });
    expect(tight.advance(tight.start, "xab").accepting).toBe(true);
    expect(tight.retained().stateIds).toBeLessThanOrEqual(3);
    const fewEdges = _testOnly.compile("*a?", { nodes: 1_000, edges: 2, stateIds: 100_000 });
    for (const name of ["xab", "aab", "bab", "abb"]) expect(fewEdges.advance(fewEdges.start, name).accepting).toBe(/a.$/u.test(name));
    expect(fewEdges.retained().edges).toBeLessThanOrEqual(2);
  });
});
