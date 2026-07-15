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
