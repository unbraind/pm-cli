/**
 * Extension workspace coordinates follow Git's repository discovery, including
 * `GIT_CEILING_DIRECTORIES`: a nested non-Git tracker under a ceiling is not
 * bound to its parent checkout (GH-1787, pm-gh1787).
 */
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
    // A physical spelling after an empty entry still stops the walk.
    expect(resolveFor(child, ["", parent])).toEqual(childOnly());
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
    expect(resolveFor(child, ["", `${parent}${path.sep}`])).toEqual(childOnly());
  });

  it("walks a start directory that does not exist yet by its spelling, and keeps a root ceiling whole", () => {
    const missing = path.join(child, "not-yet");
    expect(resolveFor(missing)).toEqual(parentCheckout());
    expect(resolveFor(missing, [parent])).toEqual({ source_workspace_root: missing });
    // A root entry after an empty one keeps its only separator; the checkout below it is still found.
    expect(resolveFor(child, ["", path.parse(root).root])).toEqual(parentCheckout());
  });

  it.runIf(process.platform !== "win32")("drops an entry before an empty one that does not resolve", () => {
    // Git cannot resolve `parent/missing/..`, so it is no ceiling, although it normalizes to the parent.
    expect(resolveFor(child, [`${parent}${path.sep}missing${path.sep}..`])).toEqual(parentCheckout());
  });
});
