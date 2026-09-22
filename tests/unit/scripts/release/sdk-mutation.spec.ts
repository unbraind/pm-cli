import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../../../scripts/release/sdk-mutation.mjs";

const mocked = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@stryker-mutator/core", () => ({ Stryker: class { runMutationTest = mocked.run; } }));
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); mocked.run.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Create a standalone source/report fixture whose tracker never resolves into this repository. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pm-mutation-policy-"));
  roots.push(root);
  mkdirSync(path.join(root, "scripts", "release"), { recursive: true });
  mkdirSync(path.join(root, "src"));
  const file = "src/a.ts";
  const source = "export const value = true;";
  writeFileSync(path.join(root, file), source);
  const policyPath = path.join(root, "scripts/release/sdk-mutation-baseline.json");
  const policy = { files: [file], minimumScore: 100, equivalentMutants: [] };
  writeFileSync(policyPath, JSON.stringify(policy));
  writeFileSync(path.join(root, "scripts/release/sdk-mutation.json"), JSON.stringify({ mutate: [file] }));
  const report = { files: { [file]: { source, mutants: [{ mutatorName: "BooleanLiteral", replacement: "false", location: { start: { line: 1, column: 22 }, end: { line: 1, column: 26 } }, status: "Killed" }] } } };
  vi.stubEnv("PM_MUTATION_TEMP_ROOT", root);
  vi.stubEnv("PM_PATH", path.join(root, "tracker"));
  vi.stubEnv("PM_GLOBAL_PATH", path.join(root, "global"));
  vi.stubEnv("PM_QUALITY_BASE_REF", "");
  const run = async (options: { jsonReporter: { fileName: string }; tempDirName: string }) => {
    expect(options.tempDirName).toBe(path.join(root, "sandbox"));
    expect(options).toMatchObject({ configFile: false, incremental: false, ignoreStatic: false, inPlace: false, mutator: { excludedMutations: [] } });
    writeFileSync(options.jsonReporter.fileName, JSON.stringify(report));
  };
  return { root, file, source, policy, policyPath, report, run };
}

describe("SDK mutation process policy", () => {
  it.each(["PM_MUTATION_TEMP_ROOT", "PM_PATH", "PM_GLOBAL_PATH"])("requires isolated %s", async (variable) => {
    vi.stubEnv(variable, "");
    await expect(main()).rejects.toThrow(/isolated/);
  });

  it("retains real receipts and rejects surviving mutants or stale source", async () => {
    const f = fixture();
    writeFileSync(path.join(f.root, "scripts/release/sdk-mutation.json"), JSON.stringify({ mutate: [f.file], configFile: "unchecked.json", incremental: true, ignoreStatic: true, inPlace: true, mutator: { excludedMutations: ["BooleanLiteral"] } }));
    expect(await main(f.root, f.run)).toMatchObject({ score: 100, killed: 1 });
    expect(JSON.parse(readFileSync(path.join(f.root, ".cache/mutation/receipt.json"), "utf8")).failures).toEqual([]);
    f.report.files[f.file].mutants[0].status = "Survived";
    await expect(main(f.root, f.run)).rejects.toThrow(/SDK mutation gate failed/);
    f.report.files[f.file].source = "old";
    await expect(main(f.root, f.run)).rejects.toThrow(/stale source/);
  });

  it("runs the installed engine by default and requires score improvements to raise the floor", async () => {
    const f = fixture();
    writeFileSync(path.join(f.root, "mutation-report.json"), JSON.stringify(f.report));
    mocked.run.mockResolvedValue([]);
    expect(await main(f.root)).toMatchObject({ score: 100 });
    expect(mocked.run).toHaveBeenCalledOnce();
    writeFileSync(f.policyPath, JSON.stringify({ ...f.policy, minimumScore: 90 }));
    await expect(main(f.root, f.run)).rejects.toThrow(/Raise mutation score floor/);
    expect(JSON.parse(readFileSync(path.join(f.root, ".cache/mutation/receipt.json"), "utf8")).failures).toEqual(["Raise mutation score floor to 100"]);
  });

  it("rejects scope drift and ignore directives", async () => {
    const f = fixture();
    writeFileSync(f.policyPath, JSON.stringify({ ...f.policy, files: [] }));
    await expect(main(f.root, f.run)).rejects.toThrow(/scope drift/);
    writeFileSync(f.policyPath, JSON.stringify(f.policy));
    writeFileSync(path.join(f.root, f.file), "// Stryker disable all\n" + f.source);
    await expect(main(f.root, f.run)).rejects.toThrow(/ignore directives/);
  });

  it("checks the reviewed Git baseline and forbids lowering score or removing a module", async () => {
    const f = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: f.root });
    execFileSync("git", ["add", "."], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "baseline"], { cwd: f.root });
    vi.stubEnv("PM_QUALITY_BASE_REF", "HEAD");
    expect(await main(f.root, f.run)).toMatchObject({ score: 100 });
    writeFileSync(f.policyPath, JSON.stringify({ ...f.policy, minimumScore: 90 }));
    await expect(main(f.root, f.run)).rejects.toThrow(/regressed/);
    writeFileSync(f.policyPath, JSON.stringify({ ...f.policy, files: [f.file, "src/old.ts"] }));
    execFileSync("git", ["add", "scripts/release/sdk-mutation-baseline.json"], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "expand"], { cwd: f.root });
    writeFileSync(f.policyPath, JSON.stringify(f.policy));
    await expect(main(f.root, f.run)).rejects.toThrow(/regressed/);
    execFileSync("git", ["rm", "--cached", "scripts/release/sdk-mutation-baseline.json"], { cwd: f.root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "remove"], { cwd: f.root });
    expect(await main(f.root, f.run)).toMatchObject({ score: 100 });
  });
});
