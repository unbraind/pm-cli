import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
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
  "child/@(**/d.ts|n.ts)", "app/@(**/page.tsx)", "*(**/d.ts)", "{**,x}/n.ts", "@(child/**)", "+(child/**)", "{child/**,sub/**}",
  "*[[:ascii:]].ts", "[![:ascii:]]*.ts", "[[:ascii:]].ts",
  "{child/,x}**/d.ts", "+(child/)**/d.ts", "?(child/)**/d.ts", "@(*/)**/d.ts", "c**", "chi**/n.ts", "a**.ts",
  "@(x(y)|b).md", "*(x(y)|a).ts", "@(((p))|c).ts",
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

describe("file glob superset property (pm-gh1748)", () => {
  it("never loses a file the previous expansion matched, over a deterministic random pattern corpus", async () => {
    // A fixed linear congruential seed keeps the corpus reproducible.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(values: T[]): T => values[Math.floor(random() * values.length)]!;
    const atoms = ["a", "b", "c", "child", "sub", "deep", "app", "s", "n", "d", "x", "1", ".ts", ".md", ".tsx", ".", "page", "[slug]"];
    const magic = ["*", "?", "**", "[ab]", "[!a]", "[a-c]", "[[:alpha:]]", "[[:digit:]]", "{a,b}", "{child,sub}", "{child/,sub/}", "{,child/}",
      "{1..2}", "@(a|b)", "@(child/|sub/)", "*(a)", "+(a)", "?(x)", "+(child/)", "@(**/d.ts|n.ts)", "@(child/**|sub/**)", "*(child/|sub/)"];
    await withTempDir("pm-glob-superset-", async (root) => {
      const workspace = await fixture(root);
      const seen = new Set<string>();
      let compared = 0;
      while (compared < 400) {
        let pattern = "";
        const tokens = 1 + Math.floor(random() * 5);
        for (let token = 0; token < tokens; token += 1) {
          const roll = random();
          pattern += roll < 0.4 ? pick(atoms) : roll < 0.75 ? pick(magic) : "/";
        }
        pattern = pattern.replace(/^\/+/u, "");
        if (pattern === "" || pattern.startsWith("!") || seen.has(pattern)) continue;
        seen.add(pattern);
        // picomatch 4.0.7 sometimes spans directories for a "**" written next to
        // anything but "/" (as in "**c" or "**?(x)"); upstream picomatch later made
        // that a single star (commit 8f5ecc0), which is what this matcher does.
        if (/[^/]\*\*|\*\*[^/]/u.test(pattern.replace(/\/+$/u, ""))) continue;
        // tinyglobby refuses patterns that normalize to nothing, such as ".".
        const previous = await reference(pattern, workspace).catch(() => undefined);
        if (previous === undefined) continue;
        compared += 1;
        const files = await expanded(pattern, workspace);
        const lost = previous.filter((file) => !files.includes(file));
        expect({ pattern, lost }).toEqual({ pattern, lost: [] });
      }
    });
  }, 60_000);
});

/** A pattern as tokens: literal text, or a construct with the alternatives it spells. */
type PatternToken = string | { text: string; options: string[] };
const PLAIN_TOKENS = ["a", "b", "c", "child", "sub", "deep", "app", "n", "d", ".ts", ".md", ".tsx", "*", "?", "[ab]", "[!a]", "[[:alpha:]]", "x"];
const CONSTRUCT_TOKENS: Array<{ text: string; options: string[] }> = [
  { text: "{a,b}", options: ["a", "b"] },
  { text: "{child,sub}", options: ["child", "sub"] },
  { text: "{child/,sub/}", options: ["child/", "sub/"] },
  { text: "{,child/}", options: ["", "child/"] },
  { text: "{**,x}", options: ["**", "x"] },
  { text: "@(a|b)", options: ["a", "b"] },
  { text: "@(child/|sub/)", options: ["child/", "sub/"] },
  { text: "@(**|n)", options: ["**", "n"] },
  { text: "@(child/**|*.md)", options: ["child/**", "*.md"] },
];

/** Draw one to four tokens from a seeded generator, never starting with "/". */
function drawTokens(random: () => number): PatternToken[] {
  const pick = <T,>(values: T[]): T => values[Math.floor(random() * values.length)]!;
  const tokens: PatternToken[] = [];
  const count = 1 + Math.floor(random() * 4);
  for (let index = 0; index < count; index += 1) {
    const roll = random();
    tokens.push(roll < 0.5 ? pick(PLAIN_TOKENS) : roll < 0.75 ? pick(CONSTRUCT_TOKENS) : "/");
  }
  while (tokens[0] === "/") tokens.shift();
  return tokens;
}

