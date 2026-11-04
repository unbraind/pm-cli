/** @module core/item/literal-mutation-input Tracks SDK data provenance without serializing transport policy. */
const literalInputs = new WeakSet<object>();
const literalFields = new WeakMap<object, ReadonlySet<PropertyKey>>();
const cliInputs = new WeakSet<object>();

/** Opt a CLI adapter into its explicit stdin and legacy clear-token grammar. */
export function markCliMutationInput<T extends object>(input: T): T {
  cliInputs.add(input);
  return input;
}

/** Identify options decoded by a CLI adapter rather than a typed SDK caller. */
export function isCliMutationInput(input: object): boolean {
  return cliInputs.has(input);
}

/** Keep SDK option strings and collection entries separate from CLI clear tokens. */
export function preserveLiteralMutationInput<T extends object>(input: T): T {
  literalInputs.add(input);
  for (const [key, value] of Object.entries(input)) {
    if (!Array.isArray(value)) continue;
    const owned = [...value];
    Reflect.set(input, key, owned);
    literalInputs.add(owned);
  }
  return input;
}

/** Identify data whose sentinel spellings must pass through ordinary domain validation. */
export function isLiteralMutationInput(input: object, field?: PropertyKey): boolean {
  return literalInputs.has(input) || (field !== undefined && literalFields.get(input)?.has(field) === true);
}

/** Mark document-derived fields without changing the interpretation of explicit CLI overrides. */
export function preserveLiteralMutationInputFields<T extends object>(input: T, fields: Iterable<PropertyKey>): T {
  const selected = new Set(fields);
  literalFields.set(input, selected);
  for (const field of selected) {
    const value: unknown = Reflect.get(input, field);
    if (!Array.isArray(value)) continue;
    const owned = [...value];
    Reflect.set(input, field, owned);
    literalInputs.add(owned);
  }
  return input;
}

/** Preserve literal-data provenance when an internal adapter clones an option bag. */
export function transferLiteralMutationInput<T extends object>(source: object, target: T): T {
  if (isCliMutationInput(source)) markCliMutationInput(target);
  if (isLiteralMutationInput(source)) return preserveLiteralMutationInput(target);
  const fields = literalFields.get(source);
  return fields ? preserveLiteralMutationInputFields(target, fields) : target;
}

/** Vocabulary a mutation refusal uses: CLI flags, or the option keys a typed SDK or MCP caller passed (GH-1655). */
export type MutationInputAudience = "cli" | "sdk";

/**
 * Who supplied a resolved option bag. Typed SDK and MCP input is marked literal
 * before resolution and keeps that mark; a CLI adapter's bag never carries it.
 */
export function mutationInputAudience(input: object): MutationInputAudience {
  return isLiteralMutationInput(input) ? "sdk" : "cli";
}

/** Name an option for its caller: `--blocked-by` on the CLI, `blockedBy` for SDK and MCP callers. */
export function mutationOptionLabel(audience: MutationInputAudience, flag: string): string {
  return audience === "cli" ? `--${flag}` : flag.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

/**
 * The remedy that clears one scalar field for typed SDK and MCP callers, named
 * by its `unset` token: the one clear form both transports accept (MCP has no
 * typed null). The CLI keeps its own wording at each call site.
 */
export function sdkClearRemedy(unsetToken: string): string {
  return `Pass unset: ["${unsetToken}"] to clear it`;
}

/** Refusal text for an empty scalar option: the CLI wording unchanged, or the SDK option key and its clear remedy. */
export function emptyMutationOptionMessage(audience: MutationInputAudience, flag: string, cliRemedy = ""): string {
  return audience === "cli"
    ? `--${flag} must not be empty${cliRemedy}`
    : `${mutationOptionLabel("sdk", flag)} must not be empty. ${sdkClearRemedy(flag)}, or omit ${mutationOptionLabel("sdk", flag)}.`;
}
