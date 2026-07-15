/**
 * @module sdk/command-line
 *
 * Renders copy-safe pm command suggestions for SDK and CLI diagnostics.
 */

/** Quote one command argument only when shell-significant characters require it. */
export function quoteCommandArg(arg: string): string {
  if (/^[A-Za-z0-9._:/@=-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Render a complete pm command from already-tokenized arguments. */
export function renderPmCommand(argv: string[]): string {
  const args = argv.map((token) => quoteCommandArg(token)).join(" ");
  return args.length > 0 ? `pm ${args}` : "pm";
}
