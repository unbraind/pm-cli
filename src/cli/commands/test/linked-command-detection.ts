// Pure, leaf-level helpers for detecting how linked-test shell commands invoke
// the pm CLI (directly, via npx/pnpm/npm exec, or a launcher subcommand) and for
// pulling structured context (subcommand, referenced item ids, runner) out of a
// normalized command string. Extracted from test.ts to keep that command file
// under the per-file LOC budget; consumers re-export these from test.ts so no
// caller outside test.ts changes.

export const PM_GLOBAL_FLAGS_WITH_VALUE = new Set(["--path"]);
export const NPX_FLAGS_WITH_VALUE = new Set(["-p", "--package", "-c", "--call"]);
export const PNPM_GLOBAL_FLAGS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--config",
  "--dir",
  "--filter",
  "--workspace-dir",
]);
export const NPM_GLOBAL_FLAGS_WITH_VALUE = new Set(["-C", "--prefix", "--userconfig", "--cache"]);
export const YARN_GLOBAL_FLAGS_WITH_VALUE = new Set(["--cwd"]);
export const BUN_GLOBAL_FLAGS_WITH_VALUE = new Set(["--cwd"]);
export const NPM_EXEC_SUBCOMMANDS = new Set(["exec", "x"]);
export const SCRIPT_RUN_SUBCOMMANDS = new Set(["run", "run-script"]);
export const SCRIPT_RUN_FLAGS_WITH_VALUE = new Set(["-C", "--dir", "--cwd", "-w", "--workspace", "--filter"]);

export function splitNormalizedCommandSegments(normalizedCommand: string): string[] {
  return normalizedCommand
    .split(/&&|\|\||\||;/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

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

export function normalizePackageSpecifier(token: string): string {
  const trimmed = token.trim();
  if (!trimmed.startsWith("@")) {
    const versionSeparator = trimmed.indexOf("@");
    return versionSeparator === -1 ? trimmed : trimmed.slice(0, versionSeparator);
  }
  const scopeSeparator = trimmed.indexOf("/");
  if (scopeSeparator === -1) {
    return trimmed;
  }
  const versionSeparator = trimmed.indexOf("@", scopeSeparator + 1);
  return versionSeparator === -1 ? trimmed : trimmed.slice(0, versionSeparator);
}

export function isPmCliPackageToken(token: string): boolean {
  const normalizedSpecifier = normalizePackageSpecifier(token);
  return (
    normalizedSpecifier === "pm-cli" ||
    normalizedSpecifier.endsWith("/pm-cli") ||
    token === "pm-cli" ||
    token.endsWith("/pm-cli")
  );
}

export function isPmCliScriptToken(token: string): boolean {
  return token === "dist/cli.js" || token === "./dist/cli.js" || token.endsWith("/dist/cli.js");
}

export function parseNpxCommand(tokens: string[]): { command: string; args: string[] } | null {
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
    if (token.includes("=")) {
      index += 1;
      continue;
    }
    if (NPX_FLAGS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    index += 1;
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

export function parsePnpmDlxCommand(tokens: string[]): { command: string; args: string[] } | null {
  const parsed = parseLauncherSubcommand(tokens, PNPM_GLOBAL_FLAGS_WITH_VALUE);
  if (parsed?.subcommand !== "dlx") {
    return null;
  }
  return parseNpxCommand(parsed.args);
}

export function parseNpmExecCommand(tokens: string[]): { command: string; args: string[] } | null {
  const parsed = parseLauncherSubcommand(tokens, NPM_GLOBAL_FLAGS_WITH_VALUE);
  if (!parsed || !NPM_EXEC_SUBCOMMANDS.has(parsed.subcommand)) {
    return null;
  }
  return parseNpxCommand(parsed.args);
}

export function resolvePmSubcommandContext(args: string[]): { subcommand: string; remaining: string[] } | null {
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

export function firstPositionalToken(tokens: string[]): string | undefined {
  for (const token of tokens) {
    if (!token.startsWith("-")) {
      return token;
    }
  }
  return undefined;
}
