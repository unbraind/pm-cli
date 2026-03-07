const UNSAFE_LOOSE_OPTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function toLooseOptionKey(rawKey: string): string {
  const key = rawKey.trim().toLowerCase();
  return key.replaceAll(/-([a-z0-9])/g, (_match, group: string) => group.toUpperCase());
}

function setLooseOptionValue(options: Record<string, unknown>, key: string, value: unknown): void {
  const existing = options[key];
  if (existing === undefined) {
    options[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    options[key] = existing;
    return;
  }
  options[key] = [existing, value];
}

interface ParsedLooseOptionToken {
  consumed: number;
  key: string;
  value: unknown;
}

function parseLooseOptionToken(args: string[], index: number): ParsedLooseOptionToken | null {
  const token = args[index];
  if (!token.startsWith("--") || token === "--") {
    return null;
  }

  const equalsIndex = token.indexOf("=");
  if (equalsIndex >= 0) {
    return {
      consumed: 1,
      key: token.slice(2, equalsIndex).trim(),
      value: token.slice(equalsIndex + 1),
    };
  }

  if (token.startsWith("--no-")) {
    return {
      consumed: 1,
      key: token.slice(5).trim(),
      value: false,
    };
  }

  const key = token.slice(2).trim();
  const next = args[index + 1];
  if (typeof next === "string" && !next.startsWith("-")) {
    return {
      consumed: 2,
      key,
      value: next,
    };
  }
  return {
    consumed: 1,
    key,
    value: true,
  };
}

function isUnsafeLooseOptionKey(key: string): boolean {
  return UNSAFE_LOOSE_OPTION_KEYS.has(key);
}

export function parseLooseCommandOptions(args: string[]): Record<string, unknown> {
  const options = Object.create(null) as Record<string, unknown>;
  let index = 0;
  while (index < args.length) {
    const parsed = parseLooseOptionToken(args, index);
    if (!parsed) {
      index += 1;
      continue;
    }

    const normalizedKey = toLooseOptionKey(parsed.key);
    if (normalizedKey.length === 0 || isUnsafeLooseOptionKey(normalizedKey)) {
      index += parsed.consumed;
      continue;
    }
    setLooseOptionValue(options, normalizedKey, parsed.value);
    index += parsed.consumed;
  }
  return options;
}
