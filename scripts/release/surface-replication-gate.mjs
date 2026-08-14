#!/usr/bin/env node

/**
 * Enforce declarative replication sets and inventory CLI-owned refusals.
 *
 * Tracker: pm-7rrqsk and pm-0xmajx. The gate joins changeset recurrence with
 * the repository file-size cap so high-risk repeated surfaces remain visible.
 */
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { fail, parseFlags, repoRoot } from "./utils.mjs";

const DEFAULT_DECLARATION_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "surface-replication-sets.json",
);
const AST_PRINTER = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

function gitLines(args, root) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveDefaultBranchBase(root) {
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    try {
      const [base] = gitLines(["merge-base", "HEAD", candidate], root);
      if (base) return base;
    } catch {
      // Try the next locally available default-branch reference.
    }
  }
  return null;
}

function changedFilesFromGit(root) {
  const changed = new Set();
  const base = resolveDefaultBranchBase(root);
  if (base) {
    for (const file of gitLines(
      ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`],
      root,
    )) {
      changed.add(file);
    }
  }
  for (const args of [
    ["diff", "--name-only", "--diff-filter=ACMR"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    for (const file of gitLines(args, root)) changed.add(file);
  }
  if (!base && changed.size === 0) {
    throw new Error("Unable to resolve a base revision or worktree changes.");
  }
  return [...changed].sort();
}

function changedLinesFromGit(root, changedFiles) {
  const base = resolveDefaultBranchBase(root);
  const changedLines = {};
  for (const file of changedFiles) {
    const patches = [];
    for (const args of [
      ...(base === null
        ? []
        : [["diff", "--unified=0", `${base}...HEAD`, "--", file]]),
      ["diff", "--unified=0", "--", file],
      ["diff", "--cached", "--unified=0", "--", file],
    ]) {
      try {
        patches.push(
          execFileSync("git", args, {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }),
        );
      } catch {
        // Missing patches remain unknown and therefore activate scoped triggers.
      }
    }
    const lines = patches
      .join("\n")
      .split(/\r?\n/u)
      .filter(
        (line) =>
          (line.startsWith("+") && !line.startsWith("+++")) ||
          (line.startsWith("-") && !line.startsWith("---")),
      )
      .map((line) => line.slice(1));
    if (lines.length > 0) changedLines[file] = lines;
  }
  return changedLines;
}

async function collectTypeScriptFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return files;
    }
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(absolute)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolute);
    }
  }
  return files;
}

function functionName(node, sourceFile) {
  if (node.name === undefined) return null;
  return node.name.getText(sourceFile).trim();
}

/** Detect repeated named rule bodies so declarations have a measured denominator. */
export async function detectReplicatedRuleBodies(root, policy) {
  const minimumStatements = policy.minimum_statements;
  const clusters = new Map();
  for (const absolute of await collectTypeScriptFiles(path.join(root, "src"))) {
    const source = await readFile(absolute, "utf8");
    const sourceFile = ts.createSourceFile(
      absolute,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        node.body !== undefined &&
        ts.isBlock(node.body) &&
        node.body.statements.length >= minimumStatements
      ) {
        const name = functionName(node, sourceFile);
        if (name !== null) {
          const normalizedBody = AST_PRINTER.printNode(
            ts.EmitHint.Unspecified,
            node.body,
            sourceFile,
          )
            .replaceAll(/\s+/gu, " ")
            .trim();
          const key = `${name}\u0000${normalizedBody}`;
          const entries = clusters.get(key) ?? [];
          entries.push({
            path: path.relative(root, absolute).replaceAll(path.sep, "/"),
            name,
            line: source.slice(0, node.getStart(sourceFile)).split(/\r?\n/u)
              .length,
          });
          clusters.set(key, entries);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...clusters.values()]
    .filter(
      (entries) =>
        new Set(entries.map((entry) => entry.path)).size >=
        policy.minimum_distinct_files,
    )
    .map((entries) => ({
      name: entries[0].name,
      occurrences: entries.sort((left, right) =>
        left.path === right.path
          ? left.line - right.line
          : left.path.localeCompare(right.path),
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function isReplicationDetectionPolicy(policy) {
  if (typeof policy !== "object" || policy === null) return false;
  return [
    Number.isSafeInteger(policy.minimum_statements),
    policy.minimum_statements > 0,
    Number.isSafeInteger(policy.minimum_distinct_files),
    policy.minimum_distinct_files >= 2,
    Number.isSafeInteger(policy.minimum_detected_cluster_count),
    policy.minimum_detected_cluster_count >= 0,
    typeof policy.minimum_declared_coverage_ratio === "number",
    policy.minimum_declared_coverage_ratio >= 0,
    policy.minimum_declared_coverage_ratio <= 1,
  ].every(Boolean);
}

async function replicationDenominator(config, root) {
  const policy = config.replication_detection;
  if (policy === undefined) return null;
  if (!isReplicationDetectionPolicy(policy)) {
    return { violations: ["replication_detection:invalid"] };
  }
  const clusters = await detectReplicatedRuleBodies(root, policy);
  const declaredSets = config.sets.map(
    (set) =>
      new Set(
        Array.isArray(set?.members)
          ? set.members.flatMap((member) =>
              typeof member?.path === "string" ? [member.path] : [],
            )
          : [],
      ),
  );
  const declaredClusterCount = clusters.filter((cluster) =>
    declaredSets.some((declaredPaths) =>
      cluster.occurrences.every((entry) => declaredPaths.has(entry.path)),
    ),
  ).length;
  const coverageRatio =
    clusters.length === 0 ? 1 : declaredClusterCount / clusters.length;
  const violations = [];
  if (clusters.length < policy.minimum_detected_cluster_count) {
    violations.push(
      `replication_detection:cluster_floor:${clusters.length}:${policy.minimum_detected_cluster_count}`,
    );
  }
  if (coverageRatio < policy.minimum_declared_coverage_ratio) {
    violations.push(
      `replication_detection:declared_coverage:${coverageRatio.toFixed(4)}:${policy.minimum_declared_coverage_ratio.toFixed(4)}`,
    );
  }
  return {
    detected_cluster_count: clusters.length,
    declared_cluster_count: declaredClusterCount,
    declared_coverage_ratio: Number(coverageRatio.toFixed(4)),
    clusters,
    violations,
  };
}

function validateMemberShape(member, label, violations) {
  if (
    typeof member !== "object" ||
    member === null ||
    typeof member.path !== "string" ||
    !Array.isArray(member.contains_all) ||
    member.contains_all.length === 0 ||
    member.contains_all.some(
      (pattern) => typeof pattern !== "string" || pattern.length === 0,
    )
  ) {
    violations.push(`${label}:invalid_member`);
    return false;
  }
  return true;
}

function isTriggerDeclaration(trigger) {
  return (
    (typeof trigger === "string" && trigger.length > 0) ||
    (typeof trigger === "object" &&
      trigger !== null &&
      typeof trigger.path === "string" &&
      trigger.path.length > 0 &&
      Array.isArray(trigger.changed_lines_contain_any) &&
      trigger.changed_lines_contain_any.length > 0 &&
      trigger.changed_lines_contain_any.every(
        (pattern) => typeof pattern === "string" && pattern.length > 0,
      ))
  );
}

function isReplicationSetDeclaration(set) {
  return (
    typeof set === "object" &&
    set !== null &&
    typeof set.id === "string" &&
    /^pm-[a-z0-9]+$/u.test(set.owner ?? "") &&
    Array.isArray(set.triggers) &&
    set.triggers.length > 0 &&
    set.triggers.every(isTriggerDeclaration) &&
    Array.isArray(set.members) &&
    set.members.length > 0
  );
}

function triggerActivates(trigger, changedFiles, changedLines) {
  const triggerPath = typeof trigger === "string" ? trigger : trigger.path;
  if (!changedFiles.includes(triggerPath)) return false;
  if (typeof trigger === "string") return true;
  const lines = changedLines[triggerPath];
  if (lines === undefined) return true;
  return trigger.changed_lines_contain_any.some((pattern) =>
    lines.some((line) => line.includes(pattern)),
  );
}

function normalizeReplicationSet(set) {
  if (!isReplicationSetDeclaration(set)) {
    return { set: null, violation: "set:invalid" };
  }
  const memberPaths = new Set(
    set.members.flatMap((member) =>
      typeof member === "object" &&
      member !== null &&
      typeof member.path === "string"
        ? [member.path]
        : [],
    ),
  );
  const requiredChangedMembers = set.required_changed_members;
  if (
    !Array.isArray(requiredChangedMembers) ||
    requiredChangedMembers.length === 0 ||
    requiredChangedMembers.some(
      (memberPath) =>
        typeof memberPath !== "string" ||
        memberPath.length === 0 ||
        !memberPaths.has(memberPath),
    )
  ) {
    return {
      set,
      memberPaths,
      requiredPaths: [],
      violation: `set:${set.id}:invalid_required_changed_members`,
    };
  }
  return {
    set,
    memberPaths,
    requiredPaths: requiredChangedMembers,
    violation: null,
  };
}

function activeWaiver(config, setId, memberPath, today) {
  return (config.waivers ?? []).find(
    (waiver) =>
      waiver.set_id === setId &&
      waiver.member_path === memberPath &&
      typeof waiver.reason === "string" &&
      /^pm-[a-z0-9]+$/u.test(waiver.pm_item ?? "") &&
      typeof waiver.expires_on === "string" &&
      /^\d{4}-\d{2}-\d{2}$/u.test(waiver.expires_on) &&
      !Number.isNaN(Date.parse(`${waiver.expires_on}T00:00:00.000Z`)) &&
      new Date(`${waiver.expires_on}T00:00:00.000Z`)
        .toISOString()
        .slice(0, 10) === waiver.expires_on &&
      waiver.expires_on >= today,
  );
}

async function validateMembers(config, setId, members, root, today) {
  const violations = [];
  const waivers = [];
  const sizes = [];
  for (const member of members) {
    if (!validateMemberShape(member, `set:${setId}`, violations)) continue;
    let source;
    try {
      source = await readFile(path.join(root, member.path), "utf8");
    } catch {
      source = null;
    }
    const missing =
      source === null
        ? ["<file>"]
        : member.contains_all.filter((pattern) => !source.includes(pattern));
    if (source !== null && member.path.startsWith("src/")) {
      sizes.push({
        path: member.path,
        implementation_lines: source.split(/\r?\n/u).filter((line) => {
          const trimmed = line.trim();
          return (
            trimmed.length > 0 &&
            !trimmed.startsWith("//") &&
            !trimmed.startsWith("/*") &&
            !trimmed.startsWith("*") &&
            !trimmed.startsWith("*/")
          );
        }).length,
      });
    }
    if (missing.length === 0) continue;
    const waiver = activeWaiver(config, setId, member.path, today);
    if (waiver) {
      waivers.push({ set_id: setId, member_path: member.path, ...waiver });
      continue;
    }
    violations.push(
      `set:${setId}:member:${member.path}:missing:${missing.join("|")}`,
    );
  }
  return { violations, waivers, sizes };
}

async function refusalInventory(config, root) {
  const declared = new Map(
    (config.cli_refusal_dispositions ?? []).map((entry) => [entry.path, entry]),
  );
  const actual = [];
  for (const absolute of await collectTypeScriptFiles(
    path.join(root, "src", "cli"),
  )) {
    const source = await readFile(absolute, "utf8");
    const matches = [...source.matchAll(/new\s+PmCliError\s*\(/gu)];
    const count = matches.length;
    if (count > 0) {
      const relativePath = path
        .relative(root, absolute)
        .replaceAll(path.sep, "/");
      actual.push({
        path: relativePath,
        count,
        rules: matches.map((match, index) => ({
          id: `${relativePath}#${index + 1}`,
          line: source.slice(0, match.index).split(/\r?\n/u).length,
        })),
      });
    }
  }
  actual.sort((left, right) => left.path.localeCompare(right.path));
  const violations = [];
  for (const entry of actual) {
    const disposition = declared.get(entry.path);
    if (!disposition) {
      violations.push(
        `cli_refusal:${entry.path}:undispositioned:${entry.count}`,
      );
      continue;
    }
    if (
      disposition.expected_count !== entry.count ||
      disposition.rule_ownership !== "all_occurrences" ||
      typeof disposition.reason !== "string" ||
      disposition.reason.trim().length < 20
    ) {
      violations.push(
        `cli_refusal:${entry.path}:expected_${disposition.expected_count}:actual_${entry.count}`,
      );
    }
    entry.rules = entry.rules.map((rule) => ({
      ...rule,
      disposition: disposition.disposition,
      owner: disposition.owner,
    }));
    declared.delete(entry.path);
  }
  for (const stale of declared.keys()) {
    violations.push(`cli_refusal:${stale}:stale_disposition`);
  }
  return {
    violations,
    files: actual,
    total: actual.reduce((sum, entry) => sum + entry.count, 0),
  };
}

