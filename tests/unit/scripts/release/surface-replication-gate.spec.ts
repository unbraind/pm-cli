/**
 * @module surface-replication-gate tests
 *
 * Proves changeset activation, fail-closed member replication, refusal census,
 * waiver visibility, and the executable entrypoint boundary.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  main,
  runSurfaceReplicationEntrypoint,
  validateSurfaceReplication,
} from "../../../../scripts/release/surface-replication-gate.mjs";

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-replication-gate-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "src", "cli"), { recursive: true });
  await mkdir(path.join(root, "src", "sdk"), { recursive: true });
  return root;
}

function declaration() {
  return {
    version: 1,
    source_file_line_cap: 10,
    sets: [
      {
        id: "fixture-surface",
        owner: "pm-fixture",
        triggers: ["src/sdk/a.ts", "src/cli/b.ts"],
        required_changed_members: ["src/sdk/a.ts", "src/cli/b.ts"],
        members: [
          { path: "src/sdk/a.ts", contains_all: ["sharedContract"] },
          { path: "src/cli/b.ts", contains_all: ["sharedContract"] },
        ],
      },
    ],
    waivers: [],
    cli_refusal_dispositions: [],
    refusal_parity_contracts: [],
  };
}

function runGit(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("surface replication gate", () => {
  it("fails when one changed side is not replicated", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "src/sdk/a.ts"),
      "sharedContract\n",
      "utf8",
    );
    await writeFile(path.join(root, "src/cli/b.ts"), "drifted\n", "utf8");

    const report = await validateSurfaceReplication(declaration(), {
      repoRoot: root,
      changedFiles: ["src/sdk/a.ts"],
      today: "2026-08-07",
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toContain(
      "set:fixture-surface:member:src/cli/b.ts:missing:sharedContract",
    );
    expect(report.violations).toContain(
      "set:fixture-surface:member:src/cli/b.ts:unchanged",
    );
  });

  it("requires every declared recurrence member in the activating changeset", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "src/sdk/a.ts"),
      "sharedContract\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src/cli/b.ts"),
      "sharedContract\n",
      "utf8",
    );

    const report = await validateSurfaceReplication(declaration(), {
      repoRoot: root,
      changedFiles: ["src/sdk/a.ts"],
      today: "2026-08-07",
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      "set:fixture-surface:member:src/cli/b.ts:unchanged",
    ]);
  });

  it("reports recurrence density, cap overlap, and CLI refusal totals", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "src/sdk/a.ts"),
      "sharedContract\nvalue\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src/cli/b.ts"),
      'sharedContract\nnew PmCliError("fixture")\n',
      "utf8",
    );
    const config = declaration();
    config.sets.push({
      id: "fixture-surface-copy",
      owner: "pm-fixture",
      triggers: ["src/sdk/a.ts", "src/cli/b.ts"],
      required_changed_members: ["src/sdk/a.ts", "src/cli/b.ts"],
      members: [
        { path: "src/sdk/a.ts", contains_all: ["sharedContract"] },
        { path: "src/cli/b.ts", contains_all: ["sharedContract"] },
      ],
    });
    config.cli_refusal_dispositions.push({
      path: "src/cli/b.ts",
      expected_count: 1,
      disposition: "transport_validation",
      reason:
        "The fixture refusal is explicitly owned by its transport adapter.",
    });

    const report = await validateSurfaceReplication(config, {
      repoRoot: root,
      changedFiles: ["src/sdk/a.ts", "src/cli/b.ts"],
      today: "2026-08-07",
    });

    expect(report.ok).toBe(true);
    expect(report.active_sets[0]).toMatchObject({
      recurrence_density: 1,
      source_cap_utilization: 0.2,
    });
    expect(report.cli_owned_refusals.total).toBe(1);
  });

  it("makes an active waiver queryable without hiding it", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "src/sdk/a.ts"),
      "sharedContract\n",
      "utf8",
    );
    await writeFile(path.join(root, "src/cli/b.ts"), "drifted\n", "utf8");
    const config = declaration();
    config.waivers.push({
      set_id: "fixture-surface",
      member_path: "src/cli/b.ts",
      pm_item: "pm-waiver",
      reason: "Temporary fixture waiver with a named owner and expiry.",
      expires_on: "2026-08-08",
    });

    const report = await validateSurfaceReplication(config, {
      repoRoot: root,
      changedFiles: ["src/sdk/a.ts"],
      today: "2026-08-07",
    });

    expect(report.ok).toBe(true);
    expect(report.applied_waivers).toHaveLength(1);
  });

  it("fails when one refusal surface changes its shared code alone", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "src/sdk/a.ts"),
      "sharedContract\nsharedCode\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src/cli/b.ts"),
      "sharedContract\ndriftedCode\n",
      "utf8",
    );
    const config = declaration();
    config.refusal_parity_contracts.push({
      id: "fixture-refusal",
      owner: "pm-fixture",
      code: "sharedCode",
      members: [
        { path: "src/sdk/a.ts", contains_all: ["sharedCode"] },
        { path: "src/cli/b.ts", contains_all: ["sharedCode"] },
      ],
    });

    const report = await validateSurfaceReplication(config, {
      repoRoot: root,
      changedFiles: [],
      today: "2026-08-07",
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toContain(
      "set:refusal:fixture-refusal:member:src/cli/b.ts:missing:sharedCode",
    );
  });

  it("fails closed for malformed declarations, sets, members, and refusal inventories", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "src", "cli", "nested"), { recursive: true });
    await writeFile(
      path.join(root, "src", "cli", "nested", "z.ts"),
      'new PmCliError("nested")\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "cli", "a.ts"),
      'new PmCliError("one")\nnew PmCliError("two")\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "cli", "ignore.txt"),
      "ignored\n",
      "utf8",
    );
    await writeFile(path.join(root, "src", "sdk", "a.ts"), "shared\n", "utf8");

    await expect(
      validateSurfaceReplication(
        { version: 2, sets: [], source_file_line_cap: 10 },
        { repoRoot: root, changedFiles: [], today: "2026-08-07" },
      ),
    ).resolves.toMatchObject({
      ok: false,
      violations: ["declaration:invalid"],
    });
    await expect(
      validateSurfaceReplication(
        { version: 1, sets: null, source_file_line_cap: 10 },
        { repoRoot: root, changedFiles: [], today: "2026-08-07" },
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      validateSurfaceReplication(
        { version: 1, sets: [], source_file_line_cap: 1.5 },
        { repoRoot: root, changedFiles: [], today: "2026-08-07" },
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      validateSurfaceReplication(
        { version: 1, sets: [], source_file_line_cap: 0 },
        { repoRoot: root, changedFiles: [], today: "2026-08-07" },
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      validateSurfaceReplication(
        { version: 1, sets: [], source_file_line_cap: 10 },
        { repoRoot: root, changedFiles: [], today: "2026-08-07" },
      ),
    ).resolves.toMatchObject({
      ok: false,
      cli_owned_refusals: { total: 3 },
    });

    const report = await validateSurfaceReplication(
      {
        version: 1,
        source_file_line_cap: 10,
        sets: [
          null,
          { id: 1, owner: "pm-fixture", triggers: [], members: [] },
          { id: "bad-owner", owner: "owner", triggers: [], members: [] },
          {
            id: "bad-triggers",
            owner: "pm-fixture",
            triggers: null,
            members: [],
          },
          {
            id: "bad-members",
            owner: "pm-fixture",
            triggers: [],
            members: null,
          },
          {
            id: "fixture-members",
            owner: "pm-fixture",
            triggers: ["src/sdk/a.ts"],
            required_changed_members: ["missing.ts"],
            members: [
              null,
              "member",
              {},
              { path: "missing-array.ts", contains_all: null },
              { path: "empty-array.ts", contains_all: [] },
              { path: "empty-pattern.ts", contains_all: [""] },
              { path: "number-pattern.ts", contains_all: [1] },
              { path: "missing.ts", contains_all: ["shared"] },
            ],
          },
          {
            id: "missing-required",
            owner: "pm-fixture",
            triggers: ["other.ts"],
            members: [{ path: "other.ts", contains_all: ["shared"] }],
          },
          {
            id: "empty-required",
            owner: "pm-fixture",
            triggers: ["other.ts"],
            required_changed_members: [],
            members: [{ path: "other.ts", contains_all: ["shared"] }],
          },
          {
            id: "typed-required",
            owner: "pm-fixture",
            triggers: ["other.ts"],
            required_changed_members: [7],
            members: [{ path: "other.ts", contains_all: ["shared"] }],
          },
          {
            id: "empty-path-required",
            owner: "pm-fixture",
            triggers: ["other.ts"],
            required_changed_members: [""],
            members: [{ path: "other.ts", contains_all: ["shared"] }],
          },
          {
            id: "foreign-required",
            owner: "pm-fixture",
            triggers: ["other.ts"],
            required_changed_members: ["foreign.ts"],
            members: [{ path: "other.ts", contains_all: ["shared"] }],
          },
        ],
        refusal_parity_contracts: [{ id: "empty", members: undefined }],
        cli_refusal_dispositions: [
          {
            path: "src/cli/a.ts",
            expected_count: 1,
            reason: "short",
          },
          {
            path: "src/cli/stale.ts",
            expected_count: 1,
            reason: "A sufficiently detailed but stale disposition record.",
          },
        ],
      },
      {
        repoRoot: root,
        changedFiles: ["src/sdk/a.ts"],
        today: "2026-08-07",
      },
    );

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        "set:invalid",
        "set:fixture-members:invalid_member",
        "set:fixture-members:member:missing.ts:unchanged",
        "set:fixture-members:member:missing.ts:missing:<file>",
        "set:missing-required:invalid_required_changed_members",
        "set:empty-required:invalid_required_changed_members",
        "set:typed-required:invalid_required_changed_members",
        "set:empty-path-required:invalid_required_changed_members",
        "set:foreign-required:invalid_required_changed_members",
        "cli_refusal:src/cli/a.ts:expected_1:actual_2",
        "cli_refusal:src/cli/nested/z.ts:undispositioned:1",
        "cli_refusal:src/cli/stale.ts:stale_disposition",
      ]),
    );
    expect(
      report.cli_owned_refusals.files.map(({ path: file }) => file),
    ).toEqual(["src/cli/a.ts", "src/cli/nested/z.ts"]);
    expect(report.active_sets[0]).toMatchObject({
      largest_source: null,
      largest_source_implementation_lines: 0,
    });
  });

  it("rejects invalid and expired waiver candidates before accepting a valid owner", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "src/sdk/a.ts"),
      "sharedContract\n",
      "utf8",
    );
    await writeFile(path.join(root, "src/cli/b.ts"), "drifted\n", "utf8");
    const config = declaration();
    config.waivers.push(
      {
        set_id: "other",
        member_path: "src/cli/b.ts",
        pm_item: "pm-waiver",
        reason: "Wrong replication set waiver candidate.",
        expires_on: "2026-08-08",
      },
      {
        set_id: "fixture-surface",
        member_path: "other.ts",
        pm_item: "pm-waiver",
        reason: "Wrong member waiver candidate.",
        expires_on: "2026-08-08",
      },
      {
        set_id: "fixture-surface",
        member_path: "src/cli/b.ts",
        pm_item: "pm-waiver",
        reason: 7,
        expires_on: "2026-08-08",
      },
      {
        set_id: "fixture-surface",
        member_path: "src/cli/b.ts",
        pm_item: "owner",
        reason: "Invalid PM owner waiver candidate.",
        expires_on: "2026-08-08",
      },
      {
        set_id: "fixture-surface",
        member_path: "src/cli/b.ts",
        pm_item: "pm-waiver",
        reason: "Invalid expiry waiver candidate.",
        expires_on: 7,
      },
      {
        set_id: "fixture-surface",
        member_path: "src/cli/b.ts",
        pm_item: "pm-waiver",
        reason: "Non-ISO expiry waiver candidate.",
        expires_on: "tomorrow",
      },
      {
        set_id: "fixture-surface",
        member_path: "src/cli/b.ts",
        pm_item: "pm-waiver",
        reason: "Impossible calendar expiry waiver candidate.",
        expires_on: "2026-02-30",
      },
      {
        set_id: "fixture-surface",
        member_path: "src/cli/b.ts",
        pm_item: "pm-waiver",
        reason: "Unparseable ISO-shaped expiry waiver candidate.",
        expires_on: "2026-99-99",
      },
      {
        set_id: "fixture-surface",
        member_path: "src/cli/b.ts",
        pm_item: "pm-waiver",
        reason: "Expired waiver candidate.",
        expires_on: "2026-08-06",
      },
      {
        set_id: "fixture-surface",
        member_path: "src/cli/b.ts",
        pm_item: "pm-waiver",
        reason: "Valid waiver candidate with ownership and bounded expiry.",
        expires_on: "2026-08-08",
      },
    );

    const report = await validateSurfaceReplication(config, {
      repoRoot: root,
      changedFiles: ["src/sdk/a.ts"],
      today: "2026-08-07",
    });
    expect(report.ok).toBe(true);
    expect(report.applied_waivers).toHaveLength(1);
    expect(report.applied_waivers[0]).toMatchObject({
      pm_item: "pm-waiver",
      expires_on: "2026-08-08",
    });
  });

  it("discovers committed, staged, and unstaged changes from a real Git worktree", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "src/sdk/a.ts"),
      "sharedContract\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src/cli/b.ts"),
      "sharedContract\n",
      "utf8",
    );
    runGit(root, ["init", "-b", "main"]);
    runGit(root, ["config", "user.email", "fixture@example.test"]);
    runGit(root, ["config", "user.name", "Fixture"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "baseline"]);
    runGit(root, ["switch", "-c", "feature"]);
    await writeFile(
      path.join(root, "src/sdk/a.ts"),
      "sharedContract\ncommitted\n",
      "utf8",
    );
    runGit(root, ["add", "src/sdk/a.ts"]);
    runGit(root, ["commit", "-m", "feature"]);
    await writeFile(
      path.join(root, "src/cli/b.ts"),
      "sharedContract\nunstaged\n",
      "utf8",
    );
    await writeFile(path.join(root, "staged.txt"), "staged\n", "utf8");
    runGit(root, ["add", "staged.txt"]);

    const report = await validateSurfaceReplication(declaration(), {
      repoRoot: root,
    });
    expect(report.ok).toBe(true);
    expect(report.changed_files).toEqual([
      "src/cli/b.ts",
      "src/sdk/a.ts",
      "staged.txt",
    ]);

    const noBaseRoot = await fixtureRoot();
    runGit(noBaseRoot, ["init", "-b", "feature"]);
    runGit(noBaseRoot, ["config", "user.email", "fixture@example.test"]);
    runGit(noBaseRoot, ["config", "user.name", "Fixture"]);
    await writeFile(path.join(noBaseRoot, "seed.txt"), "seed\n", "utf8");
    runGit(noBaseRoot, ["add", "."]);
    runGit(noBaseRoot, ["commit", "-m", "seed"]);
    await expect(
      validateSurfaceReplication(declaration(), { repoRoot: noBaseRoot }),
    ).rejects.toThrow("Unable to resolve a base revision");
  });

  it("treats a missing CLI source tree as an empty refusal inventory", async () => {
    const root = await fixtureRoot();
    await rm(path.join(root, "src", "cli"), { recursive: true, force: true });
    const config = { ...declaration(), sets: [] };

    await expect(
      validateSurfaceReplication(config, {
        repoRoot: root,
        changedFiles: [],
        today: "2026-08-07",
      }),
    ).resolves.toMatchObject({ ok: true, cli_owned_refusals: { total: 0 } });

    await writeFile(path.join(root, "src", "cli"), "not a directory\n", "utf8");
    await expect(
      validateSurfaceReplication(config, {
        repoRoot: root,
        changedFiles: [],
        today: "2026-08-07",
      }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("loads default and explicit declarations through the public main function", async () => {
    await expect(main(["--list-waivers"])).resolves.toEqual({ waivers: [] });
    await expect(main(["--declaration", "--list-waivers"])).resolves.toEqual({
      waivers: [],
    });
    await expect(
      main(["--changed-files", "README.md, ,package.json"]),
    ).resolves.toMatchObject({
      ok: true,
      changed_files: ["README.md", "package.json"],
    });
    await expect(main(["--changed-files"])).resolves.toMatchObject({
      ok: true,
    });

    const root = await fixtureRoot();
    const defaultConfig = JSON.parse(
      await readFile(
        path.resolve("scripts/release/surface-replication-sets.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const declarationPath = path.join(root, "declaration.json");
    const waiverlessDeclarationPath = path.join(root, "waiverless.json");
    await writeFile(
      waiverlessDeclarationPath,
      `${JSON.stringify({ version: 1 })}\n`,
      "utf8",
    );
    await expect(
      main(["--declaration", waiverlessDeclarationPath, "--list-waivers"]),
    ).resolves.toEqual({ waivers: [] });
    await writeFile(
      declarationPath,
      `${JSON.stringify(defaultConfig)}\n`,
      "utf8",
    );
    await expect(
      main(["--declaration", declarationPath, "--changed-files", "README.md"]),
    ).resolves.toMatchObject({ ok: true });

    const gitDeclarationPath = path.join(root, "git-declaration.json");
    await writeFile(
      gitDeclarationPath,
      `${JSON.stringify({
        version: 1,
        source_file_line_cap: 10,
        sets: [],
        cli_refusal_dispositions: [],
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "sdk", "a.ts"),
      "baseline\n",
      "utf8",
    );
    runGit(root, ["init", "-b", "main"]);
    runGit(root, ["config", "user.email", "fixture@example.test"]);
    runGit(root, ["config", "user.name", "Fixture"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "baseline"]);
    await writeFile(path.join(root, "src", "sdk", "a.ts"), "changed\n", "utf8");
    await expect(
      main(["--declaration", gitDeclarationPath], { repoRoot: root }),
    ).resolves.toMatchObject({ ok: true, changed_files: ["src/sdk/a.ts"] });

    await writeFile(
      declarationPath,
      `${JSON.stringify({ ...defaultConfig, version: 2 })}\n`,
      "utf8",
    );
    await expect(
      main(["--declaration", declarationPath, "--changed-files", "README.md"]),
    ).rejects.toThrow("declaration:invalid");
  });

  it("runs only as the direct entrypoint and reports failures", async () => {
    const output: string[] = [];
    expect(
      await runSurfaceReplicationEntrypoint({
        argv: ["node", "elsewhere.mjs"],
      }),
    ).toBe(false);
    expect(
      await runSurfaceReplicationEntrypoint({
        argv: [
          "node",
          path.resolve("scripts/release/surface-replication-gate.mjs"),
        ],
        run: async () => ({ ok: true }),
        write: (value: string) => output.push(value),
      }),
    ).toBe(true);
    expect(output.join("")).toContain('"ok": true');

    const errors: unknown[] = [];
    expect(
      await runSurfaceReplicationEntrypoint({
        argv: [
          "node",
          path.resolve("scripts/release/surface-replication-gate.mjs"),
        ],
        run: async () => {
          throw new Error("negative control");
        },
        onError: (error: unknown) => errors.push(error),
      }),
    ).toBe(false);
    expect(String(errors[0])).toContain("negative control");

    expect(await runSurfaceReplicationEntrypoint()).toBe(false);

    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      expect(
        await runSurfaceReplicationEntrypoint({
          argv: [
            "node",
            path.resolve("scripts/release/surface-replication-gate.mjs"),
            "--list-waivers",
          ],
        }),
      ).toBe(true);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("waivers"));
    } finally {
      stdout.mockRestore();
    }

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const processExit = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${String(code)}`);
    }) as typeof process.exit);
    try {
      await expect(
        runSurfaceReplicationEntrypoint({
          argv: [
            "node",
            path.resolve("scripts/release/surface-replication-gate.mjs"),
          ],
          run: async () => {
            throw new Error("default failure path");
          },
        }),
      ).rejects.toThrow("exit:1");
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("default failure path"),
      );
    } finally {
      processExit.mockRestore();
      consoleError.mockRestore();
    }
  });
});
