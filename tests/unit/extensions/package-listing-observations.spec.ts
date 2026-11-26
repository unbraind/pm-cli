/**
 * pm-gh1777 / pm-gh1778: one --fields contract for package listings, and the
 * offline update observations `pm package manage` records for `pm context` and
 * `pm package list`.
 */
import { runWithReproducibleExecution } from "../../../src/core/reproducibility/context.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  readStrictManagedRecords,
  recordExtensionUpdateObservations,
  resolveExtensionUpdateObservationsPath,
  resolveGuardedReadFlags,
  resolveObservedUpdateVersion,
  type ExtensionUpdateObservation,
} from "../../../src/sdk/extension/update-observations.js";
import type { ManagedExtensionRecord } from "../../../src/sdk/extension/managed-state.js";
import { isExactNpmVersion, isLocalNpmSpec, isNewerRegistryVersion, isRegistryNpmSource } from "../../../src/sdk/extension/npm-spec.js";
import { acquireLock } from "../../../src/core/lock/lock.js";
import { refreshManagedExtensionUpdates } from "../../../src/sdk/extension/managed-update-status.js";

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

describe("npm install source classification", () => {
  it("separates registry installs from local, tarball, file:, git and URL specs with npm's own parser", () => {
    expect(isLocalNpmSpec("/tmp/pkg")).toBe(true);
    expect(isLocalNpmSpec("./pkg.tgz")).toBe(true);
    expect(isLocalNpmSpec("file:../pkg")).toBe(true);
    // A bare tarball and a name@file: alias are local even without a leading path (Codex review round 4).
    expect(isLocalNpmSpec("package-1.0.0.tgz")).toBe(true);
    expect(isLocalNpmSpec("name@file:../x")).toBe(true);
    // An unprefixed relative archive path is local too (CodeRabbit review round 4).
    expect(isLocalNpmSpec("artifacts/pkg.tgz")).toBe(true);
    expect(isLocalNpmSpec("artifacts/pkg.TAR.GZ")).toBe(true);
    expect(isLocalNpmSpec("@scope/pkg")).toBe(false);
    // npm's registry verdict wins over the archive suffix for a scoped name (Codex review round 6).
    expect(isLocalNpmSpec("@scope/plugin.tgz")).toBe(false);
    expect(isLocalNpmSpec("@@not a spec")).toBe(false);
    const npm = (input: string) => ({ kind: "npm" as const, input, location: "package" });
    expect(isRegistryNpmSource(npm("npm:@scope/pkg@1.0.0"))).toBe(true);
    expect(isRegistryNpmSource(npm("pm-github"))).toBe(true);
    expect(isRegistryNpmSource(npm("npm:pm-github@latest"))).toBe(true);
    expect(isRegistryNpmSource(npm("npm:alias@npm:pm-github@1.0.0"))).toBe(true);
    for (const local of ["npm:artifacts/pkg.tgz", "npm:./pkg.tgz", "file:/abs/pkg", "npm:package-1.0.0.tgz", "npm:name@file:../x", "npm:github:o/r", "npm:https://x/y.tgz", "npm:@@not a spec"]) {
      expect(isRegistryNpmSource(npm(local)), local).toBe(false);
    }
    expect(isRegistryNpmSource({ kind: "github", input: "o/r", location: "o/r" })).toBe(false);
  });

  it("judges a registry latest by SemVer precedence, never as a downgrade", () => {
    expect(isNewerRegistryVersion("2026.11.23", "2026.10.4")).toBe(true);
    expect(isNewerRegistryVersion("1.0.0", "2.0.0")).toBe(false);
    expect(isNewerRegistryVersion("1.0.0", "1.0.0")).toBe(false);
    // Loose exact versions npm admits compare by precedence, never by string inequality (Codex review round 15).
    expect(isNewerRegistryVersion("01.0.0", "2.0.0")).toBe(false);
    expect(isNewerRegistryVersion("2.0.1", "02.0.0")).toBe(true);
    expect(isNewerRegistryVersion("1.2.0", "1.2.0-rc.1")).toBe(true);
    expect(isNewerRegistryVersion("next", "1.0.0")).toBe(true);
    expect(isNewerRegistryVersion("next", "next")).toBe(false);
  });
});

