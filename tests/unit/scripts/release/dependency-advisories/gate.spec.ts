import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../../../helpers/temp.js";
import { main, runIfMain } from "../../../../../scripts/release/dependency-advisories/gate.mjs";
import { MAX_AGE_MS, verifyReceipt } from "../../../../../scripts/release/dependency-advisories/receipt.mjs";
import { resolveRepositoryQualityMeasurement, readRepositoryProviderEntries } from "../../../../../scripts/release/repository-assurance.mjs";
import { evaluateAssuranceAssertion } from "@unbrained/pm-cli/sdk/governance";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawnSync: spawn }));
type ReceiptFixture = {
  version: number; status: string; inputs: Record<string, string>; scope: string; started_at: string; completed_at: string;
  feeds: { osv: { observed_at: string; database_updated_at: string | null; endpoint: string; rows: { ids: string[] | null }[] }; registry: { counts: Record<string, number>; ids: string[]; advisories: unknown } };
};
/** Locate advisory evidence inside the disposable project rather than the source tracker. */
const receiptPath = (root: string) => path.join(root, ".cache/dependency-security/receipt.json");
/** Create the minimal complete dependency project consumed by the real collector. */
async function fixture(root: string) {
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n  'fixture@1.2.3':\n    resolution: {integrity: sha512-fixture}\n");
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "{}");
}
/** Alter saved evidence to prove the verifier rejects stale or incomplete receipts. */
async function mutate(root: string, change: (value: ReceiptFixture) => void) {
  const value = JSON.parse(await readFile(receiptPath(root), "utf8")); change(value);
  await writeFile(receiptPath(root), JSON.stringify(value));
}
beforeEach(() => {
  spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }) });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{}] }) }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("dependency advisory evidence", () => {
  it("blocks a zero registry audit with positive independent evidence and rejects missing, stale, incomplete or unavailable receipts", async () => {
    await withTempDir("pm-advisory-", async (root) => {
      await fixture(root);
      await expect(main([], root)).resolves.toMatchObject({ verdict: "pass", packages: 1, database_freshness: "unknown" });
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ vulns: [{ id: "GHSA-fixture-regression" }] }] }) } as Response);
      await expect(main([], root)).rejects.toThrow("blocked");
      const receipt = JSON.parse(await readFile(receiptPath(root), "utf8"));
      expect(receipt.status).toBe("complete");
      expect(receipt.feeds.registry.counts.high).toBe(0);
      expect(receipt.feeds.osv.rows[0].ids).toEqual(["GHSA-fixture-regression"]);
      await expect(main(["--verify-receipt"], root)).rejects.toThrow("Independent source");
    });
  });
  it("starts independent network deadlines only after the blocking registry audit settles", async () => {
    await withTempDir("pm-advisory-order-", async (root) => {
      await fixture(root);
      const order: string[] = [];
      spawn.mockImplementationOnce(() => {
        order.push("registry");
        return { status: 0, stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }) };
      });
      vi.mocked(fetch).mockImplementationOnce(async () => {
        order.push("osv");
        return { ok: true, json: async () => ({ results: [{}] }) } as Response;
      });
      await main([], root);
      expect(order).toEqual(["registry", "osv"]);
    });
  });
  it("records unavailable sources independently and never reuses an earlier clean receipt", async () => {
    await withTempDir("pm-advisory-", async (root) => {
      await fixture(root); await main([], root);
      vi.mocked(fetch).mockRejectedValueOnce(new Error("credential-like upstream detail must not escape"));
      await expect(main([], root)).rejects.toThrow("blocked");
      let receipt = JSON.parse(await readFile(receiptPath(root), "utf8"));
      expect(receipt.feeds.osv.status).toBe("unavailable"); expect(receipt.feeds.registry.status).toBe("complete");
      spawn.mockReturnValueOnce({ status: 2, stdout: "sensitive" });
      await expect(main([], root)).rejects.toThrow("blocked");
      receipt = JSON.parse(await readFile(receiptPath(root), "utf8"));
      expect(receipt.feeds.registry.status).toBe("unavailable"); expect(receipt.feeds.osv.status).toBe("complete");
      expect(JSON.stringify(receipt)).not.toContain("sensitive");
      await writeFile(path.join(root, "pnpm-lock.yaml"), "bad-lock");
      await expect(main([], root)).rejects.toThrow("blocked");
      expect(JSON.parse(await readFile(receiptPath(root), "utf8")).status).toBe("unavailable");
    });
  });
  it.each([
    (r: ReceiptFixture) => { r.version = 1; }, (r: ReceiptFixture) => { r.status = "collecting"; },
    (r: ReceiptFixture) => { r.inputs["package.json"] = "old"; }, (r: ReceiptFixture) => { r.scope = "production-only"; },
    (r: ReceiptFixture) => { r.started_at = new Date(Date.now() - MAX_AGE_MS - 1).toISOString(); },
    (r: ReceiptFixture) => { r.completed_at = "invalid"; }, (r: ReceiptFixture) => { r.started_at = new Date(Date.now() + 10000).toISOString(); },
    (r: ReceiptFixture) => { r.completed_at = new Date(Date.now() + 10000).toISOString(); },
    (r: ReceiptFixture) => { r.feeds.osv.observed_at = "invalid"; }, (r: ReceiptFixture) => { r.feeds.osv.database_updated_at = "unverified"; },
    (r: ReceiptFixture) => { r.feeds.osv.endpoint = "https://unknown.invalid"; }, (r: ReceiptFixture) => { r.feeds.osv.rows = []; },
    (r: ReceiptFixture) => { r.feeds.osv.rows[0].ids = null; }, (r: ReceiptFixture) => { r.feeds.registry.counts.info = 1; },
    (r: ReceiptFixture) => { r.feeds.registry.ids = ["hidden"]; },
    (r: ReceiptFixture) => { r.feeds.registry.advisories = undefined; },
    (r: ReceiptFixture) => { r.feeds.registry.advisories = [{ id: "hidden" }]; },
    (r: ReceiptFixture) => { r.feeds.osv.rows[0].ids = [7 as unknown as string]; },
    (r: ReceiptFixture) => { delete r.feeds.registry.counts.low; },
    (r: ReceiptFixture) => { r.feeds.registry.counts.low = -1; },
    (r: ReceiptFixture) => { r.feeds.registry.counts = null as unknown as Record<string, number>; },
  ])("rejects invalid evidence at the local-only provider boundary", async (change) => {
    await withTempDir("pm-advisory-", async (root) => {
      await fixture(root); await main([], root); await mutate(root, change);
      vi.mocked(fetch).mockClear();
      await expect(verifyReceipt(root, receiptPath(root))).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });
  });
  describe("recorded advisory waivers (pm-03q389)", () => {
    const zero = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    const advisory = "GHSA-abcd-efgh-ijkl";
    /** Report one high advisory for the fixture package from the registry feed. */
    const registryPositive = (details: Record<string, unknown> = {}) => spawn.mockReturnValue({
      status: 1,
      stdout: JSON.stringify({
        advisories: { "7": { module_name: "fixture", severity: "high", github_advisory_id: advisory, findings: [{ version: "1.2.3" }], ...details } },
        metadata: { vulnerabilities: { ...zero, high: 1 } },
      }),
    });
    /** Report the same advisory for the fixture package from the independent feed. */
    const osvPositive = (id = advisory) => vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ results: [{ vulns: [{ id }] }] }) } as Response);
    /** Declare waivers for the disposable project. */
    const declare = async (root: string, waivers: object[], extra: Record<string, unknown> = {}) => {
      await mkdir(path.join(root, "config"), { recursive: true });
      await writeFile(path.join(root, "config/dependency-advisory-waivers.json"), JSON.stringify({ version: 1, waiver_notice_days: 3, waivers, ...extra }));
      // An empty published runtime graph: the fixture package is development-only.
      await writeFile(path.join(root, "runtime-dependencies.json"), JSON.stringify({ packages: {} }));
    };
    const waiver = (overrides: Record<string, unknown> = {}) => ({
      advisory, package: "fixture", versions: ["1.2.3"], owner: "pm-fixture",
      reason: "No patched release exists for the fixture advisory.",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(), ...overrides,
    });

    it("passes an advisory both feeds report only while an exact live waiver covers it, and discloses it", async () => {
      await withTempDir("pm-advisory-waiver-", async (root) => {
        await fixture(root); registryPositive(); osvPositive();
        await expect(main([], root)).rejects.toThrow("Dependency advisory gate blocked: Independent source reports vulnerable dependencies: fixture@1.2.3 GHSA-abcd-efgh-ijkl;");
        const receipt = JSON.parse(await readFile(receiptPath(root), "utf8"));
        expect(receipt.feeds.registry.advisories).toEqual([{ id: "7", package: "fixture", severity: "high", advisory, versions: ["1.2.3"] }]);
        const covering = waiver();
        await declare(root, [covering, waiver({ package: "unused" })]);
        await expect(main([], root)).resolves.toMatchObject({
          verdict: "pass",
          waived: [{ advisory, package: "fixture", versions: ["1.2.3"], owner: "pm-fixture", expires_at: covering.expires_at, sources: ["osv", "registry"] }],
          unused_waivers: [`${advisory} in unused`],
        });
        await expect(main(["--verify-receipt"], root)).resolves.toMatchObject({ verdict: "pass" });
        await expect(main([], root)).resolves.toMatchObject({ waived: [{ sources: ["osv", "registry"] }] });
      });
    });

    it("blocks a report the waiver does not name exactly", async () => {
      await withTempDir("pm-advisory-waiver-", async (root) => {
        await fixture(root); await declare(root, [waiver()]);
        registryPositive(); osvPositive("GHSA-zzzz-zzzz-zzzz");
        await expect(main([], root)).rejects.toThrow("Independent source reports vulnerable dependencies: fixture@1.2.3 GHSA-zzzz-zzzz-zzzz");
        osvPositive();
        registryPositive({ github_advisory_id: undefined });
        await expect(main([], root)).rejects.toThrow("Registry reports vulnerable dependencies: fixture@1.2.3 7");
        registryPositive({ findings: [{ version: "1.2.3" }, { version: "unknown" }] });
        await expect(main([], root)).rejects.toThrow("Registry reports vulnerable dependencies: fixture@unknown version GHSA-abcd-efgh-ijkl");
        registryPositive({ module_name: "other" });
        await expect(main([], root)).rejects.toThrow("Registry reports vulnerable dependencies: other@1.2.3");
        await declare(root, [waiver({ versions: ["1.2.4"] })]);
        registryPositive();
        await expect(main([], root)).rejects.toThrow("Independent source reports vulnerable dependencies: fixture@1.2.3");
      });
    });

    it("refuses expired, over-long and malformed waivers even when nothing needs them", async () => {
      await withTempDir("pm-advisory-waiver-", async (root) => {
        await fixture(root);
        for (const waivers of [[waiver({ expires_at: new Date(Date.now() - 1000).toISOString() })], [waiver({ expires_at: new Date(Date.now() + 31 * 86_400_000).toISOString() })], [waiver({ owner: "" })]]) {
          await declare(root, waivers);
          await expect(main([], root)).rejects.toThrow("Dependency advisory gate blocked: Refused dependency advisory waiver:");
        }
        await declare(root, [], { waiver_notice_days: 31 });
        await expect(main(["--verify-receipt"], root)).rejects.toThrow("Refused dependency advisory waiver: config/dependency-advisory-waivers.json must hold exactly version 1");
        await writeFile(path.join(root, "config/dependency-advisory-waivers.json"), "{");
        await expect(main([], root)).rejects.toThrow(/^Dependency advisory gate blocked; inspect/u);
      });
    });

    it("refuses a waiver for a package the published runtime graph installs (pm-gh1748)", async () => {
      await withTempDir("pm-advisory-waiver-", async (root) => {
        await fixture(root); await declare(root, [waiver()]); registryPositive(); osvPositive();
        await expect(main([], root)).resolves.toMatchObject({ verdict: "pass" });
        const ledger = { packages: { "": { name: "root" }, "node_modules/other": { version: "1.2.3" }, "node_modules/parent/node_modules/fixture": { version: "1.2.3" } } };
        await writeFile(path.join(root, "runtime-dependencies.json"), JSON.stringify(ledger));
        await expect(main([], root)).rejects.toThrow(`Refused dependency advisory waiver: ${advisory} in fixture waiver covers fixture@1.2.3, which the published package installs (runtime-dependencies.json)`);
        await rm(path.join(root, "runtime-dependencies.json"));
        await expect(main([], root)).rejects.toThrow("Refused dependency advisory waiver: runtime-dependencies.json is missing");
      });
    });

    it("never prints unvalidated registry or receipt content in a refusal", async () => {
      await withTempDir("pm-advisory-waiver-", async (root) => {
        await fixture(root);
        spawn.mockReturnValue({
          status: 1,
          stdout: JSON.stringify({
            advisories: { "7": { module_name: "fixture", severity: "high", github_advisory_id: advisory, findings: [{ version: "1.2.3" }] } },
            metadata: { vulnerabilities: { ...zero, high: 1, "injected\u001b[2J-key": 0 } },
          }),
        });
        const failure = await main([], root).then(() => undefined, (error: Error) => error);
        expect(failure?.message).toMatch(/^Dependency advisory gate blocked: Incomplete registry audit counts; inspect/u);
        expect(failure?.message).not.toContain("injected");
        // Failures that are not verifier refusals stay generic.
        await writeFile(receiptPath(root), "{");
        await expect(main(["--verify-receipt"], root)).rejects.toThrow(SyntaxError);
      });
    });

    it("keeps registry counts and advisories mutually consistent", async () => {
      await withTempDir("pm-advisory-waiver-", async (root) => {
        await fixture(root); await declare(root, [waiver()]); registryPositive(); osvPositive();
        await main([], root);
        for (const change of [
          (r: ReceiptFixture) => { (r.feeds.registry.advisories as { severity: string }[])[0]!.severity = "low"; },
          (r: ReceiptFixture) => { r.feeds.registry.counts.critical = 1; },
          (r: ReceiptFixture) => { (r.feeds.registry.advisories as { versions: unknown }[])[0]!.versions = [7]; },
          (r: ReceiptFixture) => { (r.feeds.registry.advisories as { severity: string }[])[0]!.severity = "urgent"; },
        ]) {
          await main([], root); await mutate(root, change);
          await expect(verifyReceipt(root, receiptPath(root))).rejects.toThrow();
        }
        await main([], root);
        // An advisory of unknown severity leaves its count unaccounted for.
        await mutate(root, (r) => { (r.feeds.registry.advisories as { severity: null | string }[])[0]!.severity = null; });
        await expect(verifyReceipt(root, receiptPath(root))).rejects.toThrow("Registry lists an advisory of unknown severity");
        await main([], root);
        await mutate(root, (r) => { (r.feeds.registry.advisories as { versions: null | string[] }[])[0]!.versions = []; });
        await expect(verifyReceipt(root, receiptPath(root))).rejects.toThrow("Registry reports vulnerable dependencies: fixture@unknown version");
      });
    });

    it("refuses a registry count that the listed advisories do not account for, even when every listed one is waived", async () => {
      await withTempDir("pm-advisory-waiver-", async (root) => {
        await fixture(root); await declare(root, [waiver()]); osvPositive();
        // One waived high advisory with three vulnerable versions counts once.
        registryPositive({ findings: [{ version: "1.2.3" }, { version: "1.2.3" }] });
        await expect(main([], root)).resolves.toMatchObject({ verdict: "pass" });
        spawn.mockReturnValue({
          status: 1,
          stdout: JSON.stringify({
            advisories: { "7": { module_name: "fixture", severity: "high", github_advisory_id: advisory, findings: [{ version: "1.2.3" }] } },
            metadata: { vulnerabilities: { ...zero, high: 2 } },
          }),
        });
        await expect(main([], root)).rejects.toThrow("Dependency advisory gate blocked: Registry counts high advisories it does not list");
        // An unknown severity cannot be reconciled, even when every advisory is waived.
        await declare(root, [waiver(), waiver({ advisory: "GHSA-zzzz-zzzz-zzzz" })]);
        spawn.mockReturnValue({
          status: 1,
          stdout: JSON.stringify({
            advisories: {
              "7": { module_name: "fixture", severity: "high", github_advisory_id: advisory, findings: [{ version: "1.2.3" }] },
              "8": { module_name: "fixture", severity: "urgent", github_advisory_id: "GHSA-zzzz-zzzz-zzzz", findings: [{ version: "1.2.3" }] },
            },
            metadata: { vulnerabilities: { ...zero, high: 1 } },
          }),
        });
        await expect(main([], root)).rejects.toThrow("Dependency advisory gate blocked: Registry lists an advisory of unknown severity");
      });
    });
  });

  it("rejects missing receipts and unknown flags", async () => {
    await withTempDir("pm-advisory-", async (root) => {
      await expect(main(["--verify-receipt"], root)).rejects.toThrow();
      await expect(main(["--skip"], root)).rejects.toThrow("Usage");
      await expect(main(["--skip", "extra"], root)).rejects.toThrow("Usage");
    });
  });
  it("executes the provider through the existing public SDK assertion contract", async () => {
    const entries = await readRepositoryProviderEntries();
    const execute = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "incomplete advisory evidence" });
    const source = { kind: "provider", provider: "repository-quality", key: "dependency-advisories" } as const;
    const measurement = await resolveRepositoryQualityMeasurement(source, { entries, execute });
    expect(execute.mock.calls[0]![1]).toEqual([fileURLToPath(new URL("../../../../../scripts/release/dependency-advisories/gate.mjs", import.meta.url)), "--verify-receipt"]);
    const assertion = { id: "advisories-required", measurement_id: "advisories-pass", owner_item_id: "pm-fixture", scope: { kind: "all" }, equals: 1, lifetime: "hold", enforcement: "block", negative_control: { cases: [{ observed: 1, expected: "pass" }, { observed: 0, expected: "fail" }] } } as const;
    expect(evaluateAssuranceAssertion(assertion, { id: "advisories-pass", definition_fingerprint: "fixture", ...measurement, cost: { units: 1, items_scanned: 0, history_entries: 0, provider_calls: 1, duration_ms: 0 } }).verdict).toBe("fail");
  });
  it("preserves CLI output and status at both executable outcomes", async () => {
    await withTempDir("pm-advisory-entry-", async (root) => {
      await fixture(root); await main([], root);
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const candidate = fileURLToPath(new URL("../../../../../scripts/release/dependency-advisories/gate.mjs", import.meta.url));
      const originalExitCode = process.exitCode;
      try {
        await runIfMain(undefined, [], root);
        await runIfMain("another-script.mjs", [], root);
        expect(stdout).not.toHaveBeenCalled();
        await runIfMain(candidate, ["--verify-receipt"], root);
        expect(JSON.parse(String(stdout.mock.calls[0]![0])).verdict).toBe("pass");
        await runIfMain(candidate, ["--invalid"], root);
        expect(process.exitCode).toBe(1); expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage"));
      } finally { process.exitCode = originalExitCode; }
    });
  });
  it("returns portable CLI success and failure codes without network", async () => {
    await withTempDir("pm-advisory-cli-", async (root) => {
      await fixture(root); await main([], root);
      const directory = path.join(root, "scripts/release/dependency-advisories");
      await mkdir(directory, { recursive: true });
      await cp("scripts/release/dependency-advisories", directory, { recursive: true });
      await cp("scripts/release/utils.mjs", path.join(root, "scripts/release/utils.mjs"));
      // Resolve the existing dependency from the temporary script without installing.
      await mkdir(path.join(root, "node_modules"));
      await cp(path.dirname(fileURLToPath(import.meta.resolve("yaml/package.json"))), path.join(root, "node_modules/yaml"), { recursive: true });
      const script = path.join(directory, "gate.mjs");
      const alias = path.join(root, "linked-scripts");
      await symlink(path.join(root, "scripts"), alias, "junction");
      for (const entry of [script, path.join(alias, "release/dependency-advisories/gate.mjs")]) {
        for (const flags of [[], ["--preserve-symlinks-main"]]) {
          expect(JSON.parse(execFileSync(process.execPath, [...flags, entry, "--verify-receipt"], { encoding: "utf8" })).verdict).toBe("pass");
          expect(() => execFileSync(process.execPath, [...flags, entry, "--unknown"], { stdio: "pipe" })).toThrow();
        }
      }
    });
  });
});
