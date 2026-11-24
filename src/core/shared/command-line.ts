/**
 * @module core/shared/command-line
 * Quotes tokenized recovery commands for a declared shell dialect.
 *
 * Every rendered pm command (recovery `suggested_retry`, `restore_with`,
 * next-step hints) is written for one shell. `posix` is the default outside
 * Windows; on Windows the default is `cmd`, the cmd.exe / CreateProcess
 * dialect settled in pm-b24b, and `PM_COMMAND_SHELL=powershell` switches to
 * PowerShell literal quoting (pm-kjoudp, GH-1774).
 */

/** Shell a rendered pm command is quoted for. */
export type CommandShellDialect = "posix" | "cmd" | "powershell";

/** Environment variable that declares the shell rendered pm commands are pasted into. */
export const COMMAND_SHELL_ENV = "PM_COMMAND_SHELL";

/** Accepted `PM_COMMAND_SHELL` spellings; a Map, so inherited object keys never resolve. */
const COMMAND_SHELL_ALIASES: ReadonlyMap<string, CommandShellDialect> = new Map([
  ["posix", "posix"],
  ["sh", "posix"],
  ["bash", "posix"],
  ["zsh", "posix"],
  ["cmd", "cmd"],
  ["cmd.exe", "cmd"],
  ["powershell", "powershell"],
  ["pwsh", "powershell"],
]);

/**
 * The shell dialect rendered commands use: a recognized `PM_COMMAND_SHELL`
 * value wins, otherwise `cmd` on Windows and `posix` elsewhere. An empty or
 * unrecognized value keeps the platform default, so a typo never yields a
 * dialect the caller did not choose.
 */
export const resolveCommandShellDialect = (
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CommandShellDialect => {
  const declared = env[COMMAND_SHELL_ENV]?.trim().toLowerCase();
  const dialect = declared === undefined ? undefined : COMMAND_SHELL_ALIASES.get(declared);
  if (dialect !== undefined) return dialect;
  return platform === "win32" ? "cmd" : "posix";
};

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

/** cmd.exe metacharacters a caret-escaped argument prefixes with `^`, quotes included. */
const CMD_CARET_PREFIXED: ReadonlySet<string> = new Set(["(", ")", "!", "^", '"', "<", ">", "&", "|"]);

/**
 * Caret-escape a CommandLineToArgvW-quoted argument for cmd.exe. Every quote
 * is escaped, so cmd.exe never enters a quoted region and removes each caret
 * exactly once, handing CreateProcess the exact CommandLineToArgvW spelling.
 * Every `%` is immediately followed by a caret (its own, or the one escaping
 * the next metacharacter), so each text cmd.exe could read as a `%name%` or
 * `%name:modifier%` reference names a variable starting with `^`, which no
 * defined variable does; interactive and `cmd /c` percent expansion then
 * leaves it intact.
 */
export const escapeCmdMetacharacters = (quoted: string): string => {
  let rendered = "";
  for (let index = 0; index < quoted.length; index += 1) {
    const character = quoted[index]!;
    if (CMD_CARET_PREFIXED.has(character)) {
      rendered += `^${character}`;
      continue;
    }
    rendered += character;
    if (character === "%" && !CMD_CARET_PREFIXED.has(quoted.charAt(index + 1))) rendered += "^";
  }
  return rendered;
};

/**
 * cmd.exe expands `%name%` even inside double quotes, and a quote inside the
 * argument flips cmd.exe's own quote state so a later `&`, `|`, `<` or `>`
 * becomes live; only those arguments need the caret-escaped spelling.
 */
const CMD_UNSAFE_IN_QUOTES = /["%]/u;

/** Quote one argument for cmd.exe: CommandLineToArgvW quoting, caret-escaped when cmd.exe would otherwise expand or split it. */
export const quoteCmdCommandArg = (arg: string): string => {
  const quoted = quoteWindowsCommandArg(arg);
  return CMD_UNSAFE_IN_QUOTES.test(arg) ? escapeCmdMetacharacters(quoted) : quoted;
};

/** PowerShell treats the typographic single quotes as quote characters too. */
const POWERSHELL_SINGLE_QUOTE = /['\u2018\u2019\u201A\u201B]/gu;

/** Double every single quote, including the typographic ones PowerShell also accepts, for a single-quoted PowerShell string. */
export const escapePowerShellSingleQuotes = (text: string): string =>
  text.replace(POWERSHELL_SINGLE_QUOTE, "$&$&");

/**
 * Quote one argument as a PowerShell literal (single-quoted) string, where
 * `$`, `$(...)`, backticks and `%` never expand.
 */
export const quotePowerShellCommandArg = (arg: string): string =>
  `'${escapePowerShellSingleQuotes(arg)}'`;

/** Bare tokens each dialect passes through unchanged. */
const SAFE_BARE_TOKEN: Readonly<Record<CommandShellDialect, RegExp>> = {
  posix: /^[A-Za-z0-9._:/@=-]+$/u,
  cmd: /^[A-Za-z0-9._:/\\@=-]+$/u,
  // A leading `@` splats in PowerShell, and a bare `--` can be consumed by the parameter binder.
  powershell: /^(?!--$)[A-Za-z0-9._:/\\=-][A-Za-z0-9._:/\\@=-]*$/u,
};

/** Quote one command argument for `dialect` (default: the declared shell for `platform`) only when its shell-significant characters require it. */
export const quoteCommandArg = (
  arg: string,
  platform: NodeJS.Platform = process.platform,
  dialect?: CommandShellDialect,
): string => {
  const shell = dialect ?? resolveCommandShellDialect(platform);
  if (SAFE_BARE_TOKEN[shell].test(arg)) {
    return arg;
  }
  if (shell === "cmd") {
    return quoteCmdCommandArg(arg);
  }
  if (shell === "powershell") {
    return quotePowerShellCommandArg(arg);
  }
  return quotePosixCommandArg(arg);
};

/**
 * Quote one argument for a POSIX shell. Double quotes with `"`, `\`, `$` and
 * backticks escaped are exact for `sh -c` and scripts; an argument holding
 * `!` is single-quoted instead, because interactive bash and zsh
 * history-expand `!` inside double quotes (pm-oq893h).
 */
export const quotePosixCommandArg = (arg: string): string =>
  arg.includes("!") ? `'${arg.replaceAll("'", "'\\''")}'` : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;

/** Render a complete pm command from already-tokenized arguments. */
export const renderPmCommand = (
  argv: string[],
  platform: NodeJS.Platform = process.platform,
  dialect?: CommandShellDialect,
): string => {
  const shell = dialect ?? resolveCommandShellDialect(platform);
  const args = argv
    .map((token) => quoteCommandArg(token, platform, shell))
    .join(" ");
  return args.length > 0 ? `pm ${args}` : "pm";
};
