/**
 * @module sdk/command-line
 *
 * Renders copy-safe pm command suggestions for SDK and CLI diagnostics.
 */

/** Quote one command argument only when platform shell-significant characters require it. */
export function quoteCommandArg(
  arg: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (
    (platform === "win32"
      ? /^[A-Za-z0-9._:/\\@=-]+$/
      : /^[A-Za-z0-9._:/@=-]+$/
    ).test(arg)
  ) {
    return arg;
  }
  if (platform === "win32") {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Render a complete pm command from already-tokenized arguments. */
export function renderPmCommand(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const args = argv.map((token) => quoteCommandArg(token, platform)).join(" ");
  return args.length > 0 ? `pm ${args}` : "pm";
}
