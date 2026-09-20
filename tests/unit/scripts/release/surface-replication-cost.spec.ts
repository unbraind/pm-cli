/** @module Prove replication diff work depends on semantic triggers, not tracker size. */
import * as childProcess from "node:child_process";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateSurfaceReplication } from "../../../../scripts/release/surface-replication-gate.mjs";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

const harness = createScriptHarness();

describe("replication Git work", () => {
  it("reads only declared content triggers while retaining every changed file", async () => {
    const root = await harness.createTempRoot("pm-replication-cost-");
    const traceRoot = await harness.createTempRoot("pm-replication-trace-");
    const trace = path.join(traceRoot, "git.jsonl");
    await mkdir(path.join(root, "tracker"));
    await writeFile(path.join(root, "trigger.txt"), "unrelated baseline\n");
    await writeFile(path.join(root, "member.txt"), "sharedContract\n");
    for (const args of [["init", "-b", "main"], ["config", "user.email", "fixture@example.test"], ["config", "user.name", "Fixture"], ["add", "."], ["commit", "-m", "baseline"], ["switch", "-c", "feature"]]) {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    }
    await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(path.join(root, "tracker", `${index}.txt`), "unrelated tracker evidence\n")));
    await writeFile(path.join(root, "trigger.txt"), "unrelated update\n");
    const config = {
      version: 1,
      source_file_line_cap: 100,
      sets: [{
        id: "semantic",
        owner: "pm-fixture",
        triggers: [{ path: "trigger.txt", changed_lines_contain_any: ["sharedContract"] }],
        required_changed_members: ["member.txt"],
        members: [{ path: "member.txt", contains_all: ["sharedContract"] }],
      }],
    };
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    const unrelated = await validateSurfaceReplication(config, { repoRoot: root });
    expect(unrelated).toMatchObject({ ok: true, active_sets: [] });
    expect(unrelated.changed_files).toHaveLength(1001);
    const events = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { event: string; argv?: string[] });
    const patches = events.filter((event) => event.event === "start" && event.argv?.includes("--unified=0"));
    expect(patches).toHaveLength(3);
    expect(patches.every((event) => event.argv?.at(-1) === "trigger.txt")).toBe(true);

    await writeFile(path.join(root, "trigger.txt"), "sharedContract changed\n");
    const relevant = await validateSurfaceReplication(config, { repoRoot: root });
    expect(relevant.violations).toContain("set:semantic:member:member.txt:unchanged");
    expect(relevant.active_sets).toHaveLength(1);

    // Feature-only clones have no default-branch reference; working-tree
    // evidence must still activate the same semantic trigger.
    execFileSync("git", ["branch", "-m", "main", "archived-baseline"], { cwd: root, stdio: "ignore" });
    const withoutBase = await validateSurfaceReplication(config, { repoRoot: root });
    expect(withoutBase.violations).toContain("set:semantic:member:member.txt:unchanged");

    // Untracked semantic trigger files have no diff hunks and must fail closed.
    await writeFile(path.join(root, "new-trigger.txt"), "sharedContract new\n");
    const untracked = await validateSurfaceReplication({ ...config, sets: [{ ...config.sets[0], triggers: [{ path: "new-trigger.txt", changed_lines_contain_any: ["sharedContract"] }] }] }, { repoRoot: root });
    expect(untracked.violations).toContain("set:semantic:member:member.txt:unchanged");

    // Preserve the path census, but make one patch layer unreadable. An
    // unrelated readable layer must never certify the missing layer as safe.
    await writeFile(path.join(root, "trigger.txt"), "unrelated update\n");
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      ...childProcess,
      /** Fail only the staged patch read while preserving actual Git census and other diff layers. */
      execFileSync(file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) {
        if (args.includes("--unified=0") && args.includes("--cached")) throw new Error("unreadable staged patch");
        return execFileSync(file, args, options);
      },
    }));
    const gate = await harness.importModule<{ validateSurfaceReplication: typeof validateSurfaceReplication }>("scripts/release/surface-replication-gate.mjs");
    const incomplete = await gate.validateSurfaceReplication(config, { repoRoot: root });
    expect(incomplete.active_sets).toHaveLength(1);
    expect(incomplete.violations).toContain("set:semantic:member:member.txt:unchanged");
  }, 120_000);
});
