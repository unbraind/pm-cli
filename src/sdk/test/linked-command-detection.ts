/**
 * @module sdk/test/linked-command-detection
 *
 * Parses linked-test command invocations for sandbox and context-safety checks.
 */
// Pure, leaf-level helpers for detecting how linked-test shell commands invoke
// the pm CLI (directly, via npx/pnpm/npm exec, or a launcher subcommand) and for
// pulling structured context (subcommand, referenced item ids, runner) out of a
// normalized command string. Kept in core so SDK governance and CLI test
// execution share one dependency-direction-safe parser.

const PM_SUBCOMMANDS_WITH_ITEM_REFERENCE = new Set([
  "get",
  "history",
  "restore",
  "update",
  "close",
  "delete",
  "append",
  "claim",
  "release",
  "comments",
  "notes",
  "learnings",
  "files",
  "docs",
  "deps",
  "test",
]);

/** Public contract for pm global flags with value, shared by SDK and presentation-layer consumers. */
export const PM_GLOBAL_FLAGS_WITH_VALUE = new Set([
  "--pm-path",
  "--path",
  "--author",
]);
/** Value-bearing flags accepted before item positionals by item-referencing commands. */
export const PM_ITEM_REFERENCE_FLAGS_WITH_VALUE: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  get: new Set([
    "--depth",
    "--fields",
    "--tree-depth",
    "--tree_depth",
    "--at",
    "--format",
  ]),
  history: new Set(["--limit", "--field", "--format"]),
  restore: new Set(["--message"]),
  update: new Set([
    "--title",
    "-t",
    "--description",
    "-d",
    "--body",
    "-b",
    "--status",
    "-s",
    "--close-reason",
    "--close_reason",
    "--priority",
    "-p",
    "--type",
    "--tags",
    "--add-tags",
    "--add_tags",
    "--remove-tags",
    "--remove_tags",
    "--deadline",
    "--estimated-minutes",
    "--estimate",
    "--estimated_minutes",
    "--acceptance-criteria",
    "--ac",
    "--acceptance_criteria",
    "--definition-of-ready",
    "--definition_of_ready",
    "--order",
    "--rank",
    "--goal",
    "--objective",
    "--value",
    "--impact",
    "--outcome",
    "--why-now",
    "--why_now",
    "--message",
    "--assignee",
    "--parent",
    "--reviewer",
    "--risk",
    "--confidence",
    "--sprint",
    "--release",
    "--blocked-by",
    "--blocked_by",
    "--blocked-reason",
    "--blocked_reason",
    "--unblock-note",
    "--unblock_note",
    "--reporter",
    "--severity",
    "--environment",
    "--repro-steps",
    "--repro_steps",
    "--resolution",
    "--expected-result",
    "--expected_result",
    "--expected",
    "--actual-result",
    "--actual_result",
    "--actual",
    "--affected-version",
    "--affected_version",
    "--fixed-version",
    "--fixed_version",
    "--component",
    "--regression",
    "--customer-impact",
    "--customer_impact",
    "--dep",
    "--dep-remove",
    "--dep_remove",
    "--comment",
    "--note",
    "--learning",
    "--file",
    "--test",
    "--doc",
    "--reminder",
    "--event",
    "--type-option",
    "--type_option",
    "--field",
    "--unset",
    "--body-file",
  ]),
  close: new Set([
    "--reason",
    "-r",
    "--close-reason",
    "--duplicate-of",
    "-d",
    "--message",
    "-m",
    "--validate-close",
    "--resolution",
    "--expected-result",
    "--expected_result",
    "--expected",
    "--actual-result",
    "--actual_result",
    "--actual",
  ]),
  delete: new Set(["--message"]),
  append: new Set(["--body", "--text", "--message"]),
  claim: new Set([
    "--assignee",
    "--message",
    "--type",
    "--tag",
    "--priority",
    "--assignee-filter",
    "--parent",
    "--sprint",
    "--release",
    "--max-attempts",
  ]),
  release: new Set(["--assignee", "--message"]),
  comments: new Set([
    "--add",
    "--body",
    "--comment",
    "--file",
    "--edit",
    "--delete",
    "--limit",
    "--message",
  ]),
  notes: new Set([
    "--add",
    "--file",
    "--edit",
    "--delete",
    "--limit",
    "--message",
  ]),
  learnings: new Set([
    "--add",
    "--file",
    "--edit",
    "--delete",
    "--limit",
    "--message",
  ]),
  files: new Set([
    "--add",
    "--add-glob",
    "--remove",
    "--migrate",
    "--note",
    "--message",
  ]),
  docs: new Set([
    "--add",
    "--add-glob",
    "--remove",
    "--migrate",
    "--note",
    "--message",
  ]),
  deps: new Set([
    "--format",
    "--max-depth",
    "--collapse",
    "--node-limit",
    "--edge-limit",
    "--token-budget",
    "--cursor",
  ]),
  test: new Set([
    "--add",
    "--add-json",
    "--remove",
    "--match",
    "--only-index",
    "--timeout",
    "--env-set",
    "--env-clear",
    "--pm-context",
    "--message",
  ]),
};
/** Public contract for npx flags with value, shared by SDK and presentation-layer consumers. */
export const NPX_FLAGS_WITH_VALUE = new Set(["-p", "--package"]);
/** Public contract for npx flags whose value is the command string itself. */
export const NPX_COMMAND_STRING_FLAGS = new Set(["-c", "--call"]);
/** Public contract for pnpm global flags with value, shared by SDK and presentation-layer consumers. */
export const PNPM_GLOBAL_FLAGS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--config",
  "--dir",
  "--filter",
  "--workspace-dir",
]);
/** Public contract for npm global flags with value, shared by SDK and presentation-layer consumers. */
export const NPM_GLOBAL_FLAGS_WITH_VALUE = new Set([
  "-C",
  "--prefix",
  "--userconfig",
  "--cache",
]);
/** Public contract for yarn global flags with value, shared by SDK and presentation-layer consumers. */
export const YARN_GLOBAL_FLAGS_WITH_VALUE = new Set(["--cwd"]);
/** Public contract for bun global flags with value, shared by SDK and presentation-layer consumers. */
export const BUN_GLOBAL_FLAGS_WITH_VALUE = new Set(["--cwd"]);
/** Public contract for npm exec subcommands, shared by SDK and presentation-layer consumers. */
export const NPM_EXEC_SUBCOMMANDS = new Set(["exec", "x"]);
/** Public contract for script run subcommands, shared by SDK and presentation-layer consumers. */
export const SCRIPT_RUN_SUBCOMMANDS = new Set(["run", "run-script"]);
/** Public contract for script run flags with value, shared by SDK and presentation-layer consumers. */
export const SCRIPT_RUN_FLAGS_WITH_VALUE = new Set([
  "-C",
  "--dir",
  "--cwd",
  "-w",
  "--workspace",
  "--filter",
]);