/** Spell tokens as a pattern, and expand every construct textually. */
function spellAndExpand(tokens: PatternToken[]): { pattern: string; expansions: string[]; constructs: boolean } {
  const pattern = tokens.map((token) => (typeof token === "string" ? token : token.text)).join("");
  const expansions = tokens.reduce<string[]>(
    (prefixes, token) => prefixes.flatMap((prefix) => (typeof token === "string" ? [prefix + token] : token.options.map((option) => prefix + option))),
    [""],
  );
  return { pattern, expansions, constructs: tokens.some((token) => typeof token !== "string") };
}

/** "**" next to anything but "/" or an edge: the documented picomatch 4.0.7 difference. */
const adjacentGlobstar = (pattern: string) => /[^/]\*\*|\*\*[^/]/u.test(pattern.replace(/\/+$/u, ""));

/** Assert each expansion equals the previous expansion and return their union, or undefined when one is refused. */
async function unionMatchingReference(expansions: string[], workspace: string): Promise<string[] | undefined> {
  const union = new Set<string>();
  for (const expansion of expansions) {
    const previous = await reference(expansion, workspace).catch(() => undefined);
    if (previous === undefined) return undefined;
    const files = await expanded(expansion, workspace);
    expect({ expansion, files }).toEqual({ expansion, files: previous });
    for (const file of files) union.add(file);
  }
  return [...union].sort();
}

describe("file glob union and parity properties (pm-gh1748)", () => {
  it("equals the previous expansion without constructs, and the union of its expansions with them", async () => {
    let seed = 13;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    await withTempDir("pm-glob-union-property-", async (root) => {
      const workspace = await fixture(root);
      const seen = new Set<string>();
      const checked = { parity: 0, unions: 0 };
      while (checked.parity < 200 || checked.unions < 150) {
        const { pattern, expansions, constructs } = spellAndExpand(drawTokens(random));
        const usable = expansions.filter((expansion) => expansion !== "" && !expansion.startsWith("/"));
        if (pattern === "" || seen.has(pattern) || usable.length === 0 || usable.some(adjacentGlobstar)) continue;
        seen.add(pattern);
        const union = await unionMatchingReference(usable, workspace);
        if (union === undefined) continue;
        if (!constructs) { checked.parity += 1; continue; }
        checked.unions += 1;
        expect({ pattern, files: await expanded(pattern, workspace) }).toEqual({ pattern, files: union });
      }
    });
  }, 120_000);
});

