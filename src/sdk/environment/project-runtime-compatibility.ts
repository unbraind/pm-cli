/**
 * @module sdk/project-runtime-compatibility
 *
 * Protects project mutations from an older PATH-resolved pm executable while
 * leaving diagnosis reads available.
 */
import fs from "node:fs";
import path from "node:path";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

export { PmCliError };

const PACKAGE_NAME = "@unbrained/pm-cli";
const MUTATING_COMMANDS = new Set([
  "append",
  "claim",
  "changelog",
  "close",
  "close-many",
  "close-task",
  "comments",
  "config",
  "copy",
  "create",
  "dedupe-merge",
  "delete",
  "deps",
  "docs",
  "extension",
  "event",
  "events",
  "files",
  "focus",
  "gc",
  "history-author-acknowledge",
  "history-compact",
  "history-redact",
  "history-repair",
  "init",
  "install",
  "item",
  "learnings",
  "meet",
  "merge",
  "normalize",
  "notes",
  "package",
  "packages",
  "pause-task",
  "plan",
  "profile",
  "reindex",
  "release",
  "remind",
  "restore",
  "schema",
  "start-task",
  "test",
  "test-all",
  "test-runs",
  "test-runs-worker",
  "telemetry",
  "templates",
  "twin",
  "update",
  "update-many",
  "upgrade",
  "vcs",
  "workspace",
]);
const GLOBAL_VALUE_FLAGS = new Set([
  "--author",
  "--output-budget",
  "--output-format",
  "--output-include",
  "--output-limit",
  "--output-session",
  "--path",
  "--pm-path",
]);
const VERSION_PATTERN = /\b(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?\b/u;
/** First pm release whose history writer and reader support item-hash epoch 3. */
export const HISTORY_ITEM_HASH_VERSION_3_INTRODUCED_IN = "2026.8.31";

/** Return whether an invocation includes one of the exact mutation switches. */
function hasAnyToken(
  argv: readonly string[],
  tokens: readonly string[],
): boolean {
  return argv.some((token) => tokens.includes(token.split("=", 1)[0]));
}

/** Classify package/extension compatibility aliases from subcommands and legacy flags. */
function isPackageMutation(
  argv: readonly string[],
  positionals: readonly string[],
): boolean {
  return (
    [
      "activate",
      "adopt",
      "adopt-all",
      "deactivate",
      "init",
      "install",
      "migrate",
      "reload",
      "uninstall",
    ].includes(positionals[0] ?? "") ||
    hasAnyToken(argv, [
      "--activate",
      "--adopt",
      "--adopt-all",
      "--deactivate",
      "--fix-managed-state",
      "--init",
      "--install",
      "--output",
      "--reload",
      "--scaffold",
      "--uninstall",
    ])
  );
}

type MixedCommandClassifier = (
  argv: readonly string[],
  positionals: readonly string[],
) => boolean;

const MIXED_COMMAND_CLASSIFIERS: Readonly<
  Record<string, MixedCommandClassifier>
> = {
  changelog: (argv, positionals) => {
    if (positionals[0] === "generate") return !hasAnyToken(argv, ["--check"]);
    const exportIndex = argv.indexOf("export");
    return (
      positionals[0] === "export" &&
      (hasAnyToken(argv, ["--output"]) ||
        (exportIndex >= 0 &&
          argv[exportIndex + 1] !== undefined &&
          !argv[exportIndex + 1].startsWith("-")))
    );
  },
  comments: (argv) =>
    hasAnyToken(argv, ["--add", "--delete", "--edit", "--file", "--stdin"]),
  config: (_argv, positionals) =>
    (positionals[0] === "project" || positionals[0] === "global"
      ? positionals[1]
      : positionals[0]) === "set",
  deps: () => false,
  docs: (argv) =>
    hasAnyToken(argv, ["--add", "--add-glob", "--migrate", "--remove"]),
  duplicates: () => false,
  events: () => false,
  extension: isPackageMutation,
  files: (argv, positionals) =>
    hasAnyToken(argv, ["--add", "--add-glob", "--migrate", "--remove"]) ||
    (positionals[0] === "discover" && hasAnyToken(argv, ["--apply"])),
  health: (argv) =>
    !hasAnyToken(argv, ["--check-only", "--no-refresh", "--skip-vectors"]),
  learnings: (argv) =>
    hasAnyToken(argv, ["--add", "--delete", "--edit", "--file", "--stdin"]),
  merge: (_argv, positionals) => positionals[0] !== "report",
  notes: (argv) =>
    hasAnyToken(argv, ["--add", "--delete", "--edit", "--file", "--stdin"]),
  package: isPackageMutation,
  packages: isPackageMutation,
  profile: (_argv, positionals) => positionals[0] === "apply",
  schema: (argv, positionals) =>
    [
      "add-field",
      "add-status",
      "add-type",
      "remove-field",
      "remove-status",
      "remove-type",
      "remap-status",
      "rename-field",
      "rename-type",
    ].includes(positionals[0] ?? "") &&
    !(hasAnyToken(argv, ["--infer"]) && !hasAnyToken(argv, ["--apply"])),
  telemetry: (_argv, positionals) =>
    positionals.slice(0, 2).some((token) => ["clear", "flush"].includes(token)),
  templates: (_argv, positionals) => positionals[0] === "save",
  test: (argv) =>
    hasAnyToken(argv, [
      "--add",
      "--add-json",
      "--background",
      "--measure",
      "--remove",
      "--resume",
      "--run",
      "--stop",
    ]),
  validate: (argv) => hasAnyToken(argv, ["--auto-fix", "--prune-missing"]),
  vcs: (_argv, positionals) =>
    ["abandon", "create", "merge", "propose", "ref-create"].includes(
      positionals[0] ?? "",
    ),
  workspace: (_argv, positionals) =>
    positionals[0] === "snapshot" &&
    ["create", "delete", "restore"].includes(positionals[1] ?? ""),
};

/** One discovered project pin that can prove the active executable is stale. */
export interface ProjectRuntimeVersionPin {
  /** Representative date-version extracted from the project declaration. */
  version: string;
  /** Redaction-safe origin of the pin. */
  source:
    | "package.json"
    | "installed-package"
    | "package-lock.json"
    | "pnpm-lock.yaml"
    | "yarn.lock";
  /** Whether the declaration selects one runtime, a minimum, or a bounded range. */
  constraint: "exact" | "minimum" | "range";
  /** Original package declaration when it conveys more than the representative version. */
  declaration?: string;
  /** Whether the declaration permits a reader that understands history item-hash epoch 3. */
  history_epoch_compatible?: boolean;
}

/** Structured result returned by the read-only compatibility probe. */
export interface ProjectRuntimeCompatibilityResult {
  /** Whether the invocation can write with the active runtime. */
  compatible: boolean;
  /** Active executable package version. */
  executing_version: string;
  /** Highest project pin discovered without exposing local paths. */
  project_version?: string;
  /** Origin of the highest project pin. */
  source?: ProjectRuntimeVersionPin["source"];
  /** Canonical command selected from the invocation. */
  command?: string;
  /** Whether the selected invocation can mutate project state. */
  mutating: boolean;
  /** Whether the active executable is older than the strongest project pin. */
  stale?: boolean;
  /** Whether this mutation would write a history epoch a project pin cannot read. */
  history_epoch_incompatible?: boolean;
  /** Item-hash epoch the executing runtime writes. */
  writer_item_hash_version?: 2 | 3;
  /** Project runtime declaration that cannot read the writer epoch. */
  incompatible_project_version?: string;
  /** Origin of the incompatible project runtime declaration. */
  incompatible_source?: ProjectRuntimeVersionPin["source"];
  /** Non-blocking diagnostic attached to stale read-only invocations. */
  warning?: ProjectRuntimeCompatibilityWarning;
  /** Whether the explicit one-invocation recovery override was accepted. */
  override_applied: boolean;
}

/** Structured, package-manager-neutral warning returned for a stale read. */
export interface ProjectRuntimeCompatibilityWarning {
  /** Stable warning code for filtering and automation. */
  code: "project_runtime_stale_read";
  /** Active executable package version. */
  executing_version: string;
  /** Strongest newer project version pin. */
  project_version: string;
  /** Redaction-safe origin of the project pin. */
  source: ProjectRuntimeVersionPin["source"];
  /** Concise explanation of the mismatch. */
  message: string;
  /** Package-manager-neutral recovery actions. */
  next_steps: string[];
}

/** Parse the supported date-version coordinates used by pm releases. */
function parseDateVersion(
  value: string,
): [number, number, number, number] | null {
  const match = value.match(VERSION_PATTERN);
  return match
    ? [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4] ?? 0),
      ]
    : null;
}

