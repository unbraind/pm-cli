/**
 * pm-gh1777 / pm-gh1778: one --fields contract for package listings, and the
 * offline update observations `pm package manage` records for `pm context` and
 * `pm package list`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPLORE_MANAGE_ROW_FIELDS,
  parseExploreManageFields,
  parseListingFields,
  projectExploreManageRows,
  projectListingRows,
} from "../../../src/sdk/extension/listing-fields.js";
import {
  collectExtensionUpdateObservations,
  findApplicableUpdateObservation,
  readExtensionUpdateObservations,
  recordCheckedUpdateObservations,
  recordExtensionUpdateObservations,
  resolveExtensionUpdateObservationsPath,
  resolveGuardedReadFlags,
  resolveObservedUpdateVersion,
  type ExtensionUpdateObservation,
} from "../../../src/sdk/extension/update-observations.js";
import type { ManagedExtensionRecord } from "../../../src/sdk/extension/managed-state.js";
import { acquireLock } from "../../../src/core/lock/lock.js";

let scopeRoot: string;
beforeEach(async () => {
  scopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-update-observations-"));
});
afterEach(async () => {
  await fs.rm(scopeRoot, { recursive: true, force: true });
});

const record = (overrides: Partial<ManagedExtensionRecord>): ManagedExtensionRecord => ({
  name: "pm-github",
  directory: "pm-github",
  scope: "project",
  manifest_version: "2026.10.4",
  manifest_entry: "./index.mjs",
  capabilities: ["commands"],
  installed_at: "2026-10-04T00:00:00.000Z",
  updated_at: "2026-10-04T00:00:00.000Z",
  source: { kind: "npm", input: "npm:pm-github", location: "package", package: "pm-github", version: "2026.10.4" },
  ...overrides,
} as ManagedExtensionRecord);

describe("package listing --fields contract", () => {
  it("treats an absent option as no projection and refuses an empty or unknown selection with the whole domain", () => {
    for (const absent of [undefined, null, false]) expect(parseListingFields(absent, ["name"], "list")).toBeUndefined();
    expect(() => parseListingFields(" , ", ["name"], "list")).toThrow("Package list --fields requires a comma-separated list of field names");
    expect(() => parseListingFields("name,bogus", ["name", "version"], "manage")).toThrow(
      "Package manage --fields must be one of name|version; unknown: bogus",
    );
    expect(parseListingFields(" version ,name,version", ["name", "version"], "list")).toEqual(["version", "name"]);
    // SDK and MCP callers get the whole domain as structured recovery, not only in the message.
    try {
      parseListingFields("bogus", ["name", "version"], "list");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toMatchObject({ exitCode: 2, context: { code: "invalid_argument_value", recovery: { allowed_values: ["name", "version"] } } });
    }
  });

  it("projects rows in the requested order and reads a missing key as null", () => {
    expect(projectListingRows([{ name: "a", version: "1", extra: true }, { name: "b" }], ["version", "name"])).toEqual([
      { version: "1", name: "a" },
      { version: null, name: "b" },
    ]);
  });

  it("validates explore and manage selections at admission and drops contributions from default rows", () => {
    const rows = [{ name: "pm-github", version: "1", contributions: { commands: ["github sync"] } }];
    expect(() => parseExploreManageFields("name,bogus", "manage")).toThrow(/Package manage --fields must be one of name\|directory/);
    expect(parseExploreManageFields(undefined, "explore")).toBeUndefined();
    expect(projectExploreManageRows(rows, undefined)).toEqual([{ name: "pm-github", version: "1" }]);
    expect(projectExploreManageRows(rows, parseExploreManageFields("name,contributions", "explore"))).toEqual([{ name: "pm-github", contributions: { commands: ["github sync"] } }]);
    expect(EXPLORE_MANAGE_ROW_FIELDS).toContain("last_update_remote_version");
  });
});

const observation = (overrides: Partial<ExtensionUpdateObservation> = {}): ExtensionUpdateObservation => ({
  name: "pm-github",
  installed_version: "2026.10.4",
  installed_updated_at: "2026-10-04T00:00:00.000Z",
  remote_version: "2026.11.23",
  update_available: true,
  checked_at: "2026-11-24T10:00:00.000Z",
  ...overrides,
});

/** Write the managed install records of a scope; the observation writer keeps only rows for these installations. */
async function writeManagedState(records: ManagedExtensionRecord[]): Promise<void> {
  await fs.mkdir(path.join(scopeRoot, "extensions"), { recursive: true });
  await fs.writeFile(path.join(scopeRoot, "extensions", ".managed-extensions.json"), JSON.stringify({ version: 1, updated_at: "2026-10-04T00:00:00.000Z", entries: records }));
}
const extensionsRoot = (): string => path.join(scopeRoot, "extensions");

