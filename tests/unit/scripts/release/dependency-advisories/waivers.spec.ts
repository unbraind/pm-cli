import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../../../helpers/temp.js";
import {
  applyWaivers,
  describeReport,
  evaluateWaivers,
  MAX_WAIVER_DAYS,
  MAX_WAIVERS,
  judgeWaivers,
  readRuntimePackages,
  readWaiverRegistry,
  runtimeFindings,
  RUNTIME_LEDGER_PATH,
  WAIVERS_PATH,
} from "../../../../../scripts/release/dependency-advisories/waivers.mjs";

const now = Date.parse("2026-11-17T12:00:00.000Z");
const waiver = {
  advisory: "GHSA-fc5q-39xc-vjpf",
  package: "picomatch",
  versions: ["4.0.7"],
  owner: "pm-03q389",
  reason: "No patched release exists for this advisory yet.",
  expires_at: "2026-12-01T00:00:00Z",
};
/** Wrap waivers in a valid version 1 registry envelope. */
const registry = (waivers: unknown[], noticeDays = 3) => ({ version: 1, waiver_notice_days: noticeDays, waivers });

describe("dependency advisory waiver registry", () => {
  it("accepts a well-formed waiver inside the bounded lifetime", () => {
    expect(evaluateWaivers(registry([waiver]), now)).toEqual({ live: [waiver], notice_days: 3, findings: [] });
    expect(evaluateWaivers(registry([{ ...waiver, package: "@scope/name", expires_at: "2026-11-18T00:00:00.123Z" }], 0), now).findings).toEqual([]);
  });

  it.each([
    null, [], "registry", { version: 2, waiver_notice_days: 3, waivers: [] }, { version: 1, waivers: [] },
    { version: 1, waiver_notice_days: -1, waivers: [] }, { version: 1, waiver_notice_days: 1.5, waivers: [] },
    { version: 1, waiver_notice_days: MAX_WAIVER_DAYS + 1, waivers: [] }, { version: 1, waiver_notice_days: 3, waivers: {} },
    { version: 1, waiver_notice_days: 3, waivers: Array.from({ length: MAX_WAIVERS + 1 }, () => waiver) },
    { version: 1, waiver_notice_days: 3, waivers: [], extra: true },
  ])("refuses a malformed registry envelope: %j", (value) => {
    expect(evaluateWaivers(value, now)).toMatchObject({ live: [], notice_days: 0, findings: [{ kind: "invalid_registry" }] });
  });

  it.each([
    null, "waiver", { ...waiver, extra: true }, { ...waiver, advisory: "CVE-2026-112366" }, { ...waiver, advisory: "MAL-2026-1" },
    { ...waiver, package: "Bad Name" }, { ...waiver, package: 7 }, { ...waiver, versions: [] }, { ...waiver, versions: "4.0.7" },
    { ...waiver, versions: ["^4.0.7"] }, { ...waiver, versions: ["4.0.7", "4.0.7"] },
    { ...waiver, versions: Array.from({ length: 21 }, (_, index) => `4.0.${index}`) }, { ...waiver, owner: "owner" },
    { ...waiver, owner: "pm-has-hyphens" }, { ...waiver, reason: "too short" }, { ...waiver, reason: "x".repeat(2001) },
    { ...waiver, reason: 3 }, { ...waiver, expires_at: "2026-12-01" }, { ...waiver, expires_at: "2026-12-01T00:00:00+01:00" },
    { ...waiver, expires_at: "2026-02-30T00:00:00Z" }, { ...waiver, expires_at: 1 },
  ])("refuses a malformed waiver without echoing it: %j", (value) => {
    const { live, findings } = evaluateWaivers(registry([value]), now);
    expect(live).toEqual([]);
    expect(findings).toEqual([{ kind: "invalid_waiver", detail: expect.stringContaining(`Waiver 0 in ${WAIVERS_PATH}`) }]);
  });

  it("refuses duplicate, expired and over-long waivers while keeping the live ones", () => {
    const other = { ...waiver, advisory: "GHSA-aaaa-bbbb-cccc" };
    const result = evaluateWaivers(registry([
      waiver,
      { ...waiver, versions: ["4.0.6"] },
      { ...other, expires_at: "2026-11-17T12:00:00Z" },
      { ...other, package: "later", expires_at: new Date(now + MAX_WAIVER_DAYS * 86_400_000 + 1000).toISOString() },
      { ...other, package: "edge", expires_at: new Date(now + MAX_WAIVER_DAYS * 86_400_000).toISOString() },
    ]), now);
    expect(result.live.map(({ package: name }) => name)).toEqual(["picomatch", "edge"]);
    expect(result.findings).toEqual([
      { kind: "duplicate_waiver", subject_id: "GHSA-fc5q-39xc-vjpf in picomatch", detail: "GHSA-fc5q-39xc-vjpf in picomatch is waived more than once." },
      { kind: "expired_waiver", subject_id: "GHSA-aaaa-bbbb-cccc in picomatch", detail: expect.stringContaining("expired at 2026-11-17T12:00:00Z") },
      { kind: "waiver_too_long", subject_id: "GHSA-aaaa-bbbb-cccc in later", detail: expect.stringContaining(`past ${MAX_WAIVER_DAYS} days`) },
    ]);
  });
});