/** Compare pm date versions without accepting arbitrary semver-like prose. */
export function comparePmDateVersions(
  left: string,
  right: string,
): number | null {
  const leftParts = parseDateVersion(left);
  const rightParts = parseDateVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

/** Resolve the item-hash epoch written by a known pm runtime release. */
export function historyItemHashVersionForRuntime(version: string): 2 | 3 {
  return comparePmDateVersions(
    version,
    HISTORY_ITEM_HASH_VERSION_3_INTRODUCED_IN,
  ) !== -1
    ? 3
    : 2;
}

/** Find the oldest declaration that cannot select a reader for the executing writer epoch. */
function findIncompatibleHistoryEpochPin(
  pins: readonly ProjectRuntimeVersionPin[],
  writerItemHashVersion: 2 | 3,
): (ProjectRuntimeVersionPin & Readonly<{ declaration: string }>) | undefined {
  if (writerItemHashVersion !== 3) return undefined;
  return pins
    .filter((pin) => pin.history_epoch_compatible === false)
    .map((pin) => ({ ...pin, declaration: pin.declaration ?? pin.version }))
    .sort(
      (left, right) =>
        comparePmDateVersions(left.version, right.version) as number,
    )[0];
}

/** Read one optional JSON object without turning absence or corruption into startup failure. */
function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Extract explicit comparator and hyphen upper bounds from one range branch. */
function rangeUpperBounds(
  alternative: string,
): Array<Readonly<{ inclusive: boolean; version: string }>> {
  const comparators = [
    ...alternative.matchAll(/(<=|<)\s*v?(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)/gu),
  ].map((match) => ({ inclusive: match[1] === "<=", version: match[2]! }));
  const hyphen = alternative.match(
    /\b\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?\s+-\s+v?(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)/u,
  );
  return hyphen
    ? [...comparators, { inclusive: true, version: hyphen[1]! }]
    : comparators;
}

/** Classify whether a range is bounded and can select an epoch-3 reader. */
function analyzeHistoryEpochRange(specification: string): Readonly<{
  bounded: boolean;
  compatible: boolean;
}> {
  const alternativeBounds = specification
    .split("||")
    .map((alternative) => rangeUpperBounds(alternative));
  return {
    bounded: alternativeBounds.some((bounds) => bounds.length > 0),
    compatible: alternativeBounds.some((bounds) =>
      bounds.every((bound) => {
        const comparison = comparePmDateVersions(
          HISTORY_ITEM_HASH_VERSION_3_INTRODUCED_IN,
          bound.version,
        );
        return (
          comparison !== null &&
          (bound.inclusive ? comparison !== 1 : comparison === -1)
        );
      }),
    ),
  };
}

/** Extract every supported pm declaration without letting one section hide another. */
function dependencyPins(
  packageJson: Record<string, unknown>,
): Array<
  Pick<
    ProjectRuntimeVersionPin,
    "constraint" | "declaration" | "history_epoch_compatible" | "version"
  >
> {
  return [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ].flatMap((field) => {
    const dependencies = packageJson[field];
    if (typeof dependencies !== "object" || dependencies === null) return [];
    const value = (dependencies as Record<string, unknown>)[PACKAGE_NAME];
    const specification = typeof value === "string" ? value.trim() : "";
    const version = /^[<!]/u.test(specification)
      ? undefined
      : specification.match(VERSION_PATTERN)?.[0];
    if (!version) return [];
    const exact = /^(?:=|v)?\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/u.test(
      specification,
    );
    const range = analyzeHistoryEpochRange(specification);
    return [
      {
        version,
        constraint: exact ? "exact" : range.bounded ? "range" : "minimum",
        ...(exact ? {} : { declaration: specification }),
        history_epoch_compatible: exact
          ? comparePmDateVersions(
              version,
              HISTORY_ITEM_HASH_VERSION_3_INTRODUCED_IN,
            ) !== -1
          : range.compatible,
      },
    ];
  });
}

/** Read npm's exact installed package coordinate from package-lock.json. */
function packageLockPin(projectRoot: string): string | undefined {
  const lock = readJsonRecord(path.join(projectRoot, "package-lock.json"));
  const packages = lock?.packages;
  if (typeof packages !== "object" || packages === null) return undefined;
  const installed = (packages as Record<string, unknown>)[
    "node_modules/@unbrained/pm-cli"
  ];
  if (typeof installed !== "object" || installed === null) return undefined;
  const version = (installed as Record<string, unknown>).version;
  return typeof version === "string" ? version : undefined;
}

/** Read the exact coordinate from the matching text lockfile package block. */
function textLockPin(
  projectRoot: string,
  file: "pnpm-lock.yaml" | "yarn.lock",
): string | undefined {
  try {
    const lines = fs
      .readFileSync(path.join(projectRoot, file), "utf8")
      .split(/\r?\n/u);
    const packageLineIndex = lines.findIndex((line) =>
      line.includes(PACKAGE_NAME),
    );
    if (packageLineIndex < 0) return undefined;
    const packageIndent = lines[packageLineIndex].match(/^\s*/u)![0].length;
    const entry = [lines[packageLineIndex]];
    for (let index = packageLineIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      const indent = line.match(/^\s*/u)![0].length;
      if (trimmed.length > 0 && indent <= packageIndent) break;
      entry.push(line);
    }
    const entrySource = entry.join("\n");
    const explicitVersion = entrySource.match(
      /^\s*version(?::\s*|\s+)["']?(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)/mu,
    )?.[1];
    return explicitVersion ?? entry[0].match(VERSION_PATTERN)?.[0];
  } catch {
    return undefined;
  }
}

/** Discover declared, installed, and lock-resolved versions without network I/O. */
export function discoverProjectRuntimeVersionPins(
  projectRoot: string,
): ProjectRuntimeVersionPin[] {
  const pins: ProjectRuntimeVersionPin[] = [];
  const projectPackage = readJsonRecord(path.join(projectRoot, "package.json"));
  if (projectPackage) {
    pins.push(
      ...dependencyPins(projectPackage).map((pin) => ({
        ...pin,
        source: "package.json" as const,
      })),
    );
  }
  const installedPackage = readJsonRecord(
    path.join(
      projectRoot,
      "node_modules",
      "@unbrained",
      "pm-cli",
      "package.json",
    ),
  );
  const installedVersion = installedPackage?.version;
  if (
    typeof installedVersion === "string" &&
    parseDateVersion(installedVersion)
  ) {
    pins.push({
      version: installedVersion,
      source: "installed-package",
      constraint: "exact",
      history_epoch_compatible:
        historyItemHashVersionForRuntime(installedVersion) === 3,
    });
  }
  const packageLockVersion = packageLockPin(projectRoot);
  if (packageLockVersion && parseDateVersion(packageLockVersion)) {
    pins.push({
      version: packageLockVersion,
      source: "package-lock.json",
      constraint: "exact",
      history_epoch_compatible:
        historyItemHashVersionForRuntime(packageLockVersion) === 3,
    });
  }
  for (const file of ["pnpm-lock.yaml", "yarn.lock"] as const) {
    const version = textLockPin(projectRoot, file);
    if (version) {
      pins.push({
        version,
        source: file,
        constraint: "exact",
        history_epoch_compatible:
          historyItemHashVersionForRuntime(version) === 3,
      });
    }
  }
  return pins;
}

/** Resolve the first command token and index while preserving global option values. */
function commandTokenFromArgv(
  argv: readonly string[],
): { command: string; index: number } | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (GLOBAL_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) return { command: token.toLowerCase(), index };
  }
  return undefined;
}

