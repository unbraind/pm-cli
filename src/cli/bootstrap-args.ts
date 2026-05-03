function parseBootstrapPathToken(
  token: string,
  next: string | undefined,
): { consumed: number; pathValue?: string } | null {
  if (token === "--path") {
    if (typeof next === "string" && next.length > 0) {
      return {
        consumed: 2,
        pathValue: next,
      };
    }
    return {
      consumed: 1,
    };
  }

  if (!token.startsWith("--path=")) {
    return null;
  }

  const value = token.slice("--path=".length);
  if (value.length > 0) {
    return {
      consumed: 1,
      pathValue: value,
    };
  }
  return {
    consumed: 1,
  };
}

export interface BootstrapGlobalOptions {
  path?: string;
  noExtensions: boolean;
  noPager: boolean;
  json: boolean;
  quiet: boolean;
}

export function parseBootstrapGlobalOptions(argv: string[]): BootstrapGlobalOptions {
  let pathValue: string | undefined;
  let noExtensions = false;
  let noPager = false;
  let json = false;
  let quiet = false;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (token === "--no-extensions") {
      noExtensions = true;
      index += 1;
      continue;
    }
    if (token === "--no-pager") {
      noPager = true;
      index += 1;
      continue;
    }
    if (token === "--json") {
      json = true;
      index += 1;
      continue;
    }
    if (token === "--quiet") {
      quiet = true;
      index += 1;
      continue;
    }
    const parsedPath = parseBootstrapPathToken(token, argv[index + 1]);
    if (parsedPath) {
      if (parsedPath.pathValue !== undefined) {
        pathValue = parsedPath.pathValue;
      }
      index += parsedPath.consumed;
      continue;
    }
    index += 1;
  }
  return {
    path: pathValue,
    noExtensions,
    noPager,
    json,
    quiet,
  };
}

export function stripGlobalBootstrapTokens(argv: string[]): string[] {
  const remaining: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (
      token === "--json" ||
      token === "--quiet" ||
      token === "--no-extensions" ||
      token === "--no-pager" ||
      token === "--profile" ||
      token === "--explain"
    ) {
      index += 1;
      continue;
    }
    if (token === "--path") {
      index += 2;
      continue;
    }
    if (token.startsWith("--path=")) {
      index += 1;
      continue;
    }
    remaining.push(token);
    index += 1;
  }
  return remaining;
}

export interface BootstrapHelpRequest {
  requested: boolean;
  commandPathTokens: string[];
}

export function parseBootstrapHelpRequest(argv: string[]): BootstrapHelpRequest {
  const stripped = stripGlobalBootstrapTokens(argv);
  const first = stripped[0]?.trim().toLowerCase();
  if (first === "help") {
    const commandPathTokens: string[] = [];
    for (let index = 1; index < stripped.length; index += 1) {
      const token = stripped[index];
      if (token.startsWith("-")) {
        break;
      }
      commandPathTokens.push(token.trim().toLowerCase());
    }
    return {
      requested: true,
      commandPathTokens,
    };
  }

  const helpFlagIndex = stripped.findIndex((token) => token === "--help" || token === "-h");
  if (helpFlagIndex < 0) {
    return {
      requested: false,
      commandPathTokens: [],
    };
  }

  const commandPathTokens: string[] = [];
  for (const token of stripped) {
    if (token.startsWith("-")) {
      break;
    }
    commandPathTokens.push(token.trim().toLowerCase());
  }
  return {
    requested: true,
    commandPathTokens,
  };
}

export function parseBootstrapCommandName(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (token === "--path") {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--path=") ||
      token === "--json" ||
      token === "--quiet" ||
      token === "--no-extensions" ||
      token === "--no-pager" ||
      token === "--profile" ||
      token === "--explain"
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token.trim().toLowerCase();
  }
  return undefined;
}

function shouldDisablePagerForInvocation(argv: string[], bootstrapGlobal: BootstrapGlobalOptions): boolean {
  if (bootstrapGlobal.noPager) {
    return true;
  }
  if (process.stdout.isTTY === true) {
    return false;
  }
  const helpRequest = parseBootstrapHelpRequest(argv);
  return helpRequest.requested;
}

export function applyBootstrapPagerPolicy(argv: string[]): void {
  const bootstrapGlobal = parseBootstrapGlobalOptions(argv);
  if (!shouldDisablePagerForInvocation(argv, bootstrapGlobal)) {
    return;
  }
  process.env.PAGER = "cat";
  process.env.MANPAGER = "cat";
  process.env.GIT_PAGER = "cat";
  if (typeof process.env.LESS !== "string" || process.env.LESS.trim().length === 0) {
    process.env.LESS = "FRX";
  }
}

type ExtensionSubcommandAction =
  | "init"
  | "install"
  | "uninstall"
  | "explore"
  | "manage"
  | "doctor"
  | "adopt"
  | "adopt-all"
  | "activate"
  | "deactivate";

const EXTENSION_ACTION_SYNTAX_TOKENS = new Set<ExtensionSubcommandAction>([
  "install",
  "uninstall",
  "explore",
  "manage",
  "doctor",
  "adopt",
  "adopt-all",
  "activate",
  "deactivate",
]);

export function normalizeLegacyExtensionActionSyntax(argv: string[]): string[] {
  const extensionIndex = argv.findIndex((token) => token === "extension");
  if (extensionIndex < 0) {
    return [...argv];
  }
  const actionToken = argv[extensionIndex + 1];
  if (!actionToken || actionToken.startsWith("-")) {
    return [...argv];
  }
  if (!EXTENSION_ACTION_SYNTAX_TOKENS.has(actionToken as ExtensionSubcommandAction)) {
    return [...argv];
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return [...argv];
  }
  const forcedActionFlag = `--${actionToken}`;
  if (argv.includes(forcedActionFlag)) {
    return [...argv];
  }
  return [...argv.slice(0, extensionIndex + 1), forcedActionFlag, ...argv.slice(extensionIndex + 2)];
}

export function parseBootstrapTypeValue(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--type") {
      const candidate = argv[index + 1];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
      continue;
    }
    if (token.startsWith("--type=")) {
      const candidate = token.slice("--type=".length).trim();
      if (candidate.length > 0) {
        return candidate;
      }
    }
  }
  return undefined;
}
