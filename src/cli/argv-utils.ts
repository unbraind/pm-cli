export function normalizeLongFlag(flag: string): string {
  return `--${flag
    .replace(/^--?/, "")
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()}`;
}

export function normalizeLongOptionFlag(token: string): string | undefined {
  if (!token.startsWith("--")) {
    return undefined;
  }
  const key = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  return normalizeLongFlag(key);
}

export function extractProvidedOptionFlags(argv: string[]): string[] {
  const provided = new Set<string>();
  const ordered: string[] = [];
  for (const token of argv) {
    const normalized = normalizeLongOptionFlag(token);
    if (normalized) {
      if (!provided.has(normalized)) {
        ordered.push(normalized);
      }
      provided.add(normalized);
    }
  }
  return ordered;
}

export function quoteCommandArg(arg: string): string {
  if (/^[A-Za-z0-9._:/@=-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function renderPmCommand(argv: string[]): string {
  return `pm ${argv.map((token) => quoteCommandArg(token)).join(" ")}`;
}
