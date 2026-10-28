/** @module core/item/literal-mutation-input Tracks SDK data provenance without serializing transport policy. */
const literalInputs = new WeakSet<object>();
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
  for (const value of Object.values(input)) {
    if (Array.isArray(value)) literalInputs.add(value);
  }
  return input;
}

/** Identify data whose sentinel spellings must pass through ordinary domain validation. */
export function isLiteralMutationInput(input: object): boolean {
  return literalInputs.has(input);
}

/** Preserve literal-data provenance when an internal adapter clones an option bag. */
export function transferLiteralMutationInput<T extends object>(source: object, target: T): T {
  if (isCliMutationInput(source)) markCliMutationInput(target);
  return isLiteralMutationInput(source) ? preserveLiteralMutationInput(target) : target;
}
