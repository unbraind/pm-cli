/**
 * Extension workspace coordinates follow Git's repository discovery, including
 * `GIT_CEILING_DIRECTORIES`: a nested non-Git tracker under a ceiling is not
 * bound to its parent checkout (GH-1787, pm-gh1787).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePortableWorkspaceContext } from "../../../src/core/extensions/index.js";

let root: string;
let parent: string;
let child: string;
let pmRoot: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pm-ceiling-")));
  parent = path.join(root, "parent");
  child = path.join(parent, "child");
  pmRoot = path.join(child, ".agents", "pm");
  // A .git marker is all discovery reads; a .git file stands for a linked worktree.
  await mkdir(path.join(parent, ".git"), { recursive: true });
  await mkdir(pmRoot, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** Coordinates resolved for the child tracker with these source and ceiling settings. */
function resolveFor(source: string, ceilings?: string[]) {
  vi.stubEnv("PM_SOURCE_WORKSPACE_ROOT", source);
  vi.stubEnv("GIT_CEILING_DIRECTORIES", ceilings?.join(path.delimiter) ?? "");
  return resolvePortableWorkspaceContext(pmRoot);
}

/** Whether a directory sits inside a checkout, which a walk to the filesystem root would find. */
function insideCheckout(directory: string): boolean {
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    if (existsSync(path.join(cursor, ".git"))) return true;
    if (path.dirname(cursor) === cursor) return false;
  }
}

const childOnly = () => ({ source_workspace_root: child, pm_root_rel: ".agents/pm" });
const parentCheckout = () => ({ source_workspace_root: parent, repo_root: parent, pm_root_rel: "child/.agents/pm" });

describe("portable workspace coordinates under Git discovery ceilings", () => {
  it("never moves up into a ceiling: a nested non-Git tracker keeps its own root and no VCS root", () => {
    expect(resolveFor(child, [parent])).toEqual(childOnly());
    // Without a ceiling the enclosing checkout is discovered, as before.
    expect(resolveFor(child)).toEqual(parentCheckout());
  });

  it("always examines the start directory and ignores ceilings above the checkout", () => {
    expect(resolveFor(parent, [parent])).toEqual(parentCheckout());
    expect(resolveFor(child, [root])).toEqual(parentCheckout());
  });

  it("ignores relative and empty entries but honours every absolute one", () => {
    expect(resolveFor(child, ["parent", "", path.join(root, "missing")])).toEqual(parentCheckout());
    expect(resolveFor(child, [path.join(root, "missing"), parent])).toEqual(childOnly());
  });

  it("compares physical paths before an empty entry and spelled paths after it, as Git does", async () => {
    const link = path.join(root, "link");
    await symlink(parent, link, process.platform === "win32" ? "junction" : "dir");
    // Resolved through the link, the ceiling names the physical parent.
    expect(resolveFor(child, [link])).toEqual(childOnly());
    // After an empty entry it is kept as spelled, and Git compares it with physical directories: a link spelling never matches.
    expect(resolveFor(child, ["", link])).toEqual(parentCheckout());
    expect(resolveFor(path.join(link, "child"), ["", link])).toMatchObject({ repo_root: link });
    // A physical spelling after an empty entry still stops the walk, written as Git compares it (forward slashes).
    expect(resolveFor(child, ["", parent.split(path.sep).join("/")])).toEqual(childOnly());
  });
});

