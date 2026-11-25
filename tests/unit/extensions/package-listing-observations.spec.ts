/**
 * pm-gh1777 / pm-gh1778: one --fields contract for package listings, and the
 * offline update observations `pm package manage` records for `pm context` and
 * `pm package list`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPLORE_MANAGE_ROW_FIELDS,
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
  resolveObservedUpdateVersion,
  type ExtensionUpdateObservation,
} from "../../../src/sdk/extension/update-observations.js";
import type { ManagedExtensionRecord } from "../../../src/sdk/extension/managed-state.js";

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
  });

  it("projects rows in the requested order and reads a missing key as null", () => {
    expect(projectListingRows([{ name: "a", version: "1", extra: true }, { name: "b" }], ["version", "name"])).toEqual([
      { version: "1", name: "a" },
      { version: null, name: "b" },
    ]);
  });

  it("drops the embedded contributions map from default explore and manage rows, and returns it on request", () => {
    const rows = [{ name: "pm-github", version: "1", contributions: { commands: ["github sync"] } }];
    expect(projectExploreManageRows(rows, undefined, "manage")).toEqual([{ name: "pm-github", version: "1" }]);
    expect(projectExploreManageRows(rows, "name,contributions", "explore")).toEqual([{ name: "pm-github", contributions: { commands: ["github sync"] } }]);
    expect(EXPLORE_MANAGE_ROW_FIELDS).toContain("last_update_remote_version");
  });
});

describe("extension update observations", () => {
  it("records only answered checks, keeps earlier observations for unanswered packages, and reads them back", async () => {
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await recordExtensionUpdateObservations(scopeRoot, []);
    await expect(fs.access(resolveExtensionUpdateObservationsPath(scopeRoot))).rejects.toThrow();

    const checked = collectExtensionUpdateObservations([
      record({ name: "pm-github", last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_version: "2026.11.23", update_available: true }),
      record({ name: "pm-csv", last_update_check_at: "2026-11-24T10:00:00.000Z", update_available: false }),
      record({ name: "pm-repo", last_update_check_at: "2026-11-24T10:00:00.000Z", last_update_remote_commit: "0123456789abcdef0123", update_available: true }),
      record({ name: "pm-timeout", last_update_check_at: "2026-11-24T10:00:00.000Z", update_error: "timeout", update_available: null }),
      record({ name: "pm-unchecked" }),
    ]);
    expect(checked.map((entry) => [entry.name, entry.remote_version, entry.update_available])).toEqual([
      ["pm-csv", null, false],
      ["pm-github", "2026.11.23", true],
      ["pm-repo", "0123456789ab", true],
    ]);
    await recordExtensionUpdateObservations(scopeRoot, checked);
    // A later check that only answers for pm-csv keeps what the earlier one learned about the others.
    const later: ExtensionUpdateObservation = { name: "PM-CSV", installed_version: "2026.10.4", remote_version: "2026.11.22", update_available: true, checked_at: "2026-11-25T10:00:00.000Z" };
    await recordExtensionUpdateObservations(scopeRoot, [later]);
    const stored = await readExtensionUpdateObservations(scopeRoot);
    expect(stored.map((entry) => entry.name)).toEqual(["pm-github", "pm-repo", "PM-CSV"].sort((left, right) => left.localeCompare(right)));
    expect(findApplicableUpdateObservation(stored, "pm-csv", "2026.10.4")).toEqual(later);
  });

  it("applies an observation only to the installed version it was taken against", () => {
    const observations: ExtensionUpdateObservation[] = [
      { name: "pm-github", installed_version: "2026.10.4", remote_version: "2026.11.23", update_available: true, checked_at: "2026-11-24T10:00:00.000Z" },
      { name: "pm-repo", installed_version: "1.0.0", remote_version: null, update_available: true, checked_at: "2026-11-24T10:00:00.000Z" },
    ];
    expect(resolveObservedUpdateVersion(findApplicableUpdateObservation(observations, "PM-GitHub", "2026.10.4"))).toBe("2026.11.23");
    expect(findApplicableUpdateObservation(observations, "pm-github", "2026.11.23")).toBeUndefined();
    expect(findApplicableUpdateObservation(observations, "pm-github", null)).toBeUndefined();
    expect(resolveObservedUpdateVersion(findApplicableUpdateObservation(observations, "pm-repo", "1.0.0"))).toBe("available");
    expect(resolveObservedUpdateVersion({ ...observations[0], update_available: false })).toBeNull();
    expect(resolveObservedUpdateVersion(undefined)).toBeNull();
  });

  it("reads a malformed record as no knowledge and skips malformed rows", async () => {
    const file = resolveExtensionUpdateObservationsPath(scopeRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{");
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await fs.writeFile(file, JSON.stringify({ version: 1, observations: "nope" }));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await fs.writeFile(file, JSON.stringify(null));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    await fs.writeFile(file, JSON.stringify({
      observations: [
        null,
        [],
        { name: "", installed_version: "1", update_available: true, checked_at: "t" },
        { name: "a", installed_version: "1", update_available: "yes", checked_at: "t" },
        { name: "a", update_available: true, checked_at: "t" },
        { name: "a", installed_version: "1", update_available: true },
        { name: "kept", installed_version: "1", remote_version: 7, update_available: true, checked_at: "t" },
      ],
    }));
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([
      { name: "kept", installed_version: "1", remote_version: null, update_available: true, checked_at: "t" },
    ]);
  });

  it("records nothing for an offline check and reports a failed write as a warning code", async () => {
    const answered = [record({ last_update_check_at: "2026-11-24T10:00:00.000Z", update_available: true, last_update_remote_version: "2026.11.23" })];
    expect(await recordCheckedUpdateObservations(scopeRoot, answered, true)).toBeUndefined();
    expect(await readExtensionUpdateObservations(scopeRoot)).toEqual([]);
    expect(await recordCheckedUpdateObservations(scopeRoot, answered, false)).toBeUndefined();
    expect(await readExtensionUpdateObservations(scopeRoot)).toHaveLength(1);
    // A scope root that is a regular file cannot hold runtime/: the manage check keeps going with a warning.
    const fileRoot = path.join(scopeRoot, "not-a-directory");
    await fs.writeFile(fileRoot, "");
    expect(await recordCheckedUpdateObservations(fileRoot, answered, false)).toBe("extension_update_observation_write_failed");
  });
});
