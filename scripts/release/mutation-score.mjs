/** Fail closed on missing, stale or untriaged mutation evidence. */
import { createHash } from "node:crypto";

/** Hash exact mutant identity without relying on tool-assigned sequential ids. */
export function mutationIdentity(filename, mutant) {
  return createHash("sha256").update(JSON.stringify([filename, mutant.mutatorName, mutant.location, mutant.replacement])).digest("hex");
}

/** Validate a complete Stryker report against immutable source bytes and reviewed equivalent-mutant waivers. */
export function assessMutationReport(report, policy, sources) {
  const failures = [];
  const files = Object.keys(report.files).sort();
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(sources).sort())) throw new Error("Mutation report scope does not match the declared source set");
  if (!Number.isFinite(policy.minimumScore) || policy.minimumScore < 0 || policy.minimumScore > 100) throw new Error("Invalid mutation score floor");
  const waivers = readEquivalentMutants(policy.equivalentMutants);
  let killed = 0;
  let total = 0;
  let equivalent = 0;
  const seen = new Set();
  for (const filename of files) {
    const result = assessFile(filename, report.files[filename], sources[filename], waivers, seen);
    killed += result.killed;
    total += result.total;
    equivalent += result.equivalent;
    failures.push(...result.failures);
  }
  for (const identity of waivers.keys()) if (!seen.has(identity)) failures.push(`remove absent waiver ${identity}`);
  const score = total === 0 ? 0 : killed * 100 / total;
  if (total === 0 || score < policy.minimumScore) failures.push(`mutation score ${score} below floor ${policy.minimumScore}`);
  return { total, killed, equivalent, score, failures };
}

/** Require explicit justification and ownership for each unique equivalent mutant. */
function readEquivalentMutants(entries) {
  const waivers = new Map();
  for (const waiver of entries) {
    if (!waiver.reason?.trim() || !waiver.owner?.trim() || !/^[a-f0-9]{64}$/u.test(waiver.identity) || waivers.has(waiver.identity)) throw new Error("Invalid or duplicate equivalent-mutant waiver");
    waivers.set(waiver.identity, waiver);
  }
  return waivers;
}

/** Assess one source file without treating timeout or compile failure as assertion strength. */
function assessFile(filename, file, source, waivers, seen) {
  if (file.source !== source || file.mutants.length === 0) throw new Error(`${filename}: stale source or missing mutants`);
  const result = { total: file.mutants.length, killed: 0, equivalent: 0, failures: [] };
  for (const mutant of file.mutants) {
    const identity = mutationIdentity(filename, mutant);
    if (seen.has(identity)) throw new Error(`${filename}: duplicate mutant`);
    seen.add(identity);
    if (mutant.status === "Killed") result.killed += 1;
    else if (mutant.status === "Survived" && waivers.has(identity)) result.equivalent += 1;
    else result.failures.push(`${filename}:${mutant.location.start.line}: ${mutant.status} ${identity}`);
    if (waivers.has(identity) && mutant.status !== "Survived") result.failures.push(`${filename}: remove stale waiver ${identity}`);
  }
  return result;
}
