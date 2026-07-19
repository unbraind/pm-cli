/**
 * @module sdk/merge/install
 *
 * Installs the tracker's git merge configuration into a repository: a fenced
 * `.gitattributes` block mapping every mergeable tracker artifact class to a
 * pm merge driver, plus the local `git config` driver definitions that make
 * those attributes effective. Idempotent and re-runnable; schema type
 * mutations refresh the fenced block automatically once it is installed.
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
import { isPathOutsideRoot } from "../workspace.js";

const execFileAsync = promisify(execFile);

/** Opening marker for the pm-owned merge-driver `.gitattributes` block. */
export const PM_GITATTRIBUTES_START = "# pm-cli:merge-drivers:start";
/** Closing marker for the pm-owned merge-driver `.gitattributes` block. */
export const PM_GITATTRIBUTES_END = "# pm-cli:merge-drivers:end";

const MERGE_DRIVER_DEFINITIONS = [
  {
    key: "pm-item-toon",
    name: "pm field-aware TOON item document merge",
    artifact: "item",
    itemPath: "item.toon",
  },
  {
    key: "pm-item-markdown",
    name: "pm field-aware JSON-markdown item document merge",
    artifact: "item",
    itemPath: "item.md",
  },
  {
    key: "pm-history",
    name: "pm append-only history stream merge",
    artifact: "history",
    itemPath: undefined,
  },
  {
    key: "pm-relationship",
    name: "pm append-only relationship event store merge",
    artifact: "relationship",
    itemPath: undefined,
  },
  {
    key: "pm-json",
    name: "pm key-level JSON config merge",
    artifact: "json",
    itemPath: undefined,
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

/** Encode one Git attributes pattern with C-style quoting so whitespace, backslashes, and quotation marks remain part of the repository path instead of being parsed as attribute separators. */
function quoteGitAttributePattern(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Build the complete fenced `.gitattributes` pattern list for a tracker rooted
 * at `trackerRelativeRoot` (git-root-relative POSIX path, empty when the
 * tracker root IS the git root). This is the single coverage contract shared
 * by `pm merge install` (which writes the fence) and the validate
 * merge-fence-drift detection (which compares the committed fence against the
 * active schema's type folders), so schema-added custom types can never
 * silently diverge from the installed fence without a warning.
 */
export function buildMergeAttributePatterns(
  trackerRelativeRoot: string,
  typeFolders: string[],
): string[] {
  const prefix =
    trackerRelativeRoot.length > 0 ? `${trackerRelativeRoot}/` : "";
  const patterns: string[] = [];
  for (const folder of typeFolders) {
    patterns.push(
      `${quoteGitAttributePattern(`${prefix}${folder}/*.toon`)} merge=pm-item-toon`,
    );
    patterns.push(
      `${quoteGitAttributePattern(`${prefix}${folder}/*.md`)} merge=pm-item-markdown`,
    );
  }
  // RelationshipEventStore deliberately accepts a caller-chosen relativePath
  // anywhere below the tracker root. Cover all tracker JSONL first, then let
  // the more-specific history rule below override it. This keeps custom event
  // stores protected without guessing package-owned paths.
  patterns.push(
    `${quoteGitAttributePattern(`${prefix}**/*.jsonl`)} merge=pm-relationship`,
  );
  patterns.push(
    `${quoteGitAttributePattern(`${prefix}history/*.jsonl`)} merge=pm-history`,
  );
  patterns.push(
    `${quoteGitAttributePattern(`${prefix}settings.json`)} merge=pm-json`,
  );
  patterns.push(
    `${quoteGitAttributePattern(`${prefix}schema/*.json`)} merge=pm-json`,
  );
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
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
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
    start >= 0 && end > start
      ? `${current.slice(0, start)}${current.slice(end + PM_GITATTRIBUTES_END.length)}`
      : current
          .replace(PM_GITATTRIBUTES_START, "")
          .replace(PM_GITATTRIBUTES_END, "");
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

/** Result of comparing the committed merge-fence block against the coverage the active schema requires. */
export interface MergeFenceAuditResult {
  /** Audit outcome: no fence installed (nothing to audit), fence matches, or fence drifted from the active schema/type folders. */
  status: "not_installed" | "ok" | "drift";
  /** `.gitattributes` file containing the fence, when one was found. */
  path?: string;
  /** Expected attribute lines absent from the committed fence (for example a schema-added type folder). */
  missing_patterns: string[];
  /** Committed fence lines no longer produced by the coverage contract (for example a removed type folder). */
  stale_patterns: string[];
}

/**
 * Audit the committed `.gitattributes` merge fence against the coverage the
 * active schema requires, without touching git configuration. The fence file
 * is discovered by walking up from the tracker root (bounded), so the audit
 * stays filesystem-only and safe to run inside `pm validate`. A `drift`
 * result means items of some type folder (or a tracker JSONL store) would
 * merge under git's default text driver despite the fence being installed.
 */
export async function auditMergeAttributeFence(
  pmRoot: string,
  typeFolders: string[],
): Promise<MergeFenceAuditResult> {
  const resolvedRoot = path.resolve(pmRoot);
  let fenceDirectory: string | null = null;
  let fenceContent = "";
  let directory = resolvedRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, ".gitattributes");
    try {
      const raw = await readFile(candidate, "utf8");
      if (raw.includes(PM_GITATTRIBUTES_START)) {
        fenceDirectory = directory;
        fenceContent = raw;
        break;
      }
    } catch {
      // No .gitattributes at this level; keep walking up.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  if (fenceDirectory === null) {
    return { status: "not_installed", missing_patterns: [], stale_patterns: [] };
  }
  const fencePath = path.join(fenceDirectory, ".gitattributes");
  const start = fenceContent.indexOf(PM_GITATTRIBUTES_START);
  const end = fenceContent.indexOf(PM_GITATTRIBUTES_END);
  const committed =
    end > start
      ? fenceContent
          .slice(start + PM_GITATTRIBUTES_START.length, end)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
  const expected = buildMergeAttributePatterns(
    toPosixRelative(fenceDirectory, resolvedRoot),
    typeFolders,
  );
  const committedSet = new Set(committed);
  const expectedSet = new Set(expected);
  const missing = expected.filter((line) => !committedSet.has(line));
  const stale = committed.filter((line) => !expectedSet.has(line));
  return {
    status: missing.length > 0 || stale.length > 0 ? "drift" : "ok",
    path: fencePath,
    missing_patterns: missing,
    stale_patterns: stale,
  };
}

/** Outcome of an automatic merge-fence refresh attempted after a schema type mutation. */
export interface MergeFenceRefreshOutcome {
  /** What happened: the fence was rewritten, already matched, was never installed (actionable hint), or there is no git repository to configure. */
  status: "refreshed" | "unchanged" | "not_installed" | "no_git";
  /** `.gitattributes` path examined, when a git repository was found. */
  path?: string;
}

/**
 * Refresh the fenced `.gitattributes` merge-driver block after a schema type
 * mutation, but only when `pm merge install` already ran (the fence markers
 * are present). Without this, custom item types registered after install
 * would write items into folders with no merge attribute — silently
 * reintroducing the whole-file conflict class for exactly those items. Repos
 * that never installed the fence get a `not_installed` outcome so callers can
 * surface an actionable hint instead of mutating git configuration nobody
 * asked for.
 */
export async function refreshMergeAttributeFenceIfInstalled(
  pmRoot: string,
): Promise<MergeFenceRefreshOutcome> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await resolveGitWorkspaceRoot(path.resolve(pmRoot));
  } catch {
    return { status: "no_git" };
  }
  const trackerRelativeRoot = toPosixRelative(
    workspaceRoot,
    path.resolve(pmRoot),
  );
  const gitattributesPath = path.join(workspaceRoot, ".gitattributes");
  let current: string;
  try {
    current = await readFile(gitattributesPath, "utf8");
  } catch {
    return { status: "not_installed", path: gitattributesPath };
  }
  if (!current.includes(PM_GITATTRIBUTES_START)) {
    return { status: "not_installed", path: gitattributesPath };
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const typeFolders = [
    ...new Set(Object.values(typeRegistry.type_to_folder)),
  ].sort((left, right) => left.localeCompare(right));
  const outcome = await reconcileGitattributesBlock(
    workspaceRoot,
    buildMergeAttributePatterns(trackerRelativeRoot, typeFolders),
    false,
  );
  return {
    status: outcome.changed ? "refreshed" : "unchanged",
    path: outcome.path,
  };
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
  const trackerRelativeRoot = toPosixRelative(
    workspaceRoot,
    path.resolve(pmRoot),
  );
  if (isPathOutsideRoot(trackerRelativeRoot)) {
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
  const patterns = buildMergeAttributePatterns(
    trackerRelativeRoot,
    typeFolders,
  );
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
      value: `pm merge driver ${definition.artifact} "%O" "%A" "%B"${definition.itemPath === undefined ? "" : ` --item-path ${definition.itemPath}`}`,
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
      'git config is per-clone: each collaborator (and each fresh worktree/clone) runs "pm merge install" once.',
      'After merging branches, run "pm validate" and, if history drift is reported, "pm history-repair --all" to reconcile item state with merged history.',
      "Custom item types registered later refresh this fence automatically (pm schema add-type/remove-type); rerun pm merge install only after out-of-band type-folder edits.",
    ],
    generated_at: nowIso(),
  };
}