describe("package listing --fields contract", () => {
  it("treats an absent option as no projection and refuses an empty or unknown selection with the whole domain", () => {
    for (const absent of [undefined, null, false]) expect(parseListingFields(absent, ["name"], "list")).toBeUndefined();
    expect(() => parseListingFields(" , ", ["name"], "list")).toThrow("Package list --fields requires a comma-separated list of field names");
    // The legal domain travels in recovery.allowed_values only, so renderers bound it (Codex review round 8).
    expect(() => parseListingFields("name,bogus", ["name", "version"], "manage")).toThrow("Package manage --fields has unknown field(s): bogus");
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
    expect(() => parseExploreManageFields("name,bogus", "manage")).toThrow("Package manage --fields has unknown field(s): bogus");
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
  it("records only answered registry checks, as the provider judged them", () => {
    const checked = collectExtensionUpdateObservations([
      record({ name: "pm-github", last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_version: "2026.11.23", update_available: true }),
      record({ name: "pm-csv", last_update_check_at: "2026-11-24T10:00:00.000Z", update_available: false }),
      record({ name: "pm-repo", source: { kind: "github", input: "o/r", location: "o/r" } as ManagedExtensionRecord["source"], last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_commit: "0123456789abcdef0123", update_available: true }),
      record({ name: "pm-timeout", last_update_check_at: "2026-11-24T10:00:00.000Z", update_error: "timeout", update_available: null }),
      // A field longer than the reader accepts is never written, so writer and reader agree (Codex review round 10).
      record({ name: "pm-long", manifest_version: "1".repeat(257), last_update_check_at: "2026-11-24T10:00:00.000Z", update_available: true }),
      // A local npm artifact is reinstalled as it is, so a registry release is never an update for it.
      record({ name: "pm-tarball", source: { kind: "npm", input: "npm:./pm-tarball-1.0.0.tgz", location: "package", package: "pm-tarball", version: "1.0.0" }, last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_version: "2.0.0", update_available: true }),
      record({ name: "pm-unchecked" }),
      // A source kind the refresh skips keeps any stale verdict out of the record (Codex review round 8).
      record({ name: "pm-local", source: { kind: "local", input: "./pm-local", location: "/tmp/pm-local" }, last_update_check_at: "2026-11-24T10:00:00.000Z", update_available: true }),
    ]);
    // The provider verdict (SemVer-aware for npm, see isNewerRegistryVersion) is recorded as it is.
    expect(checked.map((entry) => [entry.name, entry.remote_version, entry.update_available])).toEqual([
      ["pm-csv", null, false],
      ["pm-github", "2026.11.23", true],
      ["pm-repo", "0123456789ab", true],
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
    // A cached answer the current source could not have produced never wins the newest-first pick (Codex review round 15).
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-csv", remote_version: "not-a-version", checked_at: "2026-11-30T00:00:00.000Z" })]);
    expect(findApplicableUpdateObservation(await readExtensionUpdateObservations(scopeRoot), { name: "pm-csv", version: "2026.10.4", updated_at: csv.updated_at })?.remote_version).toBe("2026.11.22");
    // An older answer for the same installation does not replace a newer one; a later one does.
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-csv", remote_version: "2026.11.1", checked_at: "2026-11-01T00:00:00.000Z" })]);
    expect(findApplicableUpdateObservation(await readExtensionUpdateObservations(scopeRoot), { name: "pm-csv", version: "2026.10.4", updated_at: csv.updated_at })?.remote_version).toBe("2026.11.22");
    // A reinstall replaced pm-github; a slow check answering for the old installation is dropped, not recorded over it.
    const reinstalled = { ...github, updated_at: "2026-11-25T00:00:00.000Z" };
    await writeManagedState([reinstalled]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [
      observation({ name: "pm-github", installed_updated_at: reinstalled.updated_at, remote_version: "2026.11.24" }),
    ]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-github", remote_version: "2026.12.1", checked_at: "2026-12-01T00:00:00.000Z" })]);
    const stored = await readExtensionUpdateObservations(scopeRoot);
    // pm-csv was uninstalled, so its row is gone too: the record never outgrows the managed packages.
    expect(stored.map((entry) => [entry.name, entry.remote_version])).toEqual([["pm-github", "2026.11.24"]]);
    // A lock path that is not a regular file refuses the derived write instead of hanging on it (Codex review round 15).
    const lockPath = path.join(scopeRoot, "locks", "extension-update-observations.lock");
    await fs.mkdir(lockPath, { recursive: true });
    await expect(recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation()])).rejects.toThrow("not a small regular file");
    await fs.rm(lockPath, { recursive: true });
    // So does a stale-cleanup gate owner file that is not a regular file (Codex review round 17).
    const gateOwner = path.join(`${lockPath}.stale-cleanup`, "owner.json");
    await fs.mkdir(gateOwner, { recursive: true });
    await expect(recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation()])).rejects.toThrow("not a small regular file");
    await fs.rm(`${lockPath}.stale-cleanup`, { recursive: true });
    // An oversized regular lock file is refused too, since the core lease reads it whole (Codex review round 18).
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "x".repeat(64 * 1024 + 1));
    await expect(recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation()])).rejects.toThrow("not a small regular file");
    await fs.rm(lockPath);
    // The merge runs under a released per-scope lock.
    await expect(fs.readdir(path.join(scopeRoot, "locks"))).resolves.not.toContain("extension-update-observations.lock");
  });

  it("keeps new answers when the managed state is unreadable mid-write, and prunes on the next complete read (Codex review round 5)", async () => {
    await writeManagedState([record({ name: "pm-github" })]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-github" })]);
    // A lifecycle write is half done: the merge keeps the stored answer and adds the new one.
    await fs.writeFile(path.join(scopeRoot, "extensions", ".managed-extensions.json"), "{\"version\":1,\"entr");
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [
      observation({ name: "pm-csv" }),
      observation({ name: "pm-github", remote_version: "older", checked_at: "2026-11-01T00:00:00.000Z" }),
    ]);
    expect((await readExtensionUpdateObservations(scopeRoot)).map((entry) => [entry.name, entry.remote_version])).toEqual([["pm-csv", "2026.11.23"], ["pm-github", "2026.11.23"]]);
    // Once the state is readable again, rows for packages no longer installed are dropped.
    await writeManagedState([record({ name: "pm-github" })]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-github", checked_at: "2026-11-25T00:00:00.000Z" })]);
    expect((await readExtensionUpdateObservations(scopeRoot)).map((entry) => entry.name)).toEqual(["pm-github"]);
  });

  it("does not prune against a managed state with a malformed entry, and reads it as unknown (Codex review round 6)", async () => {
    await writeManagedState([record({ name: "pm-github" }), record({ name: "pm-csv", directory: "pm-csv" })]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-github" }), observation({ name: "pm-csv" })]);
    // One entry turns malformed: the shared reader would drop it silently, so the snapshot is not complete.
    const valid = record({ name: "pm-github" });
    await fs.writeFile(path.join(scopeRoot, "extensions", ".managed-extensions.json"), JSON.stringify({ version: 1, updated_at: "2026-10-04T00:00:00.000Z", entries: [valid, { name: 42 }] }));
    expect(await readStrictManagedRecords(extensionsRoot())).toBeUndefined();
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation({ name: "pm-github", checked_at: "2026-11-25T00:00:00.000Z" })]);
    expect((await readExtensionUpdateObservations(scopeRoot)).map((entry) => entry.name)).toEqual(["pm-csv", "pm-github"]);
    // An absent file is a complete, empty snapshot; an unreadable one (here a directory) is no snapshot.
    await fs.rm(path.join(scopeRoot, "extensions", ".managed-extensions.json"));
    expect(await readStrictManagedRecords(extensionsRoot())).toEqual([]);
    await fs.mkdir(path.join(scopeRoot, "extensions", ".managed-extensions.json"));
    expect(await readStrictManagedRecords(extensionsRoot())).toBeUndefined();
    // A read that fails for any reason other than absence is no snapshot either.
    await fs.rm(path.join(scopeRoot, "extensions", ".managed-extensions.json"), { recursive: true });
    await writeManagedState([valid]);
    const spy = vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    try {
      expect(await readStrictManagedRecords(extensionsRoot())).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("skips the live registry lookup for a non-registry npm source and clears any stored verdict (CodeRabbit review round 8)", async () => {
    const tarball = record({
      name: "pm-tarball", source: { kind: "npm", input: "npm:./pm-tarball-1.0.0.tgz", location: ".", package: "pm-tarball", version: "1.0.0" },
      last_update_check_at: "2026-11-01T00:00:00.000Z", last_update_remote_version: "2.0.0", update_available: true,
    });
    const refreshed = await refreshManagedExtensionUpdates({ version: 1, updated_at: "2026-10-04T00:00:00.000Z", entries: [tarball] });
    expect(refreshed.entries[0]).toMatchObject({ name: "pm-tarball", update_available: null });
    expect(refreshed.entries[0]?.last_update_check_at).toBeUndefined();
    expect(refreshed.entries[0]?.last_update_remote_version).toBeUndefined();
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

  it("rejects a cached verdict the current managed source could not have produced (Codex review round 12)", () => {
    const npm = { kind: "npm" as const, input: "npm:pm-github", location: "package", package: "pm-github", version: "2026.10.4" };
    const installed = { name: "pm-github", version: "2026.10.4", updated_at: "2026-10-04T00:00:00.000Z" };
    expect(findApplicableUpdateObservation([observation()], { ...installed, source: npm })?.remote_version).toBe("2026.11.23");
    // An edited row claiming an older npm release, or an update with no version, is not one a check produced.
    expect(findApplicableUpdateObservation([observation({ remote_version: "2026.1.1" })], { ...installed, source: npm })).toBeUndefined();
    expect(findApplicableUpdateObservation([observation({ remote_version: null })], { ...installed, source: npm })).toBeUndefined();
    // Build metadata is part of an exact version the live check accepts, so the cache reader accepts it too (round 14).
    expect(isExactNpmVersion("2.0.0+build.1")).toBe(true);
    expect(isExactNpmVersion("^2.0.0")).toBe(false);
    expect(isExactNpmVersion("@@")).toBe(false);
    expect(findApplicableUpdateObservation([observation({ remote_version: "2026.11.23+build.1" })], { ...installed, source: npm })?.remote_version).toBe("2026.11.23+build.1");
    // The newest valid row wins: an older positive row never masks a newer negative one, and an incompatible row
    // never masks a valid one (Codex review round 16).
    expect(findApplicableUpdateObservation([
      observation({ checked_at: "2026-11-24T10:00:00.000Z" }),
      observation({ remote_version: "2026.10.4", update_available: false, checked_at: "2026-11-25T10:00:00.000Z" }),
    ], { ...installed, source: npm })?.update_available).toBe(false);
    // A negative row whose own versions say update is contradictory, so it cannot hide the valid positive row (round 19).
    expect(findApplicableUpdateObservation([
      observation({ checked_at: "2026-11-24T10:00:00.000Z" }),
      observation({ update_available: false, checked_at: "2026-11-25T10:00:00.000Z" }),
    ], { ...installed, source: npm })?.update_available).toBe(true);
    expect(findApplicableUpdateObservation([
      observation({ remote_version: "not-a-version", checked_at: "2026-11-26T10:00:00.000Z" }),
      observation({ checked_at: "2026-11-24T10:00:00.000Z" }),
    ], { ...installed, source: npm })?.remote_version).toBe("2026.11.23");
    // A cached registry version the live check would refuse (not exact SemVer) is rejected (Codex review round 13).
    expect(findApplicableUpdateObservation([observation({ remote_version: "not-a-version" })], { ...installed, source: npm })).toBeUndefined();
    // npm resolves a leading-v version as exact, so the live check could record it, and the reader accepts it too.
    expect(findApplicableUpdateObservation([observation({ remote_version: "v2026.11.23" })], { ...installed, source: npm })?.remote_version).toBe("v2026.11.23");
    // Without a recorded npm version, the manifest version the observation was taken against is compared.
    const { version: _version, ...unversioned } = npm;
    expect(findApplicableUpdateObservation([observation()], { ...installed, source: unversioned })?.remote_version).toBe("2026.11.23");
    // A local artifact is never checked, so a cached update for it is rejected; a "no update" row is harmless.
    const local = { kind: "local" as const, input: "./pm-github", location: "/tmp/pm-github" };
    expect(findApplicableUpdateObservation([observation()], { ...installed, source: local })).toBeUndefined();
    expect(findApplicableUpdateObservation([observation({ update_available: false })], { ...installed, source: local })).toBeDefined();
    // A repository source reports commits, which carry no version order.
    const github = { kind: "github" as const, input: "o/r", location: "o/r" };
    expect(findApplicableUpdateObservation([observation({ remote_version: "0123456789ab" })], { ...installed, source: github })).toBeDefined();
    // A positive verdict without the remote commit the live check always records is rejected (CodeRabbit review round 10);
    // a negative one needs no commit.
    expect(findApplicableUpdateObservation([observation({ remote_version: null })], { ...installed, source: github })).toBeUndefined();
    expect(findApplicableUpdateObservation([observation({ remote_version: null, update_available: false })], { ...installed, source: github })).toBeDefined();
    // Anything but the hexadecimal commit a repository check records is rejected (Codex review round 14).
    expect(findApplicableUpdateObservation([observation({ remote_version: "abc\n```sh" })], { ...installed, source: github })).toBeUndefined();
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
    // Another envelope version is not one this reader understands (Codex review round 5).
    await fs.writeFile(file, JSON.stringify({ version: 2, observations: [observation()] }));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    const valid = observation({ name: "kept", remote_version: null });
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      observations: [
        // A wrong-typed remote version is not a row pm wrote, so it cannot count as an update (Codex review round 5).
        { ...valid, remote_version: { injected: true } }, { ...valid, remote_version: 7 },
        // A field longer than any pm writes would fill the record and block later merges (Codex review round 7).
        { ...valid, remote_version: "9".repeat(257) }, { ...valid, name: "n".repeat(257) },
        null, [], { ...valid, name: "" }, { ...valid, update_available: "yes" }, { ...valid, installed_version: undefined },
        { ...valid, installed_updated_at: undefined }, { ...valid, checked_at: undefined }, { ...valid, checked_at: "not a time" },
        // A check dated beyond the clock-skew tolerance would outrank every later check (Codex review round 4).
        { ...valid, checked_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }, valid,
      ],
    }));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([valid]);
    await fs.rm(file);
    // A directory or an oversized file at the record path is not one pm wrote; the size control below the limit
    // is the same valid envelope, so only the size can reject it (CodeRabbit review round 12).
    await fs.mkdir(file);
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await fs.rm(file, { recursive: true });
    const padded = (bytes: number) => JSON.stringify({ version: 1, observations: [valid], pad: "x".repeat(bytes) });
    await fs.writeFile(file, padded(1024));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([valid]);
    await fs.writeFile(file, padded(1024 * 1024));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
  });

  it("reads the whole record when the filesystem returns it in pieces (Greptile review round 3)", async () => {
    await writeManagedState([record({})]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation()]);
    const realOpen = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      // Return at most 7 bytes per read, as a network filesystem may.
      (handle as unknown as { read: unknown }).read = (buffer: Buffer, offset: number, length: number, position: number) => realRead(buffer, offset, Math.min(length, 7), position);
      return handle;
    });
    try {
      expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([observation()]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("rechecks the opened descriptor, so an entry swapped after the path check is not read", async () => {
    await writeManagedState([record({})]);
    await recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation()]);
    const realOpen = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      // The descriptor now names something that is not a regular file.
      (handle as unknown as { stat: unknown }).stat = async () => ({ isFile: () => false });
      return handle;
    });
    try {
      expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("opens without following a link or blocking where the platform supports it", () => {
    expect(resolveGuardedReadFlags({ O_RDONLY: 0 })).toBe(0);
    expect(resolveGuardedReadFlags({ O_RDONLY: 0, O_NOFOLLOW: 4, O_NONBLOCK: 8 })).toBe(12);
    // A reader that honors links keeps only the non-blocking flag.
    expect(resolveGuardedReadFlags({ O_RDONLY: 0, O_NOFOLLOW: 4, O_NONBLOCK: 8 }, true)).toBe(8);
    expect(resolveGuardedReadFlags({ O_RDONLY: 0 }, true)).toBe(0);
  });

  it.skipIf(process.platform === "win32")("never blocks on a FIFO in place of the managed state while merging (Codex review round 11)", async () => {
    await fs.mkdir(path.join(scopeRoot, "extensions"), { recursive: true });
    execFileSync("mkfifo", [path.join(scopeRoot, "extensions", ".managed-extensions.json")]);
    expect(await readStrictManagedRecords(extensionsRoot())).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("never blocks on a FIFO at the record path", async () => {
    const file = resolveExtensionUpdateObservationsPath(scopeRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    execFileSync("mkfifo", [file]);
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
  });

  // File links need a privilege on Windows (CodeRabbit review round 12).
  it.skipIf(process.platform === "win32")("does not follow a link at the record path to a record elsewhere", async () => {
    const file = resolveExtensionUpdateObservationsPath(scopeRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const outside = path.join(scopeRoot, "outside.json");
    await fs.writeFile(outside, JSON.stringify({ version: 1, observations: [observation()] }));
    await fs.symlink(outside, file);
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
  });

  it("never reads or writes through a runtime path that is not a real directory", async () => {
    const elsewhere = path.join(scopeRoot, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "extension-update-observations.json"), JSON.stringify({ version: 1, observations: [observation()] }));
    // A junction needs no privilege on Windows, and reads as a link there just as a directory link does elsewhere.
    await fs.symlink(elsewhere, path.join(scopeRoot, "runtime"), process.platform === "win32" ? "junction" : "dir");
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await expect(recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation()])).rejects.toThrow(/is not a directory/);
    expect(JSON.parse(await fs.readFile(path.join(elsewhere, "extension-update-observations.json"), "utf8")).observations).toHaveLength(1);
  });

  it("rechecks the runtime directory once the lock is held", async () => {
    await writeManagedState([record({})]);
    await fs.mkdir(path.join(scopeRoot, "runtime"));
    // Hold the lock; once the writer's first runtime/ check has returned a directory (an explicit barrier, not a delay),
    // swap runtime/ for a link and release, so only the post-lock recheck can refuse (CodeRabbit review round 7).
    const runtimeDir = path.join(scopeRoot, "runtime");
    const release = await acquireLock(scopeRoot, "extension-update-observations", 30, "test holder", false, true, 1_000);
    let firstCheckPassed!: () => void;
    const barrier = new Promise<void>((resolve) => { firstCheckPassed = resolve; });
    const realLstat = fs.lstat.bind(fs);
    const spy = vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await realLstat(...args);
      if (String(args[0]) === runtimeDir) firstCheckPassed();
      return stat;
    });
    try {
      const settled = recordExtensionUpdateObservations(scopeRoot, extensionsRoot(), [observation()]).then(() => "resolved", (error: unknown) => error);
      await barrier;
      await fs.rm(runtimeDir, { recursive: true });
      await fs.symlink(scopeRoot, runtimeDir, process.platform === "win32" ? "junction" : "dir");
      await release();
      expect(String(await settled)).toMatch(/is not a directory/);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the typed reason of a failed write, such as a held lock, in the warning (Codex review round 7)", async () => {
    const answered = [record({ last_update_check_at: "2026-11-24T10:00:00.000Z", update_available: true, last_update_remote_version: "2026.11.23" })];
    await writeManagedState(answered);
    const release = await acquireLock(scopeRoot, "extension-update-observations", 60, "another manage", false, true, 1_000);
    try {
      expect(await recordCheckedUpdateObservations(scopeRoot, extensionsRoot(), answered, false)).toMatch(/^extension_update_observation_write_failed:[a-z_]+$/u);
    } finally {
      await release();
    }
  });

  it("records nothing for an offline check and reports a failed write as a warning code", async () => {
    const answered = [record({ last_update_check_at: "2026-11-24T10:00:00.000Z", update_available: true, last_update_remote_version: "2026.11.23" })];
    await writeManagedState(answered);
    expect(await recordCheckedUpdateObservations(scopeRoot, extensionsRoot(), answered, true)).toBeUndefined();
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    // A pinned reproducible clock cannot order a wall-clock cache, so such a run records nothing (Codex review round 16).
    await runWithReproducibleExecution({ clock: "2026-11-24T10:00:00.000Z", seed: "observations", tickMs: 0 }, async () => {
      expect(await recordCheckedUpdateObservations(scopeRoot, extensionsRoot(), answered, false)).toBeUndefined();
    });
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    expect(await recordCheckedUpdateObservations(scopeRoot, extensionsRoot(), answered, false)).toBeUndefined();
    expect(await readExtensionUpdateObservations(scopeRoot)).toHaveLength(1);
    // A scope root that is a regular file cannot hold runtime/: the manage check keeps going with a warning.
    const fileRoot = path.join(scopeRoot, "not-a-directory");
    await fs.writeFile(fileRoot, "");
    expect(await recordCheckedUpdateObservations(fileRoot, extensionsRoot(), answered, false)).toBe("extension_update_observation_write_failed");
  });
});
