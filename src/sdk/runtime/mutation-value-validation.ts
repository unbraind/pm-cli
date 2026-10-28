/** @module sdk/runtime/mutation-value-validation Validates dynamic callers against SDK-owned mutation contracts. */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { asRecordClone } from "../../core/shared/primitives.js";
import { CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS, UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS } from "../cli-contracts/commander-mutation-options.js";
import { TOOL_CREATE_OPTION_CONTRACTS, TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS, TOOL_UPDATE_OPTION_CONTRACTS } from "../cli-contracts/tool-option-contracts.js";
import { PM_TOOL_PARAMETER_PROPERTIES } from "../cli-contracts/tool-parameter-tables.js";
import type { CommanderOptionAliasContract } from "../cli-contracts/commander-types.js";
import { preserveSdkMutationInput } from "../../core/item/parse.js";
import { isLiteralMutationInput } from "../../core/item/literal-mutation-input.js";

type MutationAction = "create" | "update" | "append";
const MUTATION_INPUT_EXAMPLES: Record<MutationAction, string> = {
  create: 'client.create({ type: "Task", title: "Example", createMode: "progressive" })',
  update: 'client.update(id, { estimatedMinutes: "45", force: false })',
  append: 'client.append(id, "Body text")',
};

/** Refuse invalid dynamic input without reflecting payload contents or beginning mutation work. */
function refuseValue(action: MutationAction, field: string, expected: string): never {
  const correction = `${action} ${field} must be ${expected}.`;
  throw new PmCliError(correction, EXIT_CODE.USAGE, {
    code: "invalid_argument_value", reason: "invalid_mutation_option_value", field, changed: false,
    required: correction,
    examples: [MUTATION_INPUT_EXAMPLES[action]],
  });
}

/** Reject non-string positional text before stdin resolution or string operations. */
export function assertMutationStringOperand(value: unknown, action: MutationAction, field: string): asserts value is string {
  if (typeof value !== "string") refuseValue(action, field, "a string");
}

/** Require an option record before a direct operation inspects or clones its values. */
export function assertMutationOptionBag(options: unknown, action: MutationAction): asserts options is Record<string, unknown> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) refuseValue(action, "options", "an object");
}

/** Validate supplied item operands before generic dispatch can discard their runtime type. */
export function assertMutationItemOperand(action: string | undefined, args: Record<string, unknown>): void {
  if ((action === "append" || action === "update") && args.id !== undefined) assertMutationStringOperand(args.id, action, "id");
}

/** Validate append text, attribution and overrides before resolving its transport or writing history. */
export function assertAppendMutationValues(options: unknown): void {
  assertMutationOptionBag(options, "append");
  for (const field of ["body", "author", "message"]) {
    if (options[field] !== undefined) assertMutationStringOperand(options[field], "append", field);
  }
  if (options.force !== undefined && typeof options.force !== "boolean") refuseValue("append", "force", "a boolean");
}

/** Describe canonical SDK arrays separately from scalar-friendly action transport. */
function optionValueType(list: boolean, scalarRepeatables: boolean): string {
  if (!list) return "a string";
  return scalarRepeatables ? "a string or string array" : "a string array";
}

/** Validate one declared scalar or repeatable option while retaining native priority numbers. */
function assertOptionValue(action: MutationAction, key: string, value: unknown, target: string, list: boolean, scalarRepeatables: boolean): void {
  if (value === undefined || (typeof value === "string" && (!list || scalarRepeatables))) return;
  if (target === "priority" && typeof value === "number" && Number.isFinite(value)) return;
  if (list && Array.isArray(value) && Array.from(value).every((entry) => typeof entry === "string")) return;
  refuseValue(action, key, optionValueType(list, scalarRepeatables));
}

/** Check contract-declared boolean parameters and their supported aliases. */
function assertBooleanOptions(action: "create" | "update", options: Record<string, unknown>, contracts: readonly CommanderOptionAliasContract[]): void {
  const parameters = action === "create" ? TOOL_CREATE_OPTION_CONTRACTS : TOOL_UPDATE_OPTION_CONTRACTS;
  for (const { param } of [...parameters, ...TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS, { param: "force" }]) {
    if (asRecordClone(Reflect.get(PM_TOOL_PARAMETER_PROPERTIES, param)).type !== "boolean") continue;
    const keys = contracts.find((contract) => contract.keys.includes(param))?.keys ?? [param];
    for (const key of keys) {
      if (options[key] !== undefined && typeof options[key] !== "boolean") refuseValue(action, key, "a boolean");
    }
  }
}

/** Validate native option values before transport normalization can coerce or discard them. */
export function assertNativeMutationValueTypes(action: "create" | "update", options: Record<string, unknown>, scalarRepeatables = true): void {
  const contracts = action === "create" ? CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS : UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS;
  for (const { target, keys, repeatable } of contracts) {
    if (asRecordClone(Reflect.get(PM_TOOL_PARAMETER_PROPERTIES, target)).type === "boolean") continue;
    for (const key of keys) {
      // Commander joins repeated acceptance criteria before the native string-valued SDK option.
      assertOptionValue(action, key, options[key], target, repeatable === true && target !== "acceptanceCriteria", scalarRepeatables);
    }
  }
  assertBooleanOptions(action, options, contracts);
}

/** Prepare direct domain calls with the same literal-data and value checks as client dispatch. */
export function prepareNativeMutationOptions<T extends Record<string, unknown>>(action: "create" | "update", options: T): T {
  assertMutationOptionBag(options, action);
  const prepared = preserveSdkMutationInput(options);
  if (isLiteralMutationInput(prepared)) assertNativeMutationValueTypes(action, prepared, false);
  return prepared;
}