describe("dependency advisory waiver matching", () => {
  it("covers only an exact advisory, package and locked version and reports each source once", () => {
    const reports = [
      { source: "registry", id: "1247710", package: "picomatch", version: "4.0.7", advisory: "GHSA-fc5q-39xc-vjpf" },
      { source: "osv", package: "picomatch", version: "4.0.7", advisory: "GHSA-fc5q-39xc-vjpf" },
      { source: "osv", package: "picomatch", version: "4.0.7", advisory: "GHSA-fc5q-39xc-vjpf" },
      { source: "osv", package: "picomatch", version: "4.0.8", advisory: "GHSA-fc5q-39xc-vjpf" },
      { source: "osv", package: "minimatch", version: "4.0.7", advisory: "GHSA-fc5q-39xc-vjpf" },
      { source: "osv", package: "picomatch", version: "4.0.7", advisory: "GHSA-aaaa-bbbb-cccc" },
      { source: "registry", id: "9", package: null, version: null, advisory: null },
    ];
    const unused = { ...waiver, package: "unused" };
    const { open, waived, unused: idle } = applyWaivers(reports, [waiver, unused]);
    expect(open).toEqual(reports.slice(3));
    expect(waived).toEqual([{ advisory: waiver.advisory, package: "picomatch", versions: ["4.0.7"], owner: "pm-03q389", expires_at: waiver.expires_at, sources: ["osv", "registry"] }]);
    expect(idle).toEqual(["GHSA-fc5q-39xc-vjpf in unused"]);
    expect(applyWaivers(reports, []).open).toEqual(reports);
  });

  it("spells uncovered reports from validated fields with explicit unknowns", () => {
    expect(describeReport({ package: "picomatch", version: "4.0.7", advisory: "GHSA-fc5q-39xc-vjpf" })).toBe("picomatch@4.0.7 GHSA-fc5q-39xc-vjpf");
    expect(describeReport({ package: null, version: null, advisory: null, id: "9" })).toBe("unknown package@unknown version 9");
    expect(describeReport({ package: null, version: null, advisory: null })).toBe("unknown package@unknown version unknown advisory");
    // An unvalidated registry key is never printed.
    expect(describeReport({ package: null, version: null, advisory: null, id: "9\u001b[2Jinjected" })).toBe("unknown package@unknown version unknown advisory");
  });
});

