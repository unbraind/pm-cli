/** @module sdk/runtime/mutation-admission Reject native client mutation typos before dispatch. */
import { readRuntimeFieldOptionValue } from "../../core/schema/runtime-field-values.js";
import { resolveRuntimeFieldRegistry, runtimeFieldOptionTarget } from "../../core/schema/runtime-schema.js";
import { readSettings } from "../../core/store/settings.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { PmCliError } from "../../core/shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../../core/shared/levenshtein.js";
import { CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS, UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS } from "../cli-contracts/commander-mutation-options.js";
import { LIST_COMMANDER_STRING_OPTION_CONTRACTS } from "../cli-contracts/commander-types.js";
import { CREATE_FLAG_CONTRACTS, LIST_FILTER_FLAG_CONTRACTS, UPDATE_FLAG_CONTRACTS } from "../cli-contracts/flag-contracts.js";
import { isMcpMutationTransportInput, isRuntimeRecord, UPDATE_MANY_FLAT_CONTROL_KEYS } from "../runtime-input.js";

/** Refuse a key with a bounded nearest-name hint and an explicit no-write guarantee. */
function refuseKey(action: string, key: string, allowed: Set<string>, misplaced = false): never {
  const suggestion = [...allowed].map((candidate) => ({ candidate, distance: levenshteinDistanceWithinLimit(key, candidate, 3) }))
    .filter((entry): entry is { candidate: string; distance: number } => entry.distance !== null)
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))[0]?.candidate;
  const correction = misplaced ? `Put mutation fields under options (options.${key}).` : suggestion ? `Did you mean "${suggestion}"?` : "Use the declared command options or the field option for registered item fields.";
  throw new PmCliError(`Unknown ${action} ${misplaced ? "argument" : "option"} "${key}". ${correction} No changes were made.`, 2, {
    code: "invalid_argument_value", reason: "unknown_mutation_option", changed: false, field: key,
    required: correction, nextSteps: [correction],
  });
}

const OUTPUT_KEYS = ["outputInclude", "outputLimit", "outputBudget", "outputFormat", "outputSession", "outputCursor"];

/** Every declared option spelling of a native create or update, including its aliases and run controls. */
function declaredMutationOptionKeys(action: "create" | "update"): Set<string> {
  const contracts = action === "create" ? CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS : UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS;
  const flags = action === "create" ? CREATE_FLAG_CONTRACTS : UPDATE_FLAG_CONTRACTS;
  const flagKeys = flags.map(({ flag }) => flag.slice(2).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase()));
  return new Set([...contracts.flatMap((contract) => [contract.target, ...contract.keys]), ...flagKeys, "author", "message", "force", "fullChangedFields", "idOnly", ...OUTPUT_KEYS]);
}

/** Refuse a caller's options value that is present but not a record. */
function assertOptionsRecord(rawOptions: unknown): asserts rawOptions is Record<string, unknown> | undefined {
  if (rawOptions !== undefined && !isRuntimeRecord(rawOptions)) {
    throw new PmCliError("Mutation options must be an object. No changes were made.", 2, { code: "invalid_argument_value", changed: false });
  }
}

/** Refuse each undeclared key that is no runtime schema field option of the command, naming it. */
async function refuseUndeclaredKeys(action: string, command: "create" | "update" | "update_many", keys: Iterable<string>, allowed: Set<string>, pmRoot: string | undefined): Promise<void> {
  const unknown = [...keys].filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  const registry = resolveRuntimeFieldRegistry((await readSettings(resolvePmRoot(process.cwd(), pmRoot))).schema);
  const fields = registry.command_to_fields.get(command) ?? [];
  for (const field of fields) allowed.add(runtimeFieldOptionTarget(field));
  for (const key of unknown) {
    if (!fields.some((field) => readRuntimeFieldOptionValue({ [key]: true }, field) === true)) refuseKey(action, key, allowed);
  }
}

