/**
 * @module Whether a stored custom field flag or alias is exactly one option
 * spelling (pm-8patuh). Dependency-free, because CLI registration consults it
 * on every invocation that registers runtime field options.
 */

/** A stored token with exactly one leading dash is a short flag (`-x`); stored long flags carry no dashes. */
export function isShortFieldFlagSpelling(token: string): boolean {
  const trimmed = token.trim();
  return trimmed.startsWith("-") && !trimmed.startsWith("--");
}

/**
 * Characters the option parser reads as a break between two spellings (space,
 * pipe, comma) or as a value placeholder (`<`, `>`, `[`, `]`), and `=`, which
 * a command line can never spell inside a flag name because it attaches a
 * value.
 */
const FLAG_SPELLING_BREAK = /[\s|,=<>[\]]/u;

/**
 * Why a stored flag or alias token is not exactly one option spelling, or
 * `undefined` when it is. Tokens are stored without their leading `--`; a
 * token with one leading dash registers as a short flag, which the parser
 * accepts only as one dash and one character. A token the parser would split
 * (`full|detail`) registers a second option or fails the command before it
 * starts.
 */
export function describeFieldFlagSpellingDefect(token: string): string | undefined {
  const spelling = token.trim();
  if (isShortFieldFlagSpelling(spelling)) {
    return spelling.length === 2 && !FLAG_SPELLING_BREAK.test(spelling[1]!) ? undefined : "is not a short flag: a short flag is one dash and one character";
  }
  const name = spelling.replace(/^--/u, "");
  if (name.length === 0) return "is empty";
  if (name.startsWith("-")) return "starts with three dashes";
  // The parser camel-cases a long flag across hyphens and fails on an empty segment.
  if (name.endsWith("-") || name.includes("--")) return "has an empty segment between hyphens, which the option parser cannot turn into an option key";
  const separator = FLAG_SPELLING_BREAK.exec(name)?.[0];
  if (separator === undefined) return undefined;
  return /\s/u.test(separator)
    ? "contains whitespace, which the option parser reads as a break between two flags"
    : `contains ${JSON.stringify(separator)}, which the option parser reads as ${separator === "|" || separator === "," ? "a break between two flags" : separator === "=" ? "the start of an attached value" : "a value placeholder"}`;
}


/**
 * Spellings of the help option the parser adds to every command without
 * listing it among the command's options, as stored without leading dashes.
 */
const IMPLICIT_HELP_SPELLINGS: ReadonlySet<string> = new Set(["-h", "help"]);

/**
 * Whether the CLI registers a stored field flag or alias as an option: it is
 * one option spelling and not the implicit help option. Registration and
 * recovery routes share this, so a retry never names a skipped spelling.
 */
export function isRegistrableFieldFlagSpelling(token: string): boolean {
  const spelling = token.trim();
  return describeFieldFlagSpellingDefect(spelling) === undefined && !IMPLICIT_HELP_SPELLINGS.has(spelling.replace(/^--/u, ""));
}
