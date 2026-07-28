import { execFileSync } from "node:child_process";
import fs, { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runServiceOverride,
  runServiceOverrideSync,
} from "../../../src/core/extensions/extension-hook-runtime.js";
import { setActiveExtensionServices } from "../../../src/core/extensions/index.js";
import {
  invalidateHistoryDriftCache,
  invalidateHistoryDriftCacheForPath,
} from "../../../src/core/history/drift-cache.js";
import { formatOutput } from "../../../src/core/output/output.js";
import { runHealth } from "../../../src/sdk/governance/health.js";
import {
  auditMergeDriverConfiguration,
  buildMergeAttributePatterns,
  installMergeFence,
} from "../../../src/sdk/merge/install.js";
import { mergeJsonDocuments } from "../../../src/sdk/merge/three-way.js";
import type {
  ExtensionServiceRegistry,
  ServiceOverrideContext,
} from "../../../src/core/extensions/extension-types.js";
import type { ServiceOverrideDecision } from "../../../src/sdk/authoring.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function outputContext(payload: unknown): ServiceOverrideContext {
  return { service: "output_format", payload };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("SDK and CLI context-integrity primitives", () => {
  afterEach(() => {
    setActiveExtensionServices(null);
    vi.restoreAllMocks();
  });

  it("fences current and future authoritative nested JSON documents", () => {
    const patterns = buildMergeAttributePatterns(".agents/pm", ["tasks"]);
    expect(patterns).toContain('".agents/pm/**/*.json" merge=pm-json');
  });

  it("composes additive JSON arrays and preserves conflicts for removals", () => {
    const additive = mergeJsonDocuments(
      '{"entries":[{"name":"base"}]}',
      '{"entries":[{"name":"base"},{"name":"alpha"}]}',
      '{"entries":[{"name":"base"},{"name":"beta"}]}',
    );
    expect(JSON.parse(additive.merged)).toEqual({
      entries: [{ name: "base" }, { name: "alpha" }, { name: "beta" }],
    });
    expect(additive.conflict_paths).toEqual([]);
    expect(additive.paths_from_theirs).toEqual(["entries"]);

    expect(
      JSON.parse(
        mergeJsonDocuments(
          '{"entries":[{"name":"base"}]}',
          '{"entries":[{"name":"base"},{"name":"alpha"}]}',
          '{"entries":[{"name":"base"}]}',
        ).merged,
      ),
    ).toEqual({
      entries: [{ name: "base" }, { name: "alpha" }],
    });

    const removal = mergeJsonDocuments(
      '{"entries":[{"name":"base"}]}',
      '{"entries":[]}',
      '{"entries":[{"name":"base"},{"name":"beta"}]}',
    );
    expect(removal.conflict_paths).toEqual(["entries"]);
    expect(JSON.parse(removal.merged)).toEqual({ entries: [] });

    const theirsRemoval = mergeJsonDocuments(
      '{"entries":[{"name":"base"}]}',
      '{"entries":[{"name":"base"},{"name":"alpha"}]}',
      '{"entries":[]}',
    );
    expect(theirsRemoval.conflict_paths).toEqual(["entries"]);
    expect(JSON.parse(theirsRemoval.merged)).toEqual({
      entries: [{ name: "base" }, { name: "alpha" }],
    });

    const duplicateRemoval = mergeJsonDocuments(
      '{"entries":[{"name":"base"},{"name":"base"}]}',
      '{"entries":[{"name":"base"}]}',
      '{"entries":[{"name":"base"},{"name":"base"},{"name":"beta"}]}',
    );
    expect(duplicateRemoval.conflict_paths).toEqual(["entries"]);
    expect(JSON.parse(duplicateRemoval.merged)).toEqual({
      entries: [{ name: "base" }],
    });

    const duplicateAddition = mergeJsonDocuments(
      '{"entries":[{"name":"base"}]}',
      '{"entries":[{"name":"base"},{"name":"alpha"}]}',
      '{"entries":[{"name":"base"},{"name":"beta"},{"name":"beta"}]}',
    );
    expect(duplicateAddition.conflict_paths).toEqual([]);
    expect(JSON.parse(duplicateAddition.merged)).toEqual({
      entries: [
        { name: "base" },
        { name: "alpha" },
        { name: "beta" },
        { name: "beta" },
      ],
    });
  });

  it("composes independent managed-extension installs across branches", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      runGit(tempRoot, ["init", "-q"]);
      runGit(tempRoot, ["config", "user.name", "PM Test"]);
      runGit(tempRoot, ["config", "user.email", "pm-test@example.invalid"]);
      await installMergeFence({
        pmRoot: pmPath,
        workspaceRoot: tempRoot,
        includeExtensions: false,
      });
      const managedStatePath = path.join(
        pmPath,
        "extensions",
        ".managed-extensions.json",
      );
      await mkdir(path.dirname(managedStatePath), { recursive: true });
      await writeFile(managedStatePath, '{"entries":[]}\n', "utf8");
      runGit(tempRoot, ["add", ".gitattributes", ".agents/pm"]);
      runGit(tempRoot, ["commit", "-m", "Initialize tracker"]);
      const baseCommit = runGit(tempRoot, ["rev-parse", "HEAD"]);

      runGit(tempRoot, ["checkout", "-q", "-b", "agent-alpha"]);
      await writeFile(
        managedStatePath,
        '{"entries":[{"name":"alpha","directory":"alpha"}]}\n',
        "utf8",
      );
      runGit(tempRoot, ["add", ".agents/pm"]);
      runGit(tempRoot, ["commit", "-m", "Install alpha"]);

      runGit(tempRoot, ["checkout", "-q", "-b", "agent-beta", baseCommit]);
      await writeFile(
        managedStatePath,
        '{"entries":[{"name":"beta","directory":"beta"}]}\n',
        "utf8",
      );
      runGit(tempRoot, ["add", ".agents/pm"]);
      runGit(tempRoot, ["commit", "-m", "Install beta"]);
      runGit(tempRoot, ["merge", "--no-edit", "agent-alpha"]);

      const merged = JSON.parse(await readFile(managedStatePath, "utf8")) as {
        entries: Array<{ name: string }>;
      };
      expect(merged.entries.map((entry) => entry.name).sort()).toEqual([
        "alpha",
        "beta",
      ]);
      expect(runGit(tempRoot, ["diff", "--name-only", "--diff-filter=U"])).toBe(
        "",
      );
    });
  });

  it("projects lean read envelopes without repeating request context", () => {
    const envelope = {
      items: [{ id: "pm-alpha", status: "open" }],
      filters: { status: ["open"] },
      now: "2026-07-27T00:00:00.000Z",
      projection: ["id", "status"],
      sorting: [{ field: "updated_at", direction: "desc" }],
      has_more: false,
      next_cursor: "unused",
      total: 1,
    };
    expect(
      JSON.parse(formatOutput(envelope, { json: true, lean: true })),
    ).toEqual({
      items: envelope.items,
      has_more: false,
      total: 1,
    });
    expect(
      JSON.parse(
        formatOutput(
          { ...envelope, has_more: true, next_cursor: "continue" },
          { json: true, lean: true },
        ),
      ),
    ).toMatchObject({ has_more: true, next_cursor: "continue" });
    expect(JSON.parse(formatOutput(envelope, { json: true }))).toEqual(
      envelope,
    );
    expect(
      JSON.parse(
        formatOutput(
          { value: "not-a-read-envelope", empty: null },
          { json: true, lean: true },
        ),
      ),
    ).toEqual({ value: "not-a-read-envelope" });
  });

  it("treats legacy output payload echoes as a deprecated decline", async () => {
    const payload = { result: { id: "pm-alpha" } };
    const explicitDecision: ServiceOverrideDecision = {
      handled: true,
      result: "formatted",
    };
    const services: ExtensionServiceRegistry = {
      overrides: [
        {
          layer: "project",
          name: "explicit",
          service: "output_format",
          run: () => explicitDecision,
        },
        {
          layer: "project",
          name: "legacy-echo",
          service: "output_format",
          run: (context) => context.payload,
        },
      ],
    };
    expect(runServiceOverrideSync(services, outputContext(payload))).toEqual({
      handled: true,
      result: "formatted",
      warnings: [
        "extension_output_format_payload_echo_deprecated:project:legacy-echo",
      ],
    });
    await expect(
      runServiceOverride(services, outputContext(payload)),
    ).resolves.toEqual({
      handled: true,
      result: "formatted",
      warnings: [
        "extension_output_format_payload_echo_deprecated:project:legacy-echo",
      ],
    });

    setActiveExtensionServices({ overrides: [services.overrides[1]!] });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    expect(
      JSON.parse(formatOutput(payload, { json: true, command: "list" })),
    ).toEqual(payload);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        "extension_output_format_payload_echo_deprecated:project:legacy-echo",
      ),
    );
  });

  it("invalidates derived drift state after conventional history writes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const cachePath = path.join(
        pmPath,
        "runtime",
        "history-drift-cache.json",
      );
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, "{}\n", "utf8");
      await invalidateHistoryDriftCacheForPath(
        path.join(pmPath, "tasks", "not-history.jsonl"),
      );
      await expect(readFile(cachePath, "utf8")).resolves.toBe("{}\n");

      await invalidateHistoryDriftCacheForPath(
        path.join(pmPath, "history", "pm-alpha.jsonl"),
      );
      await expect(access(cachePath)).rejects.toMatchObject({ code: "ENOENT" });

      const stderrWrite = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      await mkdir(cachePath, { recursive: true });
      await expect(
        invalidateHistoryDriftCache(pmPath),
      ).resolves.toBeUndefined();
      await expect(access(cachePath)).resolves.toBeUndefined();
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining(
          "history_drift_cache_invalidation_failed:cache_path_is_directory",
        ),
      );
      const rmSpy = vi.spyOn(fs, "rm");
      rmSpy.mockRejectedValueOnce(
        Object.assign(new Error("directory target"), {
          code: "ERR_FS_EISDIR",
        }),
      );
      await expect(
        invalidateHistoryDriftCache(pmPath),
      ).resolves.toBeUndefined();
      expect(stderrWrite).toHaveBeenLastCalledWith(
        expect.stringContaining(
          "history_drift_cache_invalidation_failed:cache_path_is_directory",
        ),
      );

      const invalidRoot = path.join(pmPath, "not-a-directory");
      await writeFile(invalidRoot, "file\n", "utf8");
      await expect(
        invalidateHistoryDriftCache(path.join(invalidRoot, "nested")),
      ).resolves.toBeUndefined();
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining(
          "history_drift_cache_invalidation_failed:invalid_cache_path",
        ),
      );

      rmSpy.mockRejectedValueOnce(
        Object.assign(new Error("concurrent removal"), { code: "ENOENT" }),
      );
      const warningCount = stderrWrite.mock.calls.length;
      await expect(
        invalidateHistoryDriftCache(pmPath),
      ).resolves.toBeUndefined();
      expect(stderrWrite).toHaveBeenCalledTimes(warningCount);

      rmSpy.mockRejectedValueOnce("non-error failure");
      await expect(
        invalidateHistoryDriftCache(pmPath),
      ).resolves.toBeUndefined();
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining(
          "history_drift_cache_invalidation_failed:unknown",
        ),
      );

      rmSpy.mockRejectedValueOnce({ code: 500 });
      await expect(
        invalidateHistoryDriftCache(pmPath),
      ).resolves.toBeUndefined();
      expect(stderrWrite).toHaveBeenLastCalledWith(
        expect.stringContaining(
          "history_drift_cache_invalidation_failed:unknown",
        ),
      );

      rmSpy.mockRejectedValueOnce(
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
      );
      await expect(
        invalidateHistoryDriftCache(pmPath),
      ).resolves.toBeUndefined();
      expect(stderrWrite).toHaveBeenLastCalledWith(
        expect.stringContaining(
          "history_drift_cache_invalidation_failed:filesystem_error",
        ),
      );
    });
  });

  it("keeps empty item-type folders optional on fresh clones", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await rm(path.join(pmPath, "tasks"), { recursive: true });
      const relaxed = await runHealth(
        { path: pmPath, noExtensions: true },
        { noRefresh: true, skipDrift: true, skipVectors: true },
      );
      expect(
        relaxed.checks.find((check) => check.name === "directories"),
      ).toMatchObject({
        status: "ok",
        details: {
          missing_required: [],
          missing_optional: ["tasks"],
          missing: [],
          strict_directories: false,
        },
      });

      const strict = await runHealth(
        { path: pmPath, noExtensions: true },
        {
          noRefresh: true,
          skipDrift: true,
          skipVectors: true,
          strictDirectories: true,
        },
      );
      expect(
        strict.checks.find((check) => check.name === "directories"),
      ).toMatchObject({
        status: "warn",
        details: {
          missing: ["tasks"],
          strict_directories: true,
        },
      });

      await writeFile(
        path.join(pmPath, "schema", "types.json"),
        `${JSON.stringify({
          definitions: [{ name: "HistoryAlias", folder: "history" }],
        })}\n`,
        "utf8",
      );
      await rm(path.join(pmPath, "history"), { recursive: true });
      const structuralCollision = await runHealth(
        { path: pmPath, noExtensions: true },
        { noRefresh: true, skipDrift: true, skipVectors: true },
      );
      expect(
        structuralCollision.checks.find(
          (check) => check.name === "directories",
        ),
      ).toMatchObject({
        status: "warn",
        details: {
          missing_required: ["history"],
          missing_optional: ["tasks"],
        },
      });
    });
  });

  it("accepts a valid installed pm package when the checkout path changes", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      runGit(tempRoot, ["init", "-q"]);
      await installMergeFence({
        pmRoot: pmPath,
        workspaceRoot: tempRoot,
        includeExtensions: false,
      });

      const packageRoot = path.join(tempRoot, "portable'package");
      const portableCli = path.join(packageRoot, "dist", "cli.js");
      await mkdir(path.dirname(portableCli), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "@unbrained/pm-cli",
          bin: { pm: "dist/cli.js" },
        })}\n`,
        "utf8",
      );
      await writeFile(portableCli, "#!/usr/bin/env node\n", "utf8");

      const configuredDrivers = runGit(tempRoot, [
        "config",
        "--local",
        "--get-regexp",
        "^merge\\..*\\.driver$",
      ])
        .split("\n")
        .map((line) => {
          const separator = line.indexOf(" ");
          return {
            key: line.slice(0, separator),
            command: line.slice(separator + 1),
          };
        });
      const portableCommands = new Map<string, string>();
      for (const driver of configuredDrivers) {
        const suffix = driver.command.match(/^'[^']*' '[^']*'(.*)$/u)?.[1];
        expect(suffix).toBeDefined();
        const portableCommand = `${shellQuote(process.execPath)} ${shellQuote(portableCli)}${suffix}`;
        portableCommands.set(driver.key, portableCommand);
        runGit(tempRoot, ["config", "--local", driver.key, portableCommand]);
      }
      await expect(
        auditMergeDriverConfiguration(tempRoot),
      ).resolves.toMatchObject({
        status: "ok",
        drifted_keys: [],
      });

      const firstDriver = configuredDrivers[0]!;
      const suffix = firstDriver.command.match(/^'[^']*' '[^']*'(.*)$/u)?.[1];
      expect(suffix).toBeDefined();
      const expectFirstDriverDrift = async (command: string): Promise<void> => {
        runGit(tempRoot, ["config", "--local", firstDriver.key, command]);
        await expect(
          auditMergeDriverConfiguration(tempRoot),
        ).resolves.toMatchObject({
          status: "drift",
          drifted_keys: [firstDriver.key],
        });
      };

      await expectFirstDriverDrift("'");
      await expectFirstDriverDrift(
        `${shellQuote(path.join(tempRoot, "missing-node"))} ${shellQuote(portableCli)}${suffix}`,
      );
      await expectFirstDriverDrift(
        `${shellQuote(process.execPath)} ${shellQuote(path.join(tempRoot, "missing", "dist", "cli.js"))}${suffix}`,
      );

      const invalidPackageRoot = path.join(tempRoot, "invalid-package");
      const invalidPackageCli = path.join(invalidPackageRoot, "dist", "cli.js");
      await mkdir(path.dirname(invalidPackageCli), { recursive: true });
      await writeFile(invalidPackageCli, "#!/usr/bin/env node\n", "utf8");
      await expectFirstDriverDrift(
        `${shellQuote(process.execPath)} ${shellQuote(invalidPackageCli)}${suffix}`,
      );
      await writeFile(
        path.join(invalidPackageRoot, "package.json"),
        '{"name":"other","bin":"dist/cli.js"}\n',
        "utf8",
      );
      await expectFirstDriverDrift(
        `${shellQuote(process.execPath)} ${shellQuote(invalidPackageCli)}${suffix}`,
      );
      await writeFile(
        path.join(invalidPackageRoot, "package.json"),
        '{"name":"@unbrained/pm-cli","bin":{"other":"dist/cli.js"}}\n',
        "utf8",
      );
      await expectFirstDriverDrift(
        `${shellQuote(process.execPath)} ${shellQuote(invalidPackageCli)}${suffix}`,
      );
      await writeFile(
        path.join(invalidPackageRoot, "package.json"),
        '{"name":"@unbrained/pm-cli","bin":"dist/cli.js"}\n',
        "utf8",
      );
      runGit(tempRoot, [
        "config",
        "--local",
        firstDriver.key,
        `${shellQuote(process.execPath)} ${shellQuote(invalidPackageCli)}${suffix}`,
      ]);
      await expect(
        auditMergeDriverConfiguration(tempRoot),
      ).resolves.toMatchObject({
        status: "ok",
        drifted_keys: [],
      });

      runGit(tempRoot, [
        "config",
        "--local",
        firstDriver.key,
        portableCommands.get(firstDriver.key)!,
      ]);
    });
  });
});
