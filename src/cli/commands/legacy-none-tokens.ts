/**
 * @module cli/commands/legacy-none-tokens
 *
 * Implements the pm legacy none tokens command surface and its agent-facing runtime behavior.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

/**
 * Shared legacy "none"/"null" sentinel handling for the create and update
 * commands. These tokens used to mean "clear this field"; they are now
 * rejected in favour of explicit --unset / --clear-* flags.
 *
 * Extracted verbatim from create.ts and update.ts (pm-why9) — behaviour and
 * error strings are identical to the previous per-command copies.
 */
const LEGACY_NONE_TOKENS = new Set(["none", "null"]);

/** Describes a repeatable option whose legacy none/null token maps to a clear flag. */
export interface LegacyNoneCollectionNormalizer<
  TOptions extends Record<string, unknown>,
> {
  /** Value that configures or reports option key for this contract. */
  optionKey: keyof TOptions;
  /** Value that configures or reports clear flag key for this contract. */
  clearFlagKey: keyof TOptions;
  /** Value that configures or reports value flag for this contract. */
  valueFlag: string;
  /** Value that configures or reports clear flag for this contract. */
  clearFlag: string;
  /** Value that configures or reports disable flag key for this contract. */
  disableFlagKey?: keyof TOptions;
}

/** Build the shared create/update collection normalizer table with optional replacement-mode guards. */
export function createLegacyNoneCollectionNormalizers<
  TOptions extends Record<string, unknown>,
>(
  options: {
    depDisableFlagKey?: keyof TOptions;
    testDisableFlagKey?: keyof TOptions;
  } = {},
): ReadonlyArray<LegacyNoneCollectionNormalizer<TOptions>> {
  const row = (
    optionKey: string,
    clearFlagKey: string,
    valueFlag: string,
    clearFlag: string,
    disableFlagKey?: keyof TOptions,
  ): LegacyNoneCollectionNormalizer<TOptions> => ({
    optionKey: optionKey as keyof TOptions,
    clearFlagKey: clearFlagKey as keyof TOptions,
    valueFlag,
    clearFlag,
    ...(disableFlagKey === undefined ? {} : { disableFlagKey }),
  });
  return [
    row("dep", "clearDeps", "--dep", "--clear-deps", options.depDisableFlagKey),
    row("comment", "clearComments", "--comment", "--clear-comments"),
    row("note", "clearNotes", "--note", "--clear-notes"),
    row("learning", "clearLearnings", "--learning", "--clear-learnings"),
    row("file", "clearFiles", "--file", "--clear-files"),
    row(
      "test",
      "clearTests",
      "--test",
      "--clear-tests",
      options.testDisableFlagKey,
    ),
    row("doc", "clearDocs", "--doc", "--clear-docs"),
    row("reminder", "clearReminders", "--reminder", "--clear-reminders"),
    row("event", "clearEvents", "--event", "--clear-events"),
    row(
      "typeOption",
      "clearTypeOptions",
      "--type-option",
      "--clear-type-options",
    ),
  ];
}

/** Implements check whether legacy none token for the public runtime surface of this module. */
export function isLegacyNoneToken(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return LEGACY_NONE_TOKENS.has(value.trim().toLowerCase());
}

/** Implements assert no legacy none token for the public runtime surface of this module. */
export function assertNoLegacyNoneToken(
  value: string | undefined,
  flag: string,
  replacementHint?: string,
): void {
  if (!isLegacyNoneToken(value)) {
    return;
  }
  const suffix = replacementHint ? ` ${replacementHint}` : "";
  throw new PmCliError(
    `${flag} no longer accepts "none" or "null".${suffix}`.trim(),
    EXIT_CODE.USAGE,
  );
}

/** Implements assert no legacy none tokens for the public runtime surface of this module. */
export function assertNoLegacyNoneTokens(
  values: string[] | undefined,
  flag: string,
  replacementHint?: string,
): void {
  if (!values || values.length === 0) {
    return;
  }
  const hasLegacyToken = values.some((value) => isLegacyNoneToken(value));
  if (!hasLegacyToken) {
    return;
  }
  const suffix = replacementHint ? ` ${replacementHint}` : "";
  throw new PmCliError(
    `${flag} no longer accepts "none" or "null".${suffix}`.trim(),
    EXIT_CODE.USAGE,
  );
}

/** Convert collection-level legacy none/null tokens into their explicit clear flags. */
export function applyLegacyNoneCollectionNormalizers<
  TOptions extends Record<string, unknown>,
>(
  normalized: TOptions,
  definitions: ReadonlyArray<LegacyNoneCollectionNormalizer<TOptions>>,
): TOptions {
  for (const definition of definitions) {
    const candidate = normalized[definition.optionKey];
    if (!Array.isArray(candidate) || candidate.length === 0) {
      continue;
    }
    if (
      !candidate.every((entry): entry is string => typeof entry === "string")
    ) {
      throw new PmCliError(
        `${definition.valueFlag} entries must be strings.`,
        EXIT_CODE.USAGE,
      );
    }
    const entries = candidate;
    const hasLegacy = entries.some((entry) => isLegacyNoneToken(entry));
    if (!hasLegacy) {
      continue;
    }
    const concreteEntries = entries.filter(
      (entry) => !isLegacyNoneToken(entry),
    );
    if (concreteEntries.length > 0) {
      throw new PmCliError(
        `Cannot mix legacy clear token "none"/"null" with concrete ${definition.valueFlag} entries. Use ${definition.clearFlag} to clear or provide explicit entries.`,
        EXIT_CODE.USAGE,
      );
    }
    normalized[definition.optionKey] = undefined as TOptions[keyof TOptions];
    normalized[definition.clearFlagKey] = true as TOptions[keyof TOptions];
    if (definition.disableFlagKey) {
      normalized[definition.disableFlagKey] = false as TOptions[keyof TOptions];
    }
  }
  return normalized;
}
