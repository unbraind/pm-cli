/** @module sdk/runtime/mutation-admission Reject native client mutation typos before dispatch. */
import { readRuntimeFieldOptionValue } from "../../core/schema/runtime-field-values.js";
import { resolveRuntimeFieldRegistry, runtimeFieldOptionTarget } from "../../core/schema/runtime-schema.js";
import { readSettings } from "../../core/store/settings.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { PmCliError } from "../../core/shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../../core/shared/levenshtein.js";
import { CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS, UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS } from "../cli-contracts/commander-mutation-options.js";
import { CREATE_FLAG_CONTRACTS, UPDATE_FLAG_CONTRACTS } from "../cli-contracts/flag-contracts.js";
import { isMcpMutationTransportInput, isRuntimeRecord } from "../runtime-input.js";

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

/** Validate only native create/update clients; MCP retains its declared transport admission. */
export async function assertNativeMutationOptions(
  action: "create" | "update",
  args: Record<string, unknown>,
  options: Record<string, unknown>,
  pmRoot: string | undefined,
  hoistedKeys: readonly string[],
): Promise<void> {
  if (isMcpMutationTransportInput(args)) return;
  const contracts = action === "create" ? CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS : UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS;
  const flags = action === "create" ? CREATE_FLAG_CONTRACTS : UPDATE_FLAG_CONTRACTS;
  const flagKeys = flags.map(({ flag }) => flag.slice(2).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase()));
  const allowed = new Set([...contracts.flatMap((contract) => [contract.target, ...contract.keys]), ...flagKeys]);
  const outputKeys = ["outputInclude", "outputLimit", "outputBudget", "outputFormat", "outputSession", "outputCursor"];
  for (const key of ["author", "message", "force", "fullChangedFields", "idOnly", ...outputKeys]) allowed.add(key);
  const topLevel = new Set(["action", "options", "path", "cwd", "author", "force", "noExtensions", "no_extensions", "fullChangedFields", "idOnly", ...outputKeys, ...hoistedKeys, ...(action === "update" ? ["id"] : [])]);
  for (const key of Object.keys(args)) if (!topLevel.has(key)) refuseKey(action, key, allowed, allowed.has(key));
  const rawOptions = args.options;
  if (rawOptions !== undefined && !isRuntimeRecord(rawOptions)) {
    throw new PmCliError("Mutation options must be an object. No changes were made.", 2, { code: "invalid_argument_value", changed: false });
  }
  const keys = new Set([...Object.keys(rawOptions ?? {}), ...Object.keys(options)]);
  const unknown = [...keys].filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  const registry = resolveRuntimeFieldRegistry((await readSettings(resolvePmRoot(process.cwd(), pmRoot))).schema);
  const fields = registry.command_to_fields.get(action) ?? [];
  for (const field of fields) allowed.add(runtimeFieldOptionTarget(field));
  for (const key of unknown) {
    if (!fields.some((field) => readRuntimeFieldOptionValue({ [key]: true }, field) === true)) refuseKey(action, key, allowed);
  }
}