describe("extension update observations", () => {
  it("records only answered checks and never records a downgrade", () => {
    const checked = collectExtensionUpdateObservations([
      record({ name: "pm-github", last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_version: "2026.11.23", update_available: true }),
      record({ name: "pm-csv", last_update_check_at: "2026-11-24T10:00:00.000Z", update_available: false }),
      record({ name: "pm-repo", source: { kind: "github", input: "o/r", location: "o/r" } as ManagedExtensionRecord["source"], last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_commit: "0123456789abcdef0123", update_available: true }),
      // A registry latest older than the installed npm version is no update: upgrading to it would downgrade.
      record({ name: "pm-ahead", manifest_version: "2.0.0", source: { kind: "npm", input: "npm:pm-ahead", location: "package", package: "pm-ahead", version: "2.0.0" }, last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_version: "1.0.0", update_available: true }),
      // SemVer precedence: a release is newer than its own prerelease.
      record({ name: "pm-rc", manifest_version: "1.2.0-rc.1", source: { kind: "npm", input: "npm:pm-rc", location: "package", package: "pm-rc", version: "1.2.0-rc.1" }, last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_version: "1.2.0", update_available: true }),
      // The installed npm version decides, not a manifest version that differs from it.
      record({ name: "pm-skew", manifest_version: "9.0.0", source: { kind: "npm", input: "npm:pm-skew", location: "package", package: "pm-skew", version: "1.0.0" }, last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_version: "1.1.0", update_available: true }),
      record({ name: "pm-odd", manifest_version: "next", source: { kind: "npm", input: "npm:pm-odd", location: "package", package: "pm-odd" }, last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_version: "1.0.0", update_available: true }),
      record({ name: "pm-timeout", last_update_check_at: "2026-11-24T10:00:00.000Z", update_error: "timeout", update_available: null }),
      record({ name: "pm-unchecked" }),
    ]);
    expect(checked.map((entry) => [entry.name, entry.remote_version, entry.update_available])).toEqual([
      ["pm-ahead", "1.0.0", false],
      ["pm-csv", null, false],
      ["pm-github", "2026.11.23", true],
      ["pm-odd", "1.0.0", true],
      ["pm-rc", "1.2.0", true],
      ["pm-repo", "0123456789ab", true],
      ["pm-skew", "1.1.0", true],
    ]);
  });

  it("rebuilds the record from the current installations: concurrent answers survive, stale installations and removed packages drop", async () => {
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), []);
    await expect(fs.access(resolveExtensionUpdateObservationsPath(scopeRoot))).rejects.toThrow();
    const github = record({ name: "pm-github" });
    const csv = record({ name: "pm-csv", directory: "pm-csv" });
    await writeManagedState([github, csv]);
    // Two checks, each answering for a different package, keep each other's answers.
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-github" })]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "PM-CSV", remote_version: "2026.11.22" })]);
    expect((await readExtensionUpdateObservations(scopeRoot)).map((entry) => entry.name)).toEqual(["PM-CSV", "pm-github"]);
    // An older answer for the same installation does not replace a newer one; a later one does.
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-csv", remote_version: "old", checked_at: "2026-11-01T00:00:00.000Z" })]);
    expect(findApplicableUpdateObservation(await readExtensionUpdateObservations(scopeRoot), { name: "pm-csv", version: "2026.10.4", updated_at: csv.updated_at })?.remote_version).toBe("2026.11.22");
    // A reinstall replaced pm-github; a slow check answering for the old installation is dropped, not recorded over it.
    const reinstalled = { ...github, updated_at: "2026-11-25T00:00:00.000Z" };
    await writeManagedState([reinstalled]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [
      observation({ name: "pm-github", installed_updated_at: reinstalled.updated_at, remote_version: "current" }),
    ]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-github", remote_version: "stale", checked_at: "2026-12-01T00:00:00.000Z" })]);
    const stored = await readExtensionUpdateObservations(scopeRoot);
    // pm-csv was uninstalled, so its row is gone too: the record never outgrows the managed packages.
    expect(stored.map((entry) => [entry.name, entry.remote_version])).toEqual([["pm-github", "current"]]);
    // The merge runs under a released per-scope lock.
    await expect(fs.readdir(path.join(scopeRoot, "locks"))).resolves.not.toContain("extension-update-observations.lock");
  });

  it("refuses to write a record larger than the reader would accept", async () => {
    const records = Array.from({ length: 4000 }, (_, index) => record({ name: `pm-${"x".repeat(200)}-${index}`, directory: `d${index}` }));
    await writeManagedState(records);
    await expect(recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), records.map((entry) => observation({ name: entry.name })))).rejects.toThrow(/size limit/);
  });

  it("applies an observation only to the installation it was taken against", () => {
    const observations = [observation(), observation({ name: "pm-repo", installed_version: "1.0.0", remote_version: null })];
    const installed = { name: "PM-GitHub", version: "2026.10.4", updated_at: "2026-10-04T00:00:00.000Z" };
    expect(resolveObservedUpdateVersion(findApplicableUpdateObservation(observations, installed))).toBe("2026.11.23");
    // An upgrade changes the version; a commit-only reinstall of a repository source rewrites the managed record.
    expect(findApplicableUpdateObservation(observations, { ...installed, version: "2026.11.23" })).toBeUndefined();
    expect(findApplicableUpdateObservation(observations, { ...installed, updated_at: "2026-11-25T00:00:00.000Z" })).toBeUndefined();
    expect(findApplicableUpdateObservation(observations, { ...installed, version: null })).toBeUndefined();
    expect(findApplicableUpdateObservation(observations, { ...installed, updated_at: undefined })).toBeUndefined();
    expect(resolveObservedUpdateVersion(findApplicableUpdateObservation(observations, { name: "pm-repo", version: "1.0.0", updated_at: "2026-10-04T00:00:00.000Z" }))).toBe("available");
    expect(resolveObservedUpdateVersion(observation({ update_available: false }))).toBeNull();
    expect(resolveObservedUpdateVersion(undefined)).toBeNull();
  });

  it("reads a malformed, linked, special or oversized record as no knowledge", async () => {
    const file = resolveExtensionUpdateObservationsPath(scopeRoot);
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{");
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await fs.writeFile(file, JSON.stringify({ version: 1, observations: "nope" }));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await fs.writeFile(file, JSON.stringify(null));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    const valid = observation({ name: "kept", remote_version: 7 as unknown as string });
    await fs.writeFile(file, JSON.stringify({
      observations: [
        null, [], { ...valid, name: "" }, { ...valid, update_available: "yes" }, { ...valid, installed_version: undefined },
        { ...valid, installed_updated_at: undefined }, { ...valid, checked_at: undefined }, { ...valid, checked_at: "not a time" }, valid,
      ],
    }));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([{ ...valid, remote_version: null }]);
    // A link to a record elsewhere is not followed.
    const outside = path.join(scopeRoot, "outside.json");
    await fs.writeFile(outside, JSON.stringify({ observations: [valid] }));
    await fs.rm(file);
    await fs.symlink(outside, file);
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await fs.rm(file);
    // A directory or an oversized file at the record path is not one pm wrote.
    await fs.mkdir(file);
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await fs.rm(file, { recursive: true });
    await fs.writeFile(file, `{"observations":[],"pad":"${"x".repeat(1024 * 1024)}"}`);
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
  });

  it("opens without following a link or blocking where the platform supports it", () => {
    expect(resolveGuardedReadFlags({ O_RDONLY: 0 })).toBe(0);
    expect(resolveGuardedReadFlags({ O_RDONLY: 0, O_NOFOLLOW: 4, O_NONBLOCK: 8 })).toBe(12);
  });

  it.skipIf(process.platform === "win32")("never blocks on a FIFO at the record path", async () => {
    const file = resolveExtensionUpdateObservationsPath(scopeRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    execFileSync("mkfifo", [file]);
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
  });

  it("never reads or writes through a runtime path that is not a real directory", async () => {
    const elsewhere = path.join(scopeRoot, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "extension-update-observations.json"), JSON.stringify({ observations: [observation()] }));
    await fs.symlink(elsewhere, path.join(scopeRoot, "runtime"));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await expect(recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation()])).rejects.toThrow(/is not a directory/);
    expect(JSON.parse(await fs.readFile(path.join(elsewhere, "extension-update-observations.json"), "utf8")).observations).toHaveLength(1);
  });

  it("rechecks the runtime directory once the lock is held", async () => {
    await writeManagedState([record({})]);
    await fs.mkdir(path.join(scopeRoot, "runtime"));
    // Hold the lock, let the writer pass its first check and wait, then swap runtime/ for a link before releasing.
    const release = await acquireLock(scopeRoot, "extension-update-observations", 30, "test holder", false, true, 1_000);
    const pending = recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation()]);
    const settled = pending.then(() => "resolved", (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.rm(path.join(scopeRoot, "runtime"), { recursive: true });
    await fs.symlink(scopeRoot, path.join(scopeRoot, "runtime"));
    await release();
    expect(String(await settled)).toMatch(/is not a directory/);
  });

  it("records nothing for an offline check and reports a failed write as a warning code", async () => {
    const answered = [record({ last_update_check_at: "2026-11-24T10:00:00.000Z", update_available: true, last_update_remote_version: "2026.11.23" })];
    await writeManagedState(answered);
    expect(await recordCheckedUpdateObservations(scopeRoot, extensionsRoot(), answered, true)).toBeUndefined();
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    expect(await recordCheckedUpdateObservations(scopeRoot, extensionsRoot(), answered, false)).toBeUndefined();
    expect(await readExtensionUpdateObservations(scopeRoot)).toHaveLength(1);
    // A scope root that is a regular file cannot hold runtime/: the manage check keeps going with a warning.
    const fileRoot = path.join(scopeRoot, "not-a-directory");
    await fs.writeFile(fileRoot, "");
    expect(await recordCheckedUpdateObservations(fileRoot, extensionsRoot(), answered, false)).toBe("extension_update_observation_write_failed");
  });
});
