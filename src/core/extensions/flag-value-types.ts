/**
 * Canonical coercion kinds an extension flag can declare via `value_type`
 * (or the deprecated `type` alias). The runtime also accepts a few common
 * aliases (`int`/`integer`/`float` -> number, `bool` -> boolean) so author
 * intent is honored without surprises.
 */
export type FlagValueKind = "string" | "number" | "boolean";

const FLAG_VALUE_KIND_BY_ALIAS: Readonly<Record<string, FlagValueKind>> = Object.freeze({
  string: "string",
  number: "number",
  int: "number",
  integer: "number",
  float: "number",
  boolean: "boolean",
  bool: "boolean",
});

/**
 * Resolve a declared flag value type (string) to its canonical kind, or `null`
 * when it is not a recognized type/alias. Matching is trim- and
 * case-insensitive.
 */
export function resolveFlagValueKind(raw: unknown): FlagValueKind | null {
  if (typeof raw !== "string") {
    return null;
  }
  return FLAG_VALUE_KIND_BY_ALIAS[raw.trim().toLowerCase()] ?? null;
}

/**
 * Whether a scalar flag default would cleanly coerce under the declared kind,
 * mirroring the runtime coercion rules in `coerceLooseCommandOptionsWithFlagDefinitions`.
 * Used to reject contradictory definitions (e.g. `value_type: "number"` with
 * `default: "abc"`) at registration instead of letting an untyped value pass
 * through to activation.
 */
export function isFlagDefaultValueCoercible(value: string | number | boolean, kind: FlagValueKind): boolean {
  if (kind === "string") {
    return true;
  }
  if (kind === "number") {
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value));
  }
  if (typeof value === "boolean") {
    return true;
  }
  return typeof value === "string" && ["true", "false", "1", "0"].includes(value.trim().toLowerCase());
}
