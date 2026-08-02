/**
 * @module sdk/command-line
 *
 * Renders copy-safe pm command suggestions for SDK and CLI diagnostics.
 */

/** Quote one Windows argument with the linear CommandLineToArgvW escaping algorithm. */
export const quoteWindowsCommandArg = (arg: string): string => {
  let escaped = '"';
  let pendingBackslashes = 0;
  for (const character of arg) {
    if (character === "\\") {
      pendingBackslashes += 1;
      continue;
    }
    escaped += "\\".repeat(
      character === '"' ? pendingBackslashes * 2 + 1 : pendingBackslashes,
    );
    escaped += character;
    pendingBackslashes = 0;
  }
  return `${escaped}${"\\".repeat(pendingBackslashes * 2)}"`;
};

/** Quote one command argument only when platform shell-significant characters require it. */
export const quoteCommandArg = (
  arg: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const safePattern =
    platform === "win32" ? /^[A-Za-z0-9._:/\\@=-]+$/ : /^[A-Za-z0-9._:/@=-]+$/;
  if (safePattern.test(arg)) {
    return arg;
  }
  if (platform === "win32") {
    return quoteWindowsCommandArg(arg);
  }
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
};

/** Render a complete pm command from already-tokenized arguments. */
export const renderPmCommand = (
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): string => {
  const args = argv.map((token) => quoteCommandArg(token, platform)).join(" ");
  return args.length > 0 ? `pm ${args}` : "pm";
};

const HISTORY_REDACT_SENSITIVE_FLAGS = new Set([
  "--literal",
  "--regex",
  "--replacement",
]);

/**
 * Replace history-redaction matcher and replacement values before an argv
 * vector is copied into diagnostics or recovery guidance. The values are
 * inputs to a disclosure-removal operation and therefore remain sensitive
 * even when they do not resemble a conventional credential.
 */
export function redactSensitiveCommandArgs(argv: readonly string[]): string[] {
  if (!argv.includes("history-redact")) {
    return [...argv];
  }
  const redacted: string[] = [];
  let redactNext = false;
  for (const token of argv) {
    if (redactNext && !token.startsWith("-")) {
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
