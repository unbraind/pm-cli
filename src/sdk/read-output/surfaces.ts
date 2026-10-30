/**
 * @module sdk/read-output/surfaces
 *
 * Native read-surface identity and legacy projection-mode tables. Kept free of
 * renderer and budget imports so bootstrap-time recovery can derive a command's
 * completeness vocabulary without loading the output formatters.
 */
import { PM_READ_OUTPUT_SURFACES } from "./options.js";

/** Native read surface named by the universal output contract. */
type NativeReadOutputSurface = (typeof PM_READ_OUTPUT_SURFACES)[number];
/** Output dimension that a legacy flag aliases. */
type ReadOutputDimension = "include" | "amount" | "cost" | "encoding";

/** Legacy per-command flags grouped by the universal dimension they alias. */
export const LEGACY_FLAGS_BY_COMMAND: Readonly<
  Partial<Record<string, Partial<Record<ReadOutputDimension, string[]>>>>
> = {
  list: {
    include: ["--brief", "--compact", "--fields", "--full"],
    amount: ["--after", "--limit", "--no-truncate"],
    cost: ["--token-budget"],
    encoding: ["--format", "--stream"],
  },
  context: {
    include: ["--fields", "--section"],
    amount: ["--after", "--depth", "--limit"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  search: {
    include: ["--compact", "--fields", "--full"],
    amount: ["--after", "--limit"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  get: {
    include: ["--fields", "--full"],
    amount: ["--depth"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  next: {
    amount: ["--blocked-limit", "--limit"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  health: {
    include: ["--brief", "--check-only", "--full", "--summary"],
  },
  deps: {
    include: ["--collapse", "--full", "--summary"],
    amount: ["--edge-limit", "--max-depth", "--node-limit"],
    cost: ["--token-budget"],
    encoding: ["--format"],
  },
  graph: {
    include: ["--full", "--summary"],
    amount: ["--after", "--limit", "--max-depth", "--max-paths"],
  },
  history: {
    include: ["--compact", "--full"],
    amount: ["--limit"],
    encoding: ["--format"],
  },
  activity: {
    include: ["--compact", "--full"],
    amount: ["--limit", "--unbounded", "--after"],
    encoding: ["--stream"],
  },
  validate: { include: ["--counts", "--full"] },
  events: {
    include: ["--full"],
    amount: ["--limit"],
    encoding: ["--follow"],
  },
  contracts: { include: ["--full", "--summary"] },
  comments: { amount: ["--limit"] },
  notes: { amount: ["--limit"] },
  files: {
    amount: ["--limit", "--no-truncate", "--offset"],
  },
  docs: {},
  stats: {},
  aggregate: {},
  duplicates: { amount: ["--limit"] },
  "package-catalog": {},
  "package-manage": {},
  "comments-audit": {},
  assurance: {},
};

/** Include aliases that carry a value rather than naming a projection mode. */
export const VALUE_BEARING_INCLUDE_ALIASES = new Set([
  "--collapse",
  "--fields",
  "--section",
]);

/** Legacy flags whose behavior the canonical dimension does not replace. */
export const BEHAVIOR_PRESERVING_MIGRATION_HINTS: Readonly<Record<string, string>> =
  Object.freeze({
    "--after":
      "--after retains cursor-position semantics; use --output-limit <n> separately to bound returned rows.",
    "--check-only":
      "--check-only retains health side-effect semantics; --output-include does not suppress vector refresh.",
    "--collapse":
      "--collapse retains dependency grouping semantics; --output-include does not replace it.",
    "--depth":
      "--depth retains traversal or detail-depth semantics; --output-limit does not replace it.",
    "--follow":
      "--follow retains event-tail semantics; --output-format does not enable following.",
    "--max-depth":
      "--max-depth retains graph traversal-depth semantics; --output-limit does not replace it.",
    "--max-paths":
      "--max-paths retains graph path-search semantics; use --output-limit separately to bound returned rows.",
    "--no-truncate":
      "--no-truncate is a compatibility alias; prefer --output-limit unbounded --output-budget unbounded.",
    "--offset":
      "--offset retains positional pagination semantics; use --output-limit separately to bound returned rows.",
    "--stream":
      "--stream retains command streaming semantics; --output-format selects only static result encoding.",
    "--unbounded":
      "--unbounded is a compatibility alias; prefer --output-limit unbounded.",
  });

/** Translate a CLI flag into the underscore selector used by projection-mode contracts. */
export function flagSelector(flag: string): string {
  return flag.slice(2).replaceAll("-", "_");
}

/** Resolve native read aliases without consulting request-local extension state. */
export function resolveNativeReadOutputSurface(normalizedCommand: string, options: Record<string, unknown> = {}): NativeReadOutputSurface | undefined {
  const packageMode =
    normalizedCommand === "package catalog" ||
    normalizedCommand === "packages catalog" ||
    normalizedCommand === "package-catalog" ||
    ((normalizedCommand === "package" ||
      normalizedCommand === "packages" ||
      normalizedCommand === "extension") &&
      (options.catalog === true ||
        options.target === "catalog" ||
        options.action === "catalog"));
  const root = packageMode
    ? "package-catalog"
    : normalizedCommand === "package manage" ||
        normalizedCommand === "package-manage"
      ? "package-manage"
      : normalizedCommand.split(" ")[0]!;
  const normalized = root.startsWith("list-")
    ? "list"
    : root === "ctx"
      ? "context"
      : root;
  return PM_READ_OUTPUT_SURFACES.includes(normalized as (typeof PM_READ_OUTPUT_SURFACES)[number])
    ? (normalized as NativeReadOutputSurface)
    : undefined;
}

/** Build compatibility include modes without invoking runtime registry discovery. */
export function readOutputIncludeModeOptionsForSurface(surface: string): ReadonlyMap<string, string> {
  return new Map(
    (LEGACY_FLAGS_BY_COMMAND[surface]?.include ?? [])
      .filter(
        (flag) =>
          !VALUE_BEARING_INCLUDE_ALIASES.has(flag) &&
          BEHAVIOR_PRESERVING_MIGRATION_HINTS[flag] === undefined,
      )
      .map((flag) => [flagSelector(flag), optionKey(flag)] as const),
  );
}

/** Convert a dashed CLI flag to the camel-case key accepted by command option records. */
export function optionKey(flag: string): string {
  return flag
    .slice(2)
    .replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
}
