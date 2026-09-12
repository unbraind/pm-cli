/**
 * @module sdk/cli-contracts/command-aliases
 *
 * Declares command aliases once so CLI registration, bootstrap parsing,
 * contracts, completions, and package authors can share one compatibility
 * policy instead of maintaining parallel spelling lists.
 */

/** Lifecycle policy applied to a command alias. */
export type PmCommandAliasLifecycle = "permanent" | "deprecated";

/** Registration mechanism used to preserve an alias invocation. */
export type PmCommandAliasRegistration = "bootstrap" | "commander";

/** Machine-readable compatibility contract for one executable command alias. */
export interface PmCommandAliasContract {
  /** Legacy or ergonomic spelling accepted at the command root. */
  alias: string;
  /** Canonical command path agents should discover and generate. */
  canonical: string;
  /** Canonical tokens inserted before user-provided options and arguments. */
  canonical_argv: readonly string[];
  /** Whether the alias is permanent ergonomics or migration-only compatibility. */
  lifecycle: PmCommandAliasLifecycle;
  /** Whether default help and completion discovery omit the alias. */
  hidden: boolean;
  /** Runtime layer that keeps the alias executable. */
  registration: PmCommandAliasRegistration;
  /** PM item that owns the compatibility disposition. */
  owner: string;
}

/** History namespace aliases preserve the existing SDK and MCP operation identities. */
export const PM_HISTORY_COMMAND_ALIASES: readonly PmCommandAliasContract[] = ([
  ["history-redact", "history redact"],
  ["history-repair", "history repair"],
  ["history-compact", "history compact"],
  ["activity", "history activity"],
  ["restore", "history restore"],
] as const).map(([alias, canonical]) => ({
  alias,
  canonical,
  canonical_argv: canonical.split(" "),
  lifecycle: "permanent" as const,
  hidden: true,
  registration: "commander" as const,
  owner: "pm-tqel",
}));

/** Navigation, maintenance, and event aliases share native handlers and stable SDK identities. */
export const PM_CONTEXT_OPS_COMMAND_ALIASES: readonly PmCommandAliasContract[] = [
  ...["next", "focus"].map((alias) => ({ alias, canonical: `context ${alias}`, owner: "pm-kcs4" })),
  ...["stats", "health", "validate", "gc", "telemetry", "eval", "test-all"].map((alias) => ({ alias, canonical: `ops ${alias}`, owner: "pm-6apl" })),
  ...["normalize", "reindex"].map((alias) => ({ alias, canonical: `ops ${alias}`, owner: "pm-3i9q8g" })),
  { alias: "events", canonical: "history events", owner: "pm-3i9q8g" },
].map((entry) => ({
  ...entry,
  canonical_argv: entry.canonical.split(" "),
  lifecycle: "permanent",
  hidden: true,
  registration: "bootstrap",
}));

/** Bulk lifecycle operations retain their published SDK identities under canonical verbs. */
export const PM_BULK_LIFECYCLE_COMMAND_ALIASES: readonly PmCommandAliasContract[] = [
  ["update-many", "update many"],
  ["close-many", "close many"],
  ["delete", "close delete"],
].map(([alias, canonical]) => ({
  alias,
  canonical,
  canonical_argv: canonical.split(" "),
  lifecycle: "permanent",
  hidden: true,
  registration: "bootstrap",
  owner: "pm-ik19",
}));

/** Native handlers relocated into parent commands after core and package registration. */
export const PM_RELOCATED_COMMAND_ALIASES: readonly PmCommandAliasContract[] = [
  ...PM_CONTEXT_OPS_COMMAND_ALIASES,
  ...PM_BULK_LIFECYCLE_COMMAND_ALIASES,
  ...[
    ...["comments", "notes", "learnings", "files", "docs", "deps", "append", "test"].map((facet) => [facet, `item ${facet}`, "pm-yql1"]),
    ["test-runs-worker", "item test worker", "pm-lp4j"],
    ...["statuses", "tags", "types"].map((facet) => [`completion-${facet}`, `completion ${facet}`, "pm-szdc"]),
    ["copy", "item copy", "pm-m6g87m"],
    ["merge", "workspace merge", "pm-m6g87m"],
    ["duplicates", "item duplicates", "pm-fmy9ih"],
    ["dedupe-audit", "item duplicates audit", "pm-fmy9ih"],
    ["dedupe-merge", "item duplicates merge", "pm-fmy9ih"],
    ["comments-audit", "item audit-comments", "pm-fmy9ih"],
    ["search-advanced", "search advanced", "pm-wfskfn"],
  ].map(([alias, canonical, owner]): PmCommandAliasContract => ({
    alias,
    canonical,
    canonical_argv: canonical.split(" "),
    lifecycle: "permanent",
    hidden: true,
    registration: "bootstrap",
    owner,
  })),
];

/** Native noun-verb paths whose stable operation identities survive grammar consolidation. */
export const PM_NAMESPACED_COMMAND_ALIASES: readonly PmCommandAliasContract[] = [
  { alias: "history-attest", canonical: "history attest", canonical_argv: ["history", "attest"], lifecycle: "permanent", hidden: true, registration: "commander", owner: "pm-3z0k" },
  ...PM_HISTORY_COMMAND_ALIASES,
  ...PM_RELOCATED_COMMAND_ALIASES,
];