/** Classify mutation-capable invocations while preserving explicit read modes. */
export function isProjectMutatingInvocation(argv: readonly string[]): boolean {
  const commandToken = commandTokenFromArgv(argv);
  if (!commandToken) return false;
  if (hasAnyToken(argv, ["--help", "-h", "--dry-run"])) return false;
  const { command, index: commandIndex } = commandToken;
  const positionals: string[] = [];
  for (let index = commandIndex + 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (GLOBAL_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) positionals.push(token.toLowerCase());
  }
  const mixedClassifier = MIXED_COMMAND_CLASSIFIERS[command];
  return mixedClassifier
    ? mixedClassifier(argv, positionals)
    : MUTATING_COMMANDS.has(command);
}

/** Inspect whether one invocation is compatible with the project's newest pin. */
export function inspectProjectRuntimeCompatibility(options: {
  executingVersion: string;
  projectRoot: string;
  argv: readonly string[];
  allowStale?: boolean;
}): ProjectRuntimeCompatibilityResult {
  const command = commandTokenFromArgv(options.argv)?.command;
  const mutating = isProjectMutatingInvocation(options.argv);
  const pins = discoverProjectRuntimeVersionPins(options.projectRoot)
    .filter(
      (pin) =>
        comparePmDateVersions(pin.version, options.executingVersion) !== null,
    )
    .sort(
      (left, right) =>
        comparePmDateVersions(right.version, left.version) as number,
    );
  const newest = pins[0];
  const stale =
    newest !== undefined &&
    comparePmDateVersions(options.executingVersion, newest.version) === -1;
  const writerItemHashVersion = historyItemHashVersionForRuntime(
    options.executingVersion,
  );
  const incompatibleEpochPin = findIncompatibleHistoryEpochPin(
    pins,
    writerItemHashVersion,
  );
  const historyEpochIncompatible =
    mutating && incompatibleEpochPin !== undefined;
  const warning =
    stale && !mutating
      ? {
          code: "project_runtime_stale_read" as const,
          executing_version: options.executingVersion,
          project_version: newest.version,
          source: newest.source,
          message:
            "This read is using an older pm runtime than the project requires.",
          next_steps: [
            `Run the command through the project's installed ${PACKAGE_NAME} ${newest.version}.`,
            "Install the project dependencies with its declared package manager if the local executable is missing.",
          ],
        }
      : undefined;
  return {
    compatible:
      !mutating ||
      (!stale && !historyEpochIncompatible) ||
      options.allowStale === true,
    executing_version: options.executingVersion,
    ...(newest
      ? { project_version: newest.version, source: newest.source }
      : {}),
    ...(command ? { command } : {}),
    mutating,
    stale,
    history_epoch_incompatible: historyEpochIncompatible,
    writer_item_hash_version: writerItemHashVersion,
    ...(incompatibleEpochPin
      ? {
          incompatible_project_version: incompatibleEpochPin.declaration,
          incompatible_source: incompatibleEpochPin.source,
        }
      : {}),
    ...(warning ? { warning } : {}),
    override_applied:
      mutating &&
      (stale || historyEpochIncompatible) &&
      options.allowStale === true,
  };
}

