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
import { fail, parseFlags, repoRoot } from "./utils.mjs";

const DEFAULT_DECLARATION_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "surface-replication-sets.json",
);

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

function changedFilesFromGit(root) {
  const changed = new Set();
  let base = null;
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    try {
      [base] = gitLines(["merge-base", "HEAD", candidate], root);
      if (base) break;
    } catch {
      // Try the next locally available default-branch reference.
    }
  }
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
  ]) {
    for (const file of gitLines(args, root)) changed.add(file);
  }
  if (!base && changed.size === 0) {
    throw new Error("Unable to resolve a base revision or worktree changes.");
  }
  return [...changed].sort();
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

function isReplicationSetDeclaration(set) {
  return (
    typeof set === "object" &&
    set !== null &&
    typeof set.id === "string" &&
    /^pm-[a-z0-9]+$/u.test(set.owner ?? "") &&
    Array.isArray(set.triggers) &&
    set.triggers.length > 0 &&
    set.triggers.every(
      (trigger) => typeof trigger === "string" && trigger.length > 0,
    ) &&
    Array.isArray(set.members) &&
    set.members.length > 0
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
    const count = source.match(/new\s+PmCliError\s*\(/gu)?.length ?? 0;
    if (count > 0) {
      actual.push({
        path: path.relative(root, absolute).replaceAll(path.sep, "/"),
        count,
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
      typeof disposition.reason !== "string" ||
      disposition.reason.trim().length < 20
    ) {
      violations.push(
        `cli_refusal:${entry.path}:expected_${disposition.expected_count}:actual_${entry.count}`,
      );
    }
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

async function validateActiveSets(config, changedFiles, root, today) {
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
      !changedFiles.some(
        (file) => set.triggers.includes(file) || requiredPaths.includes(file),
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