/** Find the longest declared command prefix without consuming flags or positional operands. */
export function findPmNamespacedCommand(tokens: readonly string[]): PmCommandAliasContract | undefined {
  let matched: PmCommandAliasContract | undefined;
  for (const alias of PM_NAMESPACED_COMMAND_ALIASES) {
    if (alias.canonical_argv.length <= (matched?.canonical_argv.length ?? 0)) continue;
    if (alias.canonical_argv.every((token, index) => token === (index === 0 && tokens[index] === "ctx" ? "context" : tokens[index]))) matched = alias;
  }
  return matched;
}

/** Resolve a native command leaf to its stable SDK operation without changing unknown paths. */
export function resolvePmCommandOperation(command: string): string {
  const normalized = command.trim().replace(/\s+/gu, " ");
  const tokens = normalized.split(" ");
  const alias = findPmNamespacedCommand(tokens);
  return alias ? [alias.alias, ...tokens.slice(alias.canonical_argv.length)].join(" ") : normalized;
}

/** Compatibility entrypoint for hosts that adopted namespace resolution with history. */
export function resolvePmHistoryOperation(command: string): string {
  return resolvePmCommandOperation(command);
}

/**
 * Public command-alias table. Deprecated aliases must remain executable but
 * are intentionally absent from default help and completion discovery.
 */
export const PM_COMMAND_ALIAS_CONTRACTS: readonly PmCommandAliasContract[] = [
  ...PM_NAMESPACED_COMMAND_ALIASES,
  ...[
    ["start-task", "claim", "--start"],
    ["pause-task", "release", "--pause"],
    ["close-task", "close", "--release-assignment"],
  ].map(([alias, canonical, flag]): PmCommandAliasContract => ({
    alias,
    canonical,
    canonical_argv: [canonical, flag],
    lifecycle: "deprecated",
    hidden: true,
    registration: "commander",
    owner: "pm-eq4x",
  })),
  {
    alias: "tests",
    canonical: "item test",
    canonical_argv: ["item", "test"],
    lifecycle: "permanent",
    hidden: false,
    registration: "bootstrap",
    owner: "pm-u4t9gp",
  },
  ...(
    [
      ["fetch", "get"],
      ["read", "get"],
      ["show", "get"],
      ["view", "get"],
      ["comment", "comments"],
      ["note", "notes"],
      ["learning", "learnings"],
    ] as const
  ).map(([alias, canonical]) => ({
    alias,
    canonical: ["comments", "notes", "learnings"].includes(canonical) ? `item ${canonical}` : canonical,
    canonical_argv: ["comments", "notes", "learnings"].includes(canonical) ? ["item", canonical] : [canonical],
    lifecycle: "permanent" as const,
    hidden: false,
    registration: "bootstrap" as const,
    owner: "pm-pbyu",
  })),
  ...(
    [
      ["extension list", "extension catalog"],
      ["extension scaffold", "extension init"],
      ["package list", "package catalog"],
      ["package scaffold", "package init"],
      ["packages list", "packages catalog"],
      ["packages scaffold", "packages init"],
    ] as const
  ).map(([alias, canonical]) => ({
    alias,
    canonical,
    canonical_argv: canonical.split(" "),
    lifecycle: "permanent" as const,
    hidden: false,
    registration: "commander" as const,
    owner: "pm-ya7x55",
  })),
  {
    alias: "list-all",
    canonical: "list",
    canonical_argv: ["list", "--all"],
    lifecycle: "deprecated",
    hidden: true,
    registration: "commander",
    owner: "pm-pfqi",
  },
  ...(
    [
      ["list-draft", "draft"],
      ["list-open", "open"],
      ["list-in-progress", "in_progress"],
      ["list-blocked", "blocked"],
      ["list-closed", "closed"],
      ["list-canceled", "canceled"],
    ] as const
  ).map(([alias, status]) => ({
    alias,
    canonical: "list",
    canonical_argv: ["list", "--status", status] as const,
    lifecycle: "deprecated" as const,
    hidden: true,
    registration: "commander" as const,
    owner: "pm-pfqi",
  })),
  ...(
    [
      ["extension", "package"],
      ["install", "package install"],
      ["upgrade", "package upgrade"],
    ] as const
  ).map(([alias, canonical]) => ({
    alias,
    canonical,
    canonical_argv: canonical.split(" "),
    lifecycle: "deprecated" as const,
    hidden: true,
    registration: "commander" as const,
    owner: "pm-tnud",
  })),
];

/** High-frequency executable aliases whose targets accept identical arguments. */
export const EXECUTABLE_COMMAND_ALIASES: Readonly<Record<string, string>> =
  Object.fromEntries(
    PM_COMMAND_ALIAS_CONTRACTS.filter(
      (contract) => contract.registration === "bootstrap",
    ).map((contract) => [contract.alias, contract.canonical]),
  );

/** Resolve one declared command alias without inferring from its spelling. */
export function resolvePmCommandAlias(
  alias: string,
): PmCommandAliasContract | undefined {
  const normalized = alias.trim().toLowerCase();
  return PM_COMMAND_ALIAS_CONTRACTS.find(
    (contract) => contract.alias === normalized,
  );
}

/** Render the stable one-line migration hint emitted for deprecated aliases. */
export function renderPmCommandAliasMigrationHint(
  contract: PmCommandAliasContract,
): string {
  return `Deprecated command \`${contract.alias}\`; use \`pm ${contract.canonical_argv.join(" ")}\`.`;
}
