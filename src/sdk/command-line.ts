/**
 * @module sdk/command-line
 *
 * Renders copy-safe pm command suggestions for SDK and CLI diagnostics.
 */
import { findBootstrapCommandTokenIndex } from "./cli-contracts/bootstrap-command-scanner.js";
import path from "node:path";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { resolveImplicitPmRoot, resolvePmRoot, resolveWorkspaceRoot } from "../core/store/paths.js";
import { isPathWithinDirectory } from "../core/fs/path-utils.js";

export { quoteWindowsCommandArg, quoteCommandArg, renderPmCommand } from "../core/shared/command-line.js";

type CommandScope = Pick<GlobalOptions, "path" | "noExtensions">;
const requestedPaths = new WeakMap<CommandScope, string | undefined>();

/** Retain caller scope before runtime dispatch resolves its working storage path. */
export function capturePmCommandScope(options: CommandScope): void {
  requestedPaths.set(options, options.path);
}

/** Inspect implicit discovery only when an environment-selected workspace could actually own this cwd. */
function environmentCommandScope(cwd: string): string | undefined {
  if (!process.env.PM_PATH?.trim()) return undefined;
  const resolved = resolvePmRoot(cwd);
  return isPathWithinDirectory(resolveWorkspaceRoot(resolved), cwd) && resolved === resolveImplicitPmRoot(cwd)
    ? undefined : path.relative(cwd, resolved);
}

/** Build copy-safe tracker and extension arguments, preserving explicit spelling and omitting the implicit cwd tracker. */
export function resolvePmCommandScopeArgs(options: CommandScope, cwd = process.cwd()): string[] {
  const requested = requestedPaths.has(options) ? requestedPaths.get(options) : options.path;
  const selected = requested || environmentCommandScope(cwd);
  const args = selected ? ["--pm-path", selected] : [];
  if (options.noExtensions) args.push("--no-extensions");
  return args;
}

const HISTORY_REDACT_SENSITIVE_FLAGS = new Set([
  "--literal",
  "--regex",
  "--replacement",
]);

/** Recognize the leading redaction command after global options, even before flag validation succeeds. */
export function isHistoryRedactInvocation(
  argv: readonly string[],
): boolean {
  const rootIndex = findBootstrapCommandTokenIndex(argv);
  if (rootIndex === undefined) return false;
  if (argv[rootIndex] === "history-redact") return true;
  if (argv[rootIndex] !== "history") return false;
  const operationArgs = argv.slice(rootIndex + 1);
  const operationIndex = findBootstrapCommandTokenIndex(operationArgs);
  return operationIndex !== undefined && operationArgs[operationIndex] === "redact";
}

/**
 * Replace history-redaction matcher and replacement values before an argv
 * vector is copied into diagnostics or recovery guidance. The values are
 * inputs to a disclosure-removal operation and therefore remain sensitive
 * even when they do not resemble a conventional credential.
 */
export function redactSensitiveCommandArgs(
  argv: readonly string[],
): string[] {
  if (!isHistoryRedactInvocation(argv)) {
    return [...argv];
  }
  const redacted: string[] = [];
  let redactNext = false;
  for (const token of argv) {
    if (redactNext) {
      redacted.push("[redacted]");
      redactNext = false;
      continue;
    }
    redactNext = false;
    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    if (!HISTORY_REDACT_SENSITIVE_FLAGS.has(flag)) {
      redacted.push(token);
      continue;
    }
    if (equalsIndex >= 0) {
      redacted.push(`${flag}=[redacted]`);
      continue;
    }
    redacted.push(flag);
    redactNext = true;
  }
  return redacted;
}