async function validateActiveSets(
  config,
  changedFiles,
  changedLines,
  root,
  today,
) {
  const reports = [];
  const violations = [];
  const waivers = [];
  for (const candidate of config.sets) {
    const normalized = normalizeReplicationSet(candidate);
    if (normalized.violation !== null) {
      violations.push(normalized.violation);
    }
    if (normalized.set === null) continue;
    const { memberPaths, requiredPaths, set } = normalized;
    if (
      !set.triggers.some((trigger) =>
        triggerActivates(trigger, changedFiles, changedLines),
      )
    ) {
      continue;
    }
    for (const memberPath of requiredPaths) {
      if (changedFiles.includes(memberPath)) continue;
      const waiver = activeWaiver(config, set.id, memberPath, today);
      if (waiver) {
        waivers.push({ set_id: set.id, member_path: memberPath, ...waiver });
      } else {
        violations.push(`set:${set.id}:member:${memberPath}:unchanged`);
      }
    }
    const changedMembers = changedFiles.filter((file) => memberPaths.has(file));
    const memberResult = await validateMembers(
      config,
      set.id,
      set.members,
      root,
      today,
    );
    violations.push(...memberResult.violations);
    waivers.push(...memberResult.waivers);
    const largest = memberResult.sizes.sort(
      (left, right) => right.implementation_lines - left.implementation_lines,
    )[0] ?? { path: null, implementation_lines: 0 };
    reports.push({
      id: set.id,
      owner: set.owner,
      changed_member_count: changedMembers.length,
      declared_member_count: set.members.length,
      recurrence_density: Number(
        (changedMembers.length / set.members.length).toFixed(4),
      ),
      largest_source: largest.path,
      largest_source_implementation_lines: largest.implementation_lines,
      source_cap_utilization: Number(
        (largest.implementation_lines / config.source_file_line_cap).toFixed(4),
      ),
    });
  }
  return { reports, violations, waivers };
}

