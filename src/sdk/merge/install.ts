/**
 * @module sdk/merge/install
 *
 * Installs the tracker's git merge configuration into a repository: a fenced
 * `.gitattributes` block mapping every mergeable tracker artifact class to a
 * pm merge driver, plus the local `git config` driver definitions that make
 * those attributes effective. Idempotent and re-runnable — rerun after adding
 * custom item types so the per-type-folder patterns stay complete.
 */
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";

const execFileAsync = promisify(execFile);

/** Opening marker for the pm-owned merge-driver `.gitattributes` block. */
export const PM_GITATTRIBUTES_START = "# pm-cli:merge-drivers:start";
/** Closing marker for the pm-owned merge-driver `.gitattributes` block. */
export const PM_GITATTRIBUTES_END = "# pm-cli:merge-drivers:end";

const MERGE_DRIVER_DEFINITIONS = [
  {
    key: "pm-item",
    name: "pm field-aware item document merge",
    artifact: "item",
  },
  {
    key: "pm-history",
    name: "pm append-only history stream merge",
    artifact: "history",
  },
  {
    key: "pm-json",
    name: "pm key-level JSON config merge",
    artifact: "json",
  },
] as const;

/** Documents the merge install options payload exchanged by command, SDK, and package integrations. */
export interface MergeInstallOptions {
  /** Preview the `.gitattributes` and `git config` changes without writing anything. */
  dryRun?: boolean;
}

/** Documents the merge install result payload exchanged by command, SDK, and package integrations. */
export interface MergeInstallResult {
  /** Whether the installation completed (or, for dry runs, would complete) without errors. */
  ok: boolean;
  /** Whether this run was a preview only. */
  dry_run: boolean;
  /** Repository root the merge configuration was installed into. */
  workspace_root: string;
  /** `.gitattributes` reconciliation outcome. */
  gitattributes: {
    path: string;
    changed: boolean;
    patterns: string[];
  };
  /** Local `git config` merge-driver definitions applied (or previewed). */
  git_config: Array<{ key: string; value: string }>;
  /** Guidance for completing the multi-branch workflow setup. */
  guidance: string[];
  /** ISO 8601 timestamp recording when generated occurred. */
  generated_at: string;
}

async function resolveGitWorkspaceRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    return stdout.trim();
  } catch {
    throw new PmCliError(
      "pm merge install requires a git repository (merge drivers are git configuration).",
      EXIT_CODE.USAGE,
    );
  }
}

function toPosixRelative(fromPath: string, toPath: string): string {
  return path.relative(fromPath, toPath).replaceAll("\\", "/");
}

function buildMergeAttributePatterns(
  trackerRelativeRoot: string,
  typeFolders: string[],
): string[] {
  const prefix = trackerRelativeRoot.length > 0 ? `${trackerRelativeRoot}/` : "";
  const patterns: string[] = [];
  for (const folder of typeFolders) {
    patterns.push(`${prefix}${folder}/*.toon merge=pm-item`);
    patterns.push(`${prefix}${folder}/*.md merge=pm-item`);
  }
  patterns.push(`${prefix}history/*.jsonl merge=pm-history`);
  patterns.push(`${prefix}settings.json merge=pm-json`);
  patterns.push(`${prefix}schema/*.json merge=pm-json`);
  return patterns;
}

async function reconcileGitattributesBlock(
  workspaceRoot: string,
  patterns: string[],
  dryRun: boolean,
): Promise<{ path: string; changed: boolean }> {
  const gitattributesPath = path.join(workspaceRoot, ".gitattributes");
  let current = "";
  try {
    current = await readFile(gitattributesPath, "utf8");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const block = [
    PM_GITATTRIBUTES_START,
    ...patterns,
    PM_GITATTRIBUTES_END,
  ].join("\n");
  const start = current.indexOf(PM_GITATTRIBUTES_START);
  const end = current.indexOf(PM_GITATTRIBUTES_END);
  const withoutManagedBlock =
    start >= 0 && end >= start
      ? `${current.slice(0, start)}${current.slice(end + PM_GITATTRIBUTES_END.length)}`
      : current;
  const prefix = withoutManagedBlock.trimEnd();
  const next = `${prefix.length > 0 ? `${prefix}\n\n` : ""}${block}\n`;
  if (next === current) {
    return { path: gitattributesPath, changed: false };
  }
  if (!dryRun) {
    await writeFile(gitattributesPath, next, "utf8");
  }
  return { path: gitattributesPath, changed: true };
}

/**
 * Install (or preview) the repository merge configuration for tracker data:
 * writes the fenced merge-driver block into `.gitattributes` (committed and
 * shared with every branch) and defines the `merge.pm-*.driver` entries in the
 * repository-local git config (per-clone, so every collaborator runs this once
 * per checkout). Requires an initialized tracker and a git repository.
 */
export async function runMergeInstall(
  options: MergeInstallOptions,
  global: GlobalOptions,
): Promise<MergeInstallResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const dryRun = options.dryRun === true;
  const workspaceRoot = await resolveGitWorkspaceRoot(process.cwd());
  const trackerRelativeRoot = toPosixRelative(workspaceRoot, path.resolve(pmRoot));
  if (trackerRelativeRoot.startsWith("..")) {
    throw new PmCliError(
      `Tracker root ${pmRoot} is outside the git repository ${workspaceRoot}; there is nothing to configure for this repository.`,
      EXIT_CODE.USAGE,
    );
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const typeFolders = [
    ...new Set(Object.values(typeRegistry.type_to_folder)),
  ].sort((left, right) => left.localeCompare(right));
  const patterns = buildMergeAttributePatterns(trackerRelativeRoot, typeFolders);
  const gitattributes = await reconcileGitattributesBlock(
    workspaceRoot,
    patterns,
    dryRun,
  );

  const gitConfigEntries: Array<{ key: string; value: string }> = [];
  for (const definition of MERGE_DRIVER_DEFINITIONS) {
    gitConfigEntries.push({
      key: `merge.${definition.key}.name`,
      value: definition.name,
    });
    gitConfigEntries.push({
      key: `merge.${definition.key}.driver`,
      value: `pm merge driver ${definition.artifact} %O %A %B`,
    });
  }
  if (!dryRun) {
    for (const entry of gitConfigEntries) {
      await execFileAsync("git", ["config", entry.key, entry.value], {
        cwd: workspaceRoot,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    workspace_root: workspaceRoot,
    gitattributes: {
      path: gitattributes.path,
      changed: gitattributes.changed,
      patterns,
    },
    git_config: gitConfigEntries,
    guidance: [
      "Commit .gitattributes so every branch and collaborator shares the merge mapping.",
      "git config is per-clone: each collaborator (and each fresh worktree/clone) runs \"pm merge install\" once.",
      'After merging branches, run "pm validate" and, if history drift is reported, "pm history-repair --all" to reconcile item state with merged history.',
      "Rerun pm merge install after registering custom item types so new type folders are covered.",
    ],
    generated_at: nowIso(),
  };
}
