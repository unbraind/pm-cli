import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryLock } from "../../../../../scripts/release/dependency-advisories/inventory.mjs";
import { queryOsv, queryRegistry, OSV_ENDPOINT } from "../../../../../scripts/release/dependency-advisories/feeds.mjs";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawn }));
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
const packages = [{ name: "@example/fixture", version: "1.2.3-beta+build" }];
const lock = (key = "@example/fixture@1.2.3-beta+build", resolution = { integrity: "sha512-fixture" }) =>
  `lockfileVersion: '9.0'\npackages:\n  '${key}':\n    resolution: ${JSON.stringify(resolution)}\n`;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{}] }) }));
  spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: counts } }), stderr: "" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("complete lock inventory", () => {
  it("includes scoped, prerelease, build and optional platform variants in deterministic order", () => {
    expect(inventoryLock(`${lock()}  'aaa@2.0.0':\n    resolution: {integrity: sha512-optional}\n    optional: true\n`)).toEqual([...packages, { name: "aaa", version: "2.0.0" }]);
  });
  it.each([
    "null", "scalar", "packages: {}", "lockfileVersion: '8.0'", "lockfileVersion: '9.0'\npackages: []",
    "lockfileVersion: '9.0'\npackages: {}", "lockfileVersion: [", lock("bad/git@hash"),
    lock("fixture@1.2.3", {}), lock("fixture@1.2.3", { integrity: "hash", tarball: "https://private.invalid" }),
    `${lock()}lockfileVersion: '9.0'`,
  ])("refuses unsupported or empty coverage: %s", (text) => expect(() => inventoryLock(text)).toThrow());
  it("refuses an unbounded population", () => {
    const text = `lockfileVersion: '9.0'\npackages:\n${Array.from({ length: 5001 }, (_, index) => `  'fixture@1.0.${index}':\n    resolution: {integrity: sha512-fixture}\n`).join("")}`;
    expect(() => inventoryLock(text)).toThrow("bounded coverage");
  });
});

describe("independent feed boundaries", () => {
  it("runs the real all-severity audit argument vector and records positives", () => {
    expect(queryRegistry("/fixture")).toMatchObject({ status: "complete", counts, ids: [], database_updated_at: null });
    expect(spawn).toHaveBeenCalledWith(process.platform === "win32" ? "cmd.exe" : "pnpm", process.platform === "win32" ? ["/d", "/s", "/c", "pnpm.cmd audit --json"] : ["audit", "--json"], expect.objectContaining({ cwd: "/fixture", timeout: 60000 }));
    spawn.mockReturnValue({ status: 1, stdout: JSON.stringify({ advisories: { "42": {} }, metadata: { vulnerabilities: { ...counts, low: 1 } } }) });
    expect(queryRegistry("/fixture")).toMatchObject({ counts: { low: 1 }, ids: ["42"] });
  });
  it("uses a fixed native command on Windows without interpolating the workspace", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    queryRegistry("C:/fixture %literal% spaces");
    expect(spawn).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", "pnpm.cmd audit --json"], expect.objectContaining({ cwd: "C:/fixture %literal% spaces" }));
  });
  it.each([
    { status: 0, stdout: "not-json" },
    { status: 0, stdout: "{}" },
    { status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { ...counts, low: -1 } } }) },
    { status: 1, stdout: JSON.stringify({ metadata: { vulnerabilities: counts } }) },
    { status: 0, error: { code: "ETIMEDOUT" }, stdout: JSON.stringify({ metadata: { vulnerabilities: counts } }) },
    { status: 0, signal: "SIGTERM", stdout: JSON.stringify({ metadata: { vulnerabilities: counts } }) },
    { status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: counts }, advisories: [] }) },
    { status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: counts }, advisories: { hidden: {} } }) },
  ])("rejects unavailable or contradictory registry evidence", (result) => {
    spawn.mockReturnValue(result); expect(() => queryRegistry("/fixture")).toThrow();
  });
  it("covers multiple batches exactly once and retains independent IDs", async () => {
    const all = Array.from({ length: 101 }, (_, index) => ({ name: "fixture", version: `1.0.${index}` }));
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const { queries } = JSON.parse(options!.body as string);
      return { ok: true, json: async () => ({ results: queries.map(() => ({ vulns: [{ id: "GHSA-fixture-a" }, { id: "GHSA-fixture-a" }] })) }) } as Response;
    });
    const result = await queryOsv(all);
    expect(result.rows).toEqual(all.map((pkg) => ({ ...pkg, ids: ["GHSA-fixture-a"] })));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(OSV_ENDPOINT, expect.objectContaining({ redirect: "error", method: "POST", signal: expect.any(AbortSignal) }));
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string).queries).toEqual([{ package: { name: "fixture", ecosystem: "npm" }, version: "1.0.100" }]);
  });
  it("accepts a complete empty result without inferring database freshness", async () => {
    expect(await queryOsv(packages)).toMatchObject({ rows: [{ ...packages[0], ids: [] }], database_updated_at: null });
  });
  it.each([
    { results: [] }, {}, { results: [null] }, { results: [[]] },
    { results: [{ next_page_token: "more", vulns: [] }] }, { results: [{ error: "unknown" }] },
    { results: [{ vulns: null }] }, { results: [{ vulns: "bad" }] }, { results: [{ vulns: [{}] }] }, { results: [{ vulns: [{ id: "private\nvalue" }] }] },
  ])("blocks partial, paginated or malformed OSV results", async (body) => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => body } as Response);
    await expect(queryOsv(packages)).rejects.toThrow();
  });
  it("blocks transport and HTTP failures", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network failure"));
    await expect(queryOsv(packages)).rejects.toThrow();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    await expect(queryOsv(packages)).rejects.toThrow("unavailable");
  });
});
