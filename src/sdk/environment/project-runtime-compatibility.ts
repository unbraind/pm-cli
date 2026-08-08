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

/** Return whether an invocation includes one of the exact mutation switches. */
function hasAnyToken(
  argv: readonly string[],
  tokens: readonly string[],
): boolean {
  return argv.some((token) => tokens.includes(token));
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
    if (positionals[0] === "generate") return !argv.includes("--check");
    const exportIndex = argv.indexOf("export");
    return (
      positionals[0] === "export" &&
      (argv.includes("--output") ||
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
    (positionals[0] === "discover" && argv.includes("--apply")),
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
    !(argv.includes("--infer") && !argv.includes("--apply")),
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
  /** Exact or minimum date-version extracted from the project declaration. */
  version: string;
  /** Redaction-safe origin of the pin. */
  source:
    | "package.json"
    | "installed-package"
    | "package-lock.json"
    | "pnpm-lock.yaml"
    | "yarn.lock";
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
  /** Whether the explicit one-invocation recovery override was accepted. */
  override_applied: boolean;
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

/** Extract the minimum explicit pm date version from dependency declarations. */
function dependencyPin(
  packageJson: Record<string, unknown>,
): string | undefined {
  const versions: string[] = [];
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = packageJson[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    const value = (dependencies as Record<string, unknown>)[PACKAGE_NAME];
    const version =
      typeof value === "string" ? value.match(VERSION_PATTERN)?.[0] : undefined;
    if (version) versions.push(version);
  }
  return versions.sort(
    (left, right) => comparePmDateVersions(right, left) as number,
  )[0];
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

/** Read the highest nearby exact coordinate from a text lockfile package block. */
function textLockPin(
  projectRoot: string,
  file: "pnpm-lock.yaml" | "yarn.lock",
): string | undefined {
  try {
    const source = fs.readFileSync(path.join(projectRoot, file), "utf8");
    const packageIndex = source.indexOf(PACKAGE_NAME);
    if (packageIndex < 0) return undefined;
    return [
      ...source
        .slice(packageIndex, packageIndex + 600)
        .matchAll(new RegExp(VERSION_PATTERN.source, "gu")),
    ]
      .map((match) => match[0])
      .sort((left, right) => comparePmDateVersions(right, left) as number)[0];
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
  const declared = projectPackage ? dependencyPin(projectPackage) : undefined;
  if (declared) pins.push({ version: declared, source: "package.json" });
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
    pins.push({ version: installedVersion, source: "installed-package" });
  }
  const packageLockVersion = packageLockPin(projectRoot);
  if (packageLockVersion && parseDateVersion(packageLockVersion)) {
    pins.push({ version: packageLockVersion, source: "package-lock.json" });
  }
  for (const file of ["pnpm-lock.yaml", "yarn.lock"] as const) {
    const version = textLockPin(projectRoot, file);
    if (version) pins.push({ version, source: file });
  }
  return pins;
}

/** Resolve the first command token while preserving path-like global option values. */
function commandFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (GLOBAL_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) return token.toLowerCase();
  }
  return undefined;
}

/** Classify mutation-capable invocations while preserving explicit read modes. */
export function isProjectMutatingInvocation(argv: readonly string[]): boolean {
  const command = commandFromArgv(argv);
  if (!command) return false;
  if (argv.includes("--help") || argv.includes("-h")) return false;
  if (argv.includes("--dry-run")) return false;
  const commandIndex = argv.findIndex(
    (token) => token.toLowerCase() === command,
  );
  const positionals = argv
    .slice(commandIndex + 1)
    .filter((token) => !token.startsWith("-"))
    .map((token) => token.toLowerCase());
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
  const command = commandFromArgv(options.argv);
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
  return {
    compatible: !mutating || !stale || options.allowStale === true,
    executing_version: options.executingVersion,
    ...(newest
      ? { project_version: newest.version, source: newest.source }
      : {}),
    ...(command ? { command } : {}),
    mutating,
    override_applied: stale && mutating && options.allowStale === true,
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
