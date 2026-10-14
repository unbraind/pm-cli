/** Shared scalar coercion and value-token grammar for contributed flags. */
import type { FlagDefinition } from "./extension-types.js";
import { parseExtensionLongFlagToken } from "./flag-definition-validation.js";

/** Canonical scalar value kinds accepted by extension command flag definitions. */
export type FlagValueKind = "string" | "number" | "boolean";

const FLAG_VALUE_KIND_BY_ALIAS: Readonly<Record<string, FlagValueKind>> =
  Object.freeze({
    string: "string",
    number: "number",
    int: "number",
    integer: "number",
    float: "number",
    boolean: "boolean",
    bool: "boolean",
  });

/** Resolve a declared flag value type (string) to its canonical kind, or `null` when it is not a recognized type/alias. Matching is trim- and case-insensitive. */
export function resolveFlagValueKind(raw: unknown): FlagValueKind | null {
  if (typeof raw !== "string") {
    return null;
  }
  const alias = raw.trim().toLowerCase();
  return Object.hasOwn(FLAG_VALUE_KIND_BY_ALIAS, alias)
    ? FLAG_VALUE_KIND_BY_ALIAS[alias]!
    : null;
}

/** Value-token grammar retained separately from scalar coercion and required flag presence. */
export interface ExtensionFlagValueContract {
  /** Canonical kind after coercion; null means the declaration has no explicit scalar type. */
  value_type: FlagValueKind | null;
  /** Whether argv consumes no value, a mandatory value, or an optional value. */
  value_arity: "none" | "required" | "optional";
  /** Display label for a consumed value; null for switches. */
  value_name: string | null;
}

/** Preserve the historical inferred-value declarations as well as explicit labels and scalar kinds. */
function hasExtensionFlagValueMetadata(definition: Readonly<FlagDefinition>, inlineName: string | null | undefined, declaredType: string | undefined): boolean {
  return Boolean(definition.value_name?.trim() || inlineName || declaredType || definition.required === true || definition.list === true);
}

/** Prefer the canonical declaration while retaining the legacy alias when it is absent or blank. */
function declaredExtensionFlagType(definition: Readonly<FlagDefinition>): string | undefined {
  return definition.value_type?.trim() || definition.type?.trim();
}

/** Preserve legacy bool value tokens and inline optionality before canonicalizing the scalar kind. */
export function resolveExtensionFlagValueContract(definition: Readonly<FlagDefinition>): ExtensionFlagValueContract {
  const declaredType = declaredExtensionFlagType(definition);
  const valueType = resolveFlagValueKind(declaredType);
  const inline = parseExtensionLongFlagToken(definition.long);
  const declaredName = definition.value_name?.trim() || null;
  const booleanSwitch = valueType === "boolean" && declaredType?.toLowerCase() !== "bool";
  const takesValue = !booleanSwitch && hasExtensionFlagValueMetadata(definition, inline?.valueName, declaredType);
  return {
    value_type: valueType,
    value_arity: takesValue ? inline?.optional ? "optional" : "required" : "none",
    value_name: takesValue ? declaredName ?? inline?.valueName ?? "value" : null,
  };
}

/** Flatten a `list` flag value (or default) into its individual entries the same way the runtime does: nested arrays are flattened and comma-joined strings are split, with surrounding whitespace trimmed and empty segments dropped. No type coercion is applied. Shared by the CLI coercion path and the registration-time default validator so the two never disagree. */
export function flattenFlagListValue(value: unknown): unknown[] {
  const entries: unknown[] = [];
  const collect = (input: unknown): void => {
    if (Array.isArray(input)) {
      for (const item of input) {
        collect(item);
      }
      return;
    }
    if (typeof input === "string") {
      for (const part of input.split(",")) {
        const trimmed = part.trim();
        if (trimmed.length > 0) {
          entries.push(trimmed);
        }
      }
      return;
    }
    if (input !== undefined && input !== null) {
      entries.push(input);
    }
  };
  collect(value);
  return entries;
}

/** Whether a scalar flag default would cleanly coerce under the declared kind, mirroring the runtime coercion rules in `coerceLooseCommandOptionsWithFlagDefinitions`. Used to reject contradictory definitions (e.g. `value_type: "number"` with `default: "abc"`) at registration instead of letting an untyped value pass through to activation. */
export function isFlagDefaultValueCoercible(
  value: string | number | boolean,
  kind: FlagValueKind,
): boolean {
  if (kind === "string") {
    return true;
  }
  if (kind === "number") {
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      Number.isFinite(Number(value))
    );
  }
  if (typeof value === "boolean") {
    return true;
  }
  return (
    typeof value === "string" &&
    ["true", "false", "1", "0"].includes(value.trim().toLowerCase())
  );
}