describe("Git's own reading of ceilings and links (Codex review)", () => {
  const linkType = process.platform === "win32" ? "junction" : "dir";

  it("walks the physical ancestors, so a ceiling a link skips over still stops the walk", async () => {
    // root/wslink -> parent/ws/child2: Git walks parent/ws/child2, parent/ws (the ceiling) and stops.
    const physical = path.join(parent, "ws", "child2");
    const link = path.join(root, "wslink");
    await mkdir(physical, { recursive: true });
    await symlink(physical, link, linkType);
    expect(resolveFor(link, [path.join(parent, "ws")])).toEqual({ source_workspace_root: link });
    // Without the ceiling the checkout is found; no ancestor of the link names it, so its physical path is reported.
    expect(resolveFor(link)).toEqual(parentCheckout());
  });

  it("keeps an entry after an empty one as spelled, with one trailing separator trimmed", () => {
    // `child/..` names the parent only after normalization, which Git does not apply there.
    expect(resolveFor(child, ["", `${child}${path.sep}..`])).toEqual(parentCheckout());
    // Git compares a spelled entry with the forward-slash form of each directory, one trailing slash dropped (Codex round 6).
    const forward = parent.split(path.sep).join("/");
    expect(resolveFor(child, ["", `${forward}/`])).toEqual(childOnly());
    expect(resolveFor(child, ["", forward])).toEqual(childOnly());
  });

  it("walks a start directory that does not exist yet by its spelling, and keeps a root ceiling whole", () => {
    const missing = path.join(child, "not-yet");
    expect(resolveFor(missing)).toEqual(parentCheckout());
    expect(resolveFor(missing, [parent])).toEqual({ source_workspace_root: missing });
    // A root entry after an empty one keeps its only separator; the checkout below it is still found.
    expect(resolveFor(child, ["", path.parse(root).root])).toEqual(parentCheckout());
  });

  it("resolves a start spelled through a link before collapsing `..`, as Git's chdir does (Codex round 2)", async (context) => {
    const physical = path.join(parent, "ws", "child2");
    const link = path.join(root, "wslink");
    await mkdir(physical, { recursive: true });
    await symlink(physical, link, linkType);
    const spelled = `${link}${path.sep}..`;
    if (process.platform === "win32") {
      // Windows collapses `..` lexically before it opens a path (as Git for Windows' chdir does), so
      // `wslink\..` is the link's own parent: the fixture root, which holds no checkout (GH-1792).
      if (insideCheckout(path.dirname(root))) context.skip();
      const lexical = { source_workspace_root: root, pm_root_rel: "parent/child/.agents/pm" };
      expect(resolveFor(spelled, [parent])).toEqual(lexical);
      expect(resolveFor(spelled)).toEqual(lexical);
      return;
    }
    // `wslink/..` is parent/ws for Git, which may not move up into the parent ceiling.
    // Without a checkout the source is the directory the walk started from, so the tracker is outside it (Codex round 3).
    expect(resolveFor(spelled, [parent])).toEqual({ source_workspace_root: path.join(parent, "ws") });
    expect(resolveFor(spelled)).toEqual({ source_workspace_root: parent, repo_root: parent, pm_root_rel: "child/.agents/pm" });
  });

  it("keeps the tracker path when the source is a link alias and the checkout is reported physically (Codex round 2)", async () => {
    const alias = path.join(root, "alias");
    await symlink(child, alias, linkType);
    vi.stubEnv("PM_SOURCE_WORKSPACE_ROOT", alias);
    vi.stubEnv("GIT_CEILING_DIRECTORIES", "");
    expect(resolvePortableWorkspaceContext(path.join(alias, ".agents", "pm"))).toEqual(parentCheckout());
    // A tracker that does not exist yet is compared as spelled.
    expect(resolvePortableWorkspaceContext(path.join(alias, "missing", ".agents", "pm"))).toEqual({ source_workspace_root: parent, repo_root: parent });
  });

  it("walks to the filesystem root when no checkout holds the start", (context) => {
    // Judged on the resolved fixture itself, so a host temporary directory inside a checkout skips the case.
    if (insideCheckout(path.dirname(root))) context.skip();
    // The temporary root holds no .git marker, so the walk reaches the root and stops there.
    expect(resolveFor(root)).toEqual({ source_workspace_root: root, pm_root_rel: "parent/child/.agents/pm" });
  });

  it("resolves a relative source against the working directory", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect(resolveFor(path.join("parent", "child"), [parent])).toEqual(childOnly());
      expect(resolveFor(path.join("parent", "child"))).toEqual(parentCheckout());
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.runIf(process.platform === "win32")("ignores a spelled entry written with backslashes, as Git for Windows does", () => {
    expect(resolveFor(child, ["", parent])).toEqual(parentCheckout());
  });

  it.runIf(process.platform !== "win32")("keeps a backslash at the end of a POSIX entry, which names another directory there", () => {
    expect(resolveFor(child, ["", `${parent}\\`])).toEqual(parentCheckout());
  });

  it.runIf(process.platform !== "win32")("drops an entry before an empty one that does not resolve", () => {
    // Git cannot resolve `parent/missing/..`, so it is no ceiling, although it normalizes to the parent.
    expect(resolveFor(child, [`${parent}${path.sep}missing${path.sep}..`])).toEqual(parentCheckout());
  });
});