/** Validate all active replication sets, refusal parity contracts, and dispositions. */
export async function validateSurfaceReplication(config, options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const changedFiles = options.changedFiles ?? changedFilesFromGit(root);
  const changedLines =
    options.changedLines ??
    (options.changedFiles === undefined
      ? changedLinesFromGit(root, changedFiles)
      : {});
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const violations = [];
  if (
    config.version !== 1 ||
    !Array.isArray(config.sets) ||
    !Number.isSafeInteger(config.source_file_line_cap) ||
    config.source_file_line_cap <= 0
  ) {
    return {
      ok: false,
      violations: ["declaration:invalid"],
      changed_files: changedFiles,
    };
  }
  const activeSets = await validateActiveSets(
    config,
    changedFiles,
    changedLines,
    root,
    today,
  );
  violations.push(...activeSets.violations);
  const appliedWaivers = [...activeSets.waivers];
  for (const contract of config.refusal_parity_contracts ?? []) {
    const result = await validateMembers(
      config,
      `refusal:${contract.id}`,
      contract.members ?? [],
      root,
      today,
    );
    violations.push(...result.violations);
    appliedWaivers.push(...result.waivers);
  }
  const refusals = await refusalInventory(config, root);
  violations.push(...refusals.violations);
  const denominator = await replicationDenominator(config, root);
  violations.push(...(denominator?.violations ?? []));
  const reports = activeSets.reports;
  reports.sort(
    (left, right) =>
      right.recurrence_density * right.source_cap_utilization -
      left.recurrence_density * left.source_cap_utilization,
  );
  return {
    ok: violations.length === 0,
    changed_files: changedFiles,
    active_sets: reports,
    recurrence_size_candidates: reports,
    cli_owned_refusals: refusals,
    replication_detection: denominator,
    applied_waivers: [
      ...new Map(
        appliedWaivers.map((waiver) => [
          [
            waiver.set_id,
            waiver.member_path,
            waiver.pm_item,
            waiver.expires_on,
          ].join(":"),
          waiver,
        ]),
      ).values(),
    ],
    violations: violations.sort(),
  };
}

