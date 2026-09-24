import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { auditDependencyCooldown, runIfMain } from "../../../../scripts/check-dependency-cooldown.mjs";

const safe = "version: 2\nupdates:\n  - package-ecosystem: npm\n    cooldown:\n      default-days: 7\n  - package-ecosystem: github-actions\n    cooldown:\n      default-days: 7\n";

describe("dependency update cooldown policy", () => {
  it("requires an explicit minimum on every ecosystem and rejects dilution controls", () => {
    expect(auditDependencyCooldown(safe)).toEqual([]);
    expect(auditDependencyCooldown(safe.replaceAll("default-days: 7", "default-days: 14"))).toEqual([]);
    for (const value of ["0", "6", "7.5", "null", '"7"']) {
      expect(auditDependencyCooldown(safe.replace("default-days: 7", `default-days: ${value}`))).toEqual([
        "dependabot.yml: updates[0]: default-days must be an integer of at least 7",
      ]);
    }
    for (const field of ["semver-major-days", "semver-minor-days", "semver-patch-days"]) {
      expect(auditDependencyCooldown(safe.replace("default-days: 7", `default-days: 7\n      ${field}: 7`))).toEqual([]);
      for (const value of ["0", '"7"']) {
        expect(auditDependencyCooldown(safe.replace("default-days: 7", `default-days: 7\n      ${field}: ${value}`))).toEqual([
          `dependabot.yml: updates[0]: ${field} must not bypass the seven-day minimum`,
        ]);
      }
    }
    for (const field of ["include", "exclude"]) {
      expect(auditDependencyCooldown(safe.replace("default-days: 7", `default-days: 7\n      ${field}: ['*']`))).toEqual([
        "dependabot.yml: updates[0]: cooldown must cover all dependencies without include/exclude bypasses",
      ]);
    }
  });

  it("fails closed on malformed, empty, duplicated, and missing declarations", () => {
    for (const source of ["", "updates: []", "updates: {}", "version: 2"]) {
      expect(auditDependencyCooldown(source)).toEqual(["dependabot.yml: updates must be a nonempty array"]);
    }
    for (const source of ["updates: [", "updates: []\nupdates: []"]) {
      expect(auditDependencyCooldown(source)).toEqual(["dependabot.yml: invalid YAML"]);
    }
    for (const source of ["updates: [null]", "updates: [{}]", "updates: [{cooldown: null}]"]) {
      expect(auditDependencyCooldown(source)).toEqual(["dependabot.yml: updates[0]: default-days must be an integer of at least 7"]);
    }
  });

  it("enforces the CLI exit status against actual temporary configuration files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-cooldown-"));
    const config = path.join(root, "dependabot.yml");
    const entrypoint = path.resolve("scripts/check-dependency-cooldown.mjs");
    const previousExitCode = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runIfMain(undefined, config);
      await runIfMain("other.mjs", config);
      expect(stdout).not.toHaveBeenCalled();
      await expect(runIfMain(entrypoint, config)).rejects.toThrow("ENOENT");
      await writeFile(config, safe);
      await runIfMain(entrypoint, config);
      expect(process.exitCode).toBe(0);
      expect(stdout).toHaveBeenCalledWith("Dependency cooldown: explicit seven-day minimum verified\n");
      await writeFile(config, safe.replaceAll("default-days: 7", "default-days: 0"));
      await runIfMain(entrypoint, config);
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledTimes(2);
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
      stderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