describe("file glob semantics", () => {
  it("treats a brace or extglob as the union of its expansions, so a globstar after an alternative ending in / spans zero or more directories", async () => {
    // tinyglobby required at least one directory after an extglob here and
    // lost matches after a brace; each construct-free expansion still matches it.
    const constructs: Array<[string, string[]]> = [
      ["@(child/|sub/)**/*", ["child/**/*", "sub/**/*"]],
      ["@(child/|app/)**/*.ts*", ["child/**/*.ts*", "app/**/*.ts*"]],
      ["{child/,sub/}**/*", ["child/**/*", "sub/**/*"]],
      ["{child/,c}**", ["child/**", "c*"]],
      ["@(child/|x)**/*.ts", ["child/**/*.ts", "x*/*.ts"]],
      ["*(app/|child/)**/*", ["**/*"]],
      ["{,child/}**/d.ts", ["**/d.ts", "child/**/d.ts"]],
      // A trailing globstar inside an extglob alternative spans directories too.
      ["@(child/**|sub/**)", ["child/**", "sub/**"]],
      ["*/@(**|x)", ["*/**", "*/x"]],
      ["*/@(x|**)", ["*/**", "*/x"]],
      ["child/@(**|x)", ["child/**", "child/x"]],
      ["@(child/**|*.md)", ["child/**", "*.md"]],
      ["@(**|x)", ["**", "x"]],
      // Text after a construct belongs to every alternative: a "/" is shared,
      // anything else keeps a trailing globstar a single star.
      ["{**,x}.ts", ["**.ts", "x.ts"]],
      ["@(**|x).ts", ["**.ts", "x.ts"]],
      ["{child,**}/n.ts", ["child/n.ts", "**/n.ts"]],
      ["@(sub|**)/s.md", ["sub/s.md", "**/s.md"]],
      ["{a,{b,**}}/d.ts", ["a/d.ts", "b/d.ts", "**/d.ts"]],
      ["{child/,{sub/,**}}", ["child/**", "sub/**", "**"]],
      ["*(**|x).ts", ["*.ts"]],
    ];
    await withTempDir("pm-glob-union-", async (root) => {
      const workspace = await fixture(root);
      for (const [pattern, expansions] of constructs) {
        const union = new Set<string>();
        for (const expansion of expansions) {
          const files = await expanded(expansion, workspace);
          expect({ expansion, files }).toEqual({ expansion, files: await reference(expansion, workspace) });
          for (const file of files) union.add(file);
        }
        const files = await expanded(pattern, workspace);
        expect({ pattern, files }).toEqual({ pattern, files: [...union].sort() });
        expect(files).toEqual(expect.arrayContaining(await reference(pattern, workspace)));
      }
    });
  });

  it("keeps parentheses literal outside an extglob and balanced inside one, so route-group directories match", async () => {
    // tinyglobby compiled bare parentheses to a regex group: app/(marketing)/**
    // matched app/marketing/ and missed the Next.js route group itself.
    await withTempDir("pm-glob-parens-", async (root) => {
      for (const file of ["app/(marketing)/page.tsx", "app/(marketing)/about/page.tsx", "app/marketing/page.tsx", "(p).ts", "a.ts", "fs-utils.ts"]) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), file);
      }
      expect(await expanded("app/(marketing)/**/*.tsx", root)).toEqual(["app/(marketing)/about/page.tsx", "app/(marketing)/page.tsx"]);
      expect(await expanded("app/(*)/page.tsx", root)).toEqual(["app/(marketing)/page.tsx"]);
      expect(await expanded("(p)*", root)).toEqual(["(p).ts"]);
      // Inside an extglob an inner group nests, so it cannot close the extglob early.
      expect(await expanded("@(x(y)|fs-utils).ts", root)).toEqual(["fs-utils.ts"]);
      expect(await expanded("@((p)|a).ts", root)).toEqual(["(p).ts", "a.ts"]);
      expect(await expanded("@(a|(p).ts", root)).toEqual([]);
    });
  });

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
        // A privileged process (root, CAP_DAC_OVERRIDE) can still list it.
        const readable = await readdir(path.join(root, "locked")).then(() => true, () => false);
        expect(await expanded("**/*", root)).toEqual(readable ? ["locked/hidden.sock"] : []);
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
      expect(await expanded("{1..1000}".repeat(20), root)).toEqual([]);
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
      // Inherited object members are unknown class names, never ranges.
      for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        expect(await expanded(`[[:${name}:]].ts`, root)).toEqual([]);
        expect(await expanded(`[![:${name}:]].ts`, root)).toEqual(["-.ts", "B.ts", "].ts", "_.ts", "a.ts", "z.ts"]);
      }
    });
  });

  it("keeps a UNC root while normalizing the rest of the pattern", async () => {
    expect(_testOnly.joinOutput("//server/share/work", "src/a.ts")).toBe("//server/share/work/src/a.ts");
    expect(_testOnly.joinOutput("/tmp/x", "a.ts")).toBe("/tmp/x/a.ts");
    expect(_testOnly.joinOutput("../other", "o.ts")).toBe("../other/o.ts");
    expect(_testOnly.joinOutput("", "a.ts")).toBe("a.ts");
    expect(_testOnly.normalizePattern("//server/share/work/./src/../*.ts")).toBe("//server/share/work/*.ts");
    expect(_testOnly.normalizePattern("///x//y/./z")).toBe("/x/y/z");
    expect(_testOnly.normalizePattern("a//b/./c")).toBe("a/b/c");
    if (!posix) return;
    // POSIX treats a leading "//" like "/", so the same tree expands either way.
    await withTempDir("pm-glob-unc-", async (root) => {
      await writeFile(path.join(root, "a.ts"), "a");
      expect(await expanded(`/${root}/*.ts`, root)).toEqual([`${root}/a.ts`]);
      expect(await expanded(`/${root}/a.ts`, root)).toEqual([`${root}/a.ts`]);
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
