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

/**
 * Public command-alias table. Deprecated aliases must remain executable but
 * are intentionally absent from default help and completion discovery.
 */
export const PM_COMMAND_ALIAS_CONTRACTS: readonly PmCommandAliasContract[] = [
  {
    alias: "tests",
    canonical: "test",
    canonical_argv: ["test"],
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
    canonical,
    canonical_argv: [canonical] as const,
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