/** Implements split normalized command segments for the public runtime surface of this module. */
export function splitNormalizedCommandSegments(
  normalizedCommand: string,
): string[] {
  return normalizedCommand
    .split(/&&|\|\||\||;/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Extract pm CLI arguments from one normalized shell-command segment. */
export function extractPmInvocationArgsFromSegment(
  segment: string,
): string[] | null {
  const tokens = stripLeadingEnvAssignments(
    segment.split(" ").filter((token) => token.length > 0),
  );
  if (tokens.length === 0) return null;
  const [executable, ...args] = tokens;
  if (isPmExecutableToken(executable) || isPmCliScriptToken(executable)) {
    return args;
  }
  if (executable === "node" && args[0] && isPmCliScriptToken(args[0])) {
    return args.slice(1);
  }
  const invocation =
    executable === "npx" || executable === "bunx"
      ? parseNpxCommand(args)
      : executable === "pnpm"
        ? parsePnpmDlxCommand(args)
        : executable === "npm"
          ? parseNpmExecCommand(args)
          : null;
  return invocation &&
    (isPmExecutableToken(invocation.command) ||
      isPmCliPackageToken(invocation.command))
    ? invocation.args
    : null;
}

/** Extract referenced item IDs from pm CLI invocations embedded in one command. */
export const extractReferencedPmItemIdsFromCommand = (
  command: string,
  idPrefix = "pm",
): string[] => {
  const normalizedPrefix = idPrefix.trim().toLowerCase().replace(/-+$/, "");
  if (normalizedPrefix.length === 0) return [];
  const normalizedCommand = command
    .trim()
    .replaceAll("\\", "/")
    .replaceAll('"', "")
    .replaceAll("'", "")
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
  const ids = new Set<string>();
  for (const segment of splitNormalizedCommandSegments(normalizedCommand)) {
    const invocationArgs = extractPmInvocationArgsFromSegment(segment);
    const context = invocationArgs
      ? resolvePmSubcommandContext(invocationArgs)
      : null;
    const candidate =
      context && PM_SUBCOMMANDS_WITH_ITEM_REFERENCE.has(context.subcommand)
        ? firstPositionalToken(
            context.remaining,
            PM_ITEM_REFERENCE_FLAGS_WITH_VALUE[context.subcommand],
          )
        : undefined;
    const normalizedCandidate = candidate?.trim().toLowerCase();
    if (
      normalizedCandidate?.startsWith(`${normalizedPrefix}-`) === true &&
      normalizedCandidate.length > normalizedPrefix.length + 1
    ) {
      ids.add(candidate as string);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
};

/** Implements strip leading env assignments for the public runtime surface of this module. */
export function stripLeadingEnvAssignments(tokens: string[]): string[] {
  let start = 0;
  if (tokens[start] === "env") {
    start += 1;
  }
  while (start < tokens.length) {
    const token = tokens[start];
    if (/^(?:[a-z_][a-z0-9_]*|\$env:[a-z_][a-z0-9_]*)=.*/.test(token)) {
      start += 1;
      continue;
    }
    break;
  }
  return tokens.slice(start);
}

/** Implements first pm subcommand for the public runtime surface of this module. */
export function firstPmSubcommand(args: string[]): string | undefined {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (PM_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

/** Implements check whether pm executable token for the public runtime surface of this module. */
export function isPmExecutableToken(token: string): boolean {
  return (
    token === "pm" ||
    token === "pm.cmd" ||
    token === "pm.exe" ||
    token.endsWith("/pm") ||
    token.endsWith("/pm.cmd") ||
    token.endsWith("/pm.exe")
  );
}

/** Implements normalize package specifier for the public runtime surface of this module. */
export function normalizePackageSpecifier(token: string): string {
  const trimmed = token.trim();
  if (!trimmed.startsWith("@")) {
    const versionSeparator = trimmed.indexOf("@");
    return versionSeparator === -1
      ? trimmed
      : trimmed.slice(0, versionSeparator);
  }
  const scopeSeparator = trimmed.indexOf("/");
  if (scopeSeparator === -1) {
    return trimmed;
  }
  const versionSeparator = trimmed.indexOf("@", scopeSeparator + 1);
  return versionSeparator === -1 ? trimmed : trimmed.slice(0, versionSeparator);
}

/** Implements check whether pm cli package token for the public runtime surface of this module. */
export function isPmCliPackageToken(token: string): boolean {
  const normalizedSpecifier = normalizePackageSpecifier(token);
  return (
    normalizedSpecifier === "pm-cli" ||
    normalizedSpecifier.endsWith("/pm-cli") ||
    token === "pm-cli" ||
    token.endsWith("/pm-cli")
  );
}

/** Implements check whether pm cli script token for the public runtime surface of this module. */
export function isPmCliScriptToken(token: string): boolean {
  return (
    token === "dist/cli.js" ||
    token === "./dist/cli.js" ||
    token.endsWith("/dist/cli.js")
  );
}

/** Implements parse npx command for the public runtime surface of this module. */
export function parseNpxCommand(
  tokens: string[],
): { command: string; args: string[] } | null {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) {
      break;
    }
    const inlineCommandMatch = /^(?:-c|--call)=(.*)$/.exec(token);
    if (inlineCommandMatch) {
      const command = inlineCommandMatch[1];
      return command ? { command, args: tokens.slice(index + 1) } : null;
    }
    if (NPX_COMMAND_STRING_FLAGS.has(token)) {
      index += 1;
      break;
    }
    index += NPX_FLAGS_WITH_VALUE.has(token) && !token.includes("=") ? 2 : 1;
  }
  const command = tokens[index];
  if (!command) {
    return null;
  }
  return {
    command,
    args: tokens.slice(index + 1),
  };
}

/** Implements parse launcher subcommand for the public runtime surface of this module. */
export function parseLauncherSubcommand(
  tokens: string[],
  flagsWithValue: Set<string>,
): { subcommand: string; args: string[] } | null {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (token.includes("=")) {
        index += 1;
        continue;
      }
      if (flagsWithValue.has(token)) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    return {
      subcommand: token,
      args: tokens.slice(index + 1),
    };
  }
  return null;
}

/** Implements parse pnpm dlx command for the public runtime surface of this module. */
export function parsePnpmDlxCommand(
  tokens: string[],
): { command: string; args: string[] } | null {
  const parsed = parseLauncherSubcommand(tokens, PNPM_GLOBAL_FLAGS_WITH_VALUE);
  if (parsed?.subcommand !== "dlx") {
    return null;
  }
  return parseNpxCommand(parsed.args);
}

/** Implements parse npm exec command for the public runtime surface of this module. */
export function parseNpmExecCommand(
  tokens: string[],
): { command: string; args: string[] } | null {
  const parsed = parseLauncherSubcommand(tokens, NPM_GLOBAL_FLAGS_WITH_VALUE);
  if (!parsed || !NPM_EXEC_SUBCOMMANDS.has(parsed.subcommand)) {
    return null;
  }
  return parseNpxCommand(parsed.args);
}

/** Implements resolve pm subcommand context for the public runtime surface of this module. */
export function resolvePmSubcommandContext(
  args: string[],
): { subcommand: string; remaining: string[] } | null {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (PM_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    return {
      subcommand: token,
      remaining: args.slice(index + 1),
    };
  }
  return null;
}

/** Implements first positional token for the public runtime surface of this module. */
export function firstPositionalToken(
  tokens: string[],
  flagsWithValue: ReadonlySet<string> = new Set(),
): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      return tokens[index + 1];
    }
    if (!token.startsWith("-")) {
      return token;
    }
    if (
      !token.includes("=") &&
      (PM_GLOBAL_FLAGS_WITH_VALUE.has(token) || flagsWithValue.has(token))
    ) {
      index += 1;
    }
  }
  return undefined;
}