/** Load the declaration, support waiver inventory, and run the gate. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const { flags } = parseFlags(argv);
  const declaration = flags.get("declaration");
  const declarationPath =
    declaration === undefined || declaration === true
      ? DEFAULT_DECLARATION_PATH
      : path.resolve(String(declaration));
  const config = JSON.parse(await readFile(declarationPath, "utf8"));
  if (flags.has("list-waivers")) {
    return { waivers: config.waivers ?? [] };
  }
  const explicitChanged = flags.get("changed-files");
  const result = await validateSurfaceReplication(config, {
    repoRoot: options.repoRoot,
    changedFiles:
      explicitChanged === undefined
        ? undefined
        : explicitChanged === true
          ? []
          : String(explicitChanged)
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
  });
  if (!result.ok) {
    throw new Error(
      `Surface replication gate failed:\n${result.violations.join("\n")}`,
    );
  }
  return result;
}

/** Execute the gate only when this module is the process entrypoint. */
export async function runSurfaceReplicationEntrypoint(options = {}) {
  const argv = options.argv ?? process.argv;
  if (
    argv[1] === undefined ||
    fileURLToPath(import.meta.url) !== path.resolve(argv[1])
  ) {
    return false;
  }
  try {
    const result = await (options.run ?? main)(argv.slice(2));
    (options.write ?? ((output) => process.stdout.write(output)))(
      `${JSON.stringify(result, null, 2)}\n`,
    );
    return true;
  } catch (error) {
    (options.onError ?? ((cause) => fail(String(cause))))(error);
    return false;
  }
}

void runSurfaceReplicationEntrypoint();