/** Refuse stale mutations with a stable SDK error and package-neutral recovery. */
export function assertProjectRuntimeCompatibility(options: {
  executingVersion: string;
  projectRoot: string;
  argv: readonly string[];
  allowStale?: boolean;
}): ProjectRuntimeCompatibilityResult {
  const result = inspectProjectRuntimeCompatibility(options);
  if (result.compatible) return result;
  if (result.history_epoch_incompatible) {
    throw new PmCliError(
      `pm ${result.executing_version} cannot write item-hash epoch ${result.writer_item_hash_version} into a project pinned to pm ${result.incompatible_project_version}.`,
      EXIT_CODE.CONFLICT,
      {
        code: "project_runtime_history_epoch_incompatible",
        reason: result.incompatible_source,
        why: `The pinned runtime cannot read item_hash_version ${result.writer_item_hash_version}; allowing the write would break its health and validation gates.`,
        nextSteps: [
          `Upgrade the project's ${PACKAGE_NAME} pin to ${HISTORY_ITEM_HASH_VERSION_3_INTRODUCED_IN} or newer before mutating tracker history.`,
          "For an intentional coordinated migration only, set PM_ALLOW_STALE_CLI=1 for this invocation and record why.",
          "Read-only commands remain available without an override.",
        ],
      },
    );
  }
  throw new PmCliError(
    `pm ${result.executing_version} cannot mutate a project pinned to newer pm ${result.project_version}.`,
    EXIT_CODE.CONFLICT,
    {
      code: "project_runtime_stale_mutation",
      reason: result.source,
      why: "An older runtime can write storage, history, and merge contracts it does not understand.",
      nextSteps: [
        `Run this command through the project's installed ${PACKAGE_NAME} ${result.project_version}.`,
        "For an intentional recovery only, set PM_ALLOW_STALE_CLI=1 for this invocation and record why.",
        "Read-only commands remain available without an override.",
      ],
    },
  );
}
