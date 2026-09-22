/** Run a bounded SDK mutation partition inside the test runner's isolated workspace. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Stryker } from "@stryker-mutator/core";
import { assessMutationReport } from "./mutation-score.mjs";

/** Execute every mutant, then enforce source freshness, a score floor and explicit survivor ownership. */
export async function main(root = process.cwd(), run = (options) => new Stryker(options).runMutationTest()) {
  const scratch = process.env.PM_MUTATION_TEMP_ROOT;
  if (!scratch || !process.env.PM_PATH || !process.env.PM_GLOBAL_PATH) throw new Error("Use node scripts/run-tests.mjs mutation for isolated execution");
  const config = JSON.parse(readFileSync(path.join(root, "scripts/release/sdk-mutation.json"), "utf8"));
  const policy = JSON.parse(readFileSync(path.join(root, "scripts/release/sdk-mutation-baseline.json"), "utf8"));
  const declaredFiles = [...config.mutate].sort();
  if (JSON.stringify(declaredFiles) !== JSON.stringify(policy.files)) throw new Error("Mutation policy scope drift");
  if (process.env.PM_QUALITY_BASE_REF) {
    const baselinePath = "scripts/release/sdk-mutation-baseline.json";
    const listed = execFileSync("git", ["ls-tree", "--name-only", process.env.PM_QUALITY_BASE_REF, "--", baselinePath], { cwd: root, encoding: "utf8" });
    if (listed.trim()) {
      const previous = JSON.parse(execFileSync("git", ["show", `${process.env.PM_QUALITY_BASE_REF}:${baselinePath}`], { cwd: root, encoding: "utf8" }));
      if (policy.minimumScore < previous.minimumScore || previous.files.some((file) => !declaredFiles.includes(file))) throw new Error("Mutation score floor or source scope regressed");
    }
  }
  const reportPath = path.join(scratch, "mutation-report.json");
  const sources = Object.fromEntries(config.mutate.map((filename) => [filename, readFileSync(path.join(root, filename), "utf8")]));
  if (Object.values(sources).some((source) => /Stryker disable/u.test(source))) throw new Error("Mutation ignore directives are forbidden in the declared source set");
  await run({
    ...config,
    configFile: false, incremental: false, ignoreStatic: false, inPlace: false,
    mutator: { excludedMutations: [] },
    tempDirName: path.join(scratch, "sandbox"), jsonReporter: { fileName: reportPath },
  });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const receipt = assessMutationReport(report, policy, sources);
  if (receipt.score > policy.minimumScore) receipt.failures.push(`Raise mutation score floor to ${receipt.score}`);
  const output = path.join(root, ".cache", "mutation");
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report));
  writeFileSync(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.failures.length > 0) throw new Error(`SDK mutation gate failed:\n${receipt.failures.join("\n")}`);
  return receipt;
}
