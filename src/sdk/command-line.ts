/**
 * @module sdk/command-line
 *
 * Renders copy-safe pm command suggestions for SDK and CLI diagnostics.
 */
import { findBootstrapCommandTokenIndex } from "./cli-contracts/bootstrap-command-scanner.js";

export { quoteWindowsCommandArg, quoteCommandArg, renderPmCommand } from "../core/shared/command-line.js";

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