describe("dependency advisory waiver file", () => {
  it("declares no waivers when the file is absent and refuses unreadable or malformed files", async () => {
    await withTempDir("pm-advisory-waivers-", async (root) => {
      await expect(readWaiverRegistry(root)).resolves.toEqual({ version: 1, waiver_notice_days: 0, waivers: [] });
      await mkdir(path.join(root, WAIVERS_PATH), { recursive: true });
      await expect(readWaiverRegistry(root)).rejects.toThrow();
    });
    await withTempDir("pm-advisory-waivers-", async (root) => {
      await mkdir(path.join(root, "config"));
      await writeFile(path.join(root, WAIVERS_PATH), "{");
      await expect(readWaiverRegistry(root)).rejects.toThrow(SyntaxError);
      await writeFile(path.join(root, WAIVERS_PATH), JSON.stringify(registry([waiver])));
      await expect(readWaiverRegistry(root)).resolves.toEqual(registry([waiver]));
    });
  });

  it("reads the published runtime graph and refuses a waiver that covers any of it", async () => {
    await withTempDir("pm-advisory-runtime-", async (root) => {
      await expect(readRuntimePackages(root)).resolves.toBeUndefined();
      // Without a ledger, a live waiver cannot be shown clear of the runtime graph.
      expect(runtimeFindings([], undefined)).toEqual([]);
      expect(runtimeFindings([waiver], undefined)).toEqual([{ kind: "runtime_ledger_missing", detail: expect.stringContaining("runtime-dependencies.json is missing") }]);
      await mkdir(path.join(root, "config"));
      await writeFile(path.join(root, WAIVERS_PATH), JSON.stringify(registry([waiver])));
      await expect(judgeWaivers(root, now)).resolves.toMatchObject({ findings: [{ kind: "runtime_ledger_missing" }] });
      await writeFile(path.join(root, RUNTIME_LEDGER_PATH), JSON.stringify({ packages: {
        "": { name: "root", version: "1.0.0" },
        "node_modules/picomatch": { version: "4.0.7" },
        "node_modules/a/node_modules/@scope/b": { version: "2.0.0" },
        "node_modules/linked": { resolved: "link" },
      } }));
      const runtime = await readRuntimePackages(root);
      expect(runtime).toEqual(new Set(["picomatch@4.0.7", "@scope/b@2.0.0"]));
      expect(runtimeFindings([waiver, { ...waiver, package: "other" }], runtime)).toEqual([
        { kind: "waiver_covers_runtime_dependency", subject_id: "GHSA-fc5q-39xc-vjpf in picomatch", detail: expect.stringContaining("covers picomatch@4.0.7, which the published package installs") },
      ]);
      await expect(judgeWaivers(root, now)).resolves.toMatchObject({ live: [waiver], findings: [{ kind: "waiver_covers_runtime_dependency" }] });
      await writeFile(path.join(root, RUNTIME_LEDGER_PATH), "{");
      await expect(readRuntimePackages(root)).rejects.toThrow(SyntaxError);
    });
    await withTempDir("pm-advisory-runtime-", async (root) => {
      await mkdir(path.join(root, RUNTIME_LEDGER_PATH));
      await expect(readRuntimePackages(root)).rejects.toThrow();
    });
  });

  it("keeps the repository's declared waivers clear of the published runtime graph", async () => {
    const declared = await readWaiverRegistry(process.cwd());
    const live = declared.waivers.filter((entry: { expires_at: string }) => evaluateWaivers({ ...declared, waivers: [entry] }, Date.parse(entry.expires_at) - 3_600_000).findings.length === 0);
    const runtime = await readRuntimePackages(process.cwd());
    expect(runtime?.size).toBeGreaterThan(0);
    expect(runtimeFindings(live, runtime)).toEqual([]);
  });

  it("keeps the repository's declared waivers well formed independent of the run date", async () => {
    // Expiry against the real clock is the advisory gate's job; judge each
    // declared waiver an hour before its own expiry so this never ages out.
    const declared = await readWaiverRegistry(process.cwd());
    expect(evaluateWaivers({ ...declared, waivers: [] }, now).findings).toEqual([]);
    for (const entry of declared.waivers) {
      expect(evaluateWaivers({ ...declared, waivers: [entry] }, Date.parse(entry.expires_at) - 3_600_000).findings).toEqual([]);
    }
  });
});