/** Validate only native create/update clients; MCP retains its declared transport admission. */
export async function assertNativeMutationOptions(
  action: "create" | "update",
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  pmRoot: string | undefined,
  hoistedKeys: readonly string[],
): Promise<void> {
  if (isMcpMutationTransportInput(args)) return;
  const allowed = declaredMutationOptionKeys(action);
  const topLevel = new Set(["action", "options", "path", "cwd", "author", "force", "noExtensions", "no_extensions", "fullChangedFields", "idOnly", ...OUTPUT_KEYS, ...hoistedKeys, ...(action === "update" ? ["id"] : [])]);
  for (const key of Object.keys(args)) if (!topLevel.has(key)) refuseKey(action, key, allowed, allowed.has(key));
  const rawOptions = args.options;
  assertOptionsRecord(rawOptions);
  await refuseUndeclaredKeys(action, action, new Set([...Object.keys(rawOptions ?? {}), ...Object.keys(options)]), allowed, pmRoot);
}

/** Option key commander derives from a flag: camelCase, with a negated flag stored under its positive name. */
function flagOptionKey(flag: string): string {
  return flag.slice(2).replace(/^no-/u, "").replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

const camelKey = (key: string): string => key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());

/**
 * Refuse an undeclared update-many key by name before any row changes (pm-xp7ldt), as a single
 * update refuses it. The caller's own keys are read before normalization copies them, so a key a
 * copy would lose is still judged. The allowlist is the bulk path's own: `id` selects nothing
 * there (`ids` does), a nested `list` record may hold list selection keys only, and a nested
 * `update` record carries every field, so beside it an outer key must select rows, control the
 * run or state its attribution. Only a runtime schema field declared for `update_many` is applied
 * by the bulk path, so only those are admitted. MCP retains its declared transport admission.
 */
export async function assertNativeUpdateManyOptions(
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  pmRoot: string | undefined,
): Promise<void> {
  if (isMcpMutationTransportInput(args)) return;
  const rawOptions = args.options;
  assertOptionsRecord(rawOptions);
  const fields = declaredMutationOptionKeys("update");
  // A single update's item operand; the bulk path would read no selection from it.
  fields.delete("id");
  fields.add("documentAnnotationSnapshot");
  const controls = new Set([...UPDATE_MANY_FLAT_CONTROL_KEYS, "author", "message", "force", "fullChangedFields", "idOnly", ...OUTPUT_KEYS]);
  const everyOption = new Set([...fields, ...controls]);
  const topLevel = new Set(["action", "options", "path", "cwd", "author", "force", "noExtensions", "no_extensions", "fullChangedFields", "idOnly", ...OUTPUT_KEYS]);
  for (const key of Object.keys(args)) if (!topLevel.has(key)) refuseKey("update-many", key, everyOption, everyOption.has(key));
  // A snake_case spelling of a run or output control is normalized before dispatch; item fields keep their declared spellings.
  const outerKeys = new Set([...Object.keys(rawOptions ?? {}), ...Object.keys(options)].map((key) => (controls.has(camelKey(key)) ? camelKey(key) : key)));
  const list = isRuntimeRecord(options.list) ? options.list : undefined;
  if (list !== undefined) {
    const selection = new Set([...LIST_COMMANDER_STRING_OPTION_CONTRACTS.flatMap(({ target, keys }) => [target, ...keys]), ...LIST_FILTER_FLAG_CONTRACTS.map(({ flag }) => flagOptionKey(flag)), "ids"]);
    for (const key of Object.keys(list)) if (!selection.has(key)) refuseKey("update-many list", key, selection);
  }
  const nested = isRuntimeRecord(options.update) ? options.update : undefined;
  if (nested === undefined) {
    await refuseUndeclaredKeys("update-many", "update_many", outerKeys, everyOption, pmRoot);
    return;
  }
  for (const key of outerKeys) {
    if (controls.has(key)) continue;
    if (fields.has(key)) {
      const required = `Put update fields inside update (update.${key}); beside a nested update record an outer key selects rows or controls the run.`;
      throw new PmCliError(`Unknown update-many option "${key}". ${required} No changes were made.`, 2, {
        code: "invalid_argument_value", reason: "unknown_mutation_option", changed: false, field: key, required, nextSteps: [required],
      });
    }
    refuseKey("update-many", key, controls);
  }
  await refuseUndeclaredKeys("update-many", "update_many", Object.keys(nested), fields, pmRoot);
}
