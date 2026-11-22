/**
 * @module Custom schema fields whose option spelling shadows a built-in option
 * of a command they are registered for (pm-pta8um).
 *
 * A custom field becomes one command option per registered command. When that
 * option's flag, alias or parsed key equals a built-in option of the same
 * command, the parser can deliver only one of the two, so the built-in option
 * silently stops working (`pm list --full` read as a field filter). The
 * built-in side is the command's declared flag contract, so a new built-in
 * option is covered without a second list. The parser reuses an existing
 * option of the same name instead of adding a second one, which is why the
 * shadow is silent.
 */

import { resolveSubcommandFlagContractsForCommand, type CliFlagContract } from "../cli-contracts/flag-contracts.js";
import { BUILTIN_FIELD_KEYS, type NormalizedAddFieldInput } from "../../core/schema/fields-file.js";
import { EXIT_CODE, ITEM_METADATA_KEY_ORDER } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { commanderOptionAttribute, resolveCandidateOptionKeys } from "../../core/schema/runtime-field-values.js";
import { resolveRuntimeFieldRegistry, type RuntimeFieldDefinitionResolved } from "../../core/schema/runtime-schema.js";
import type { RuntimeFieldCommand, RuntimeFieldDefinition, RuntimeSchemaSettings } from "../../types/index.js";

/** The parts of a field definition that decide which options it adds. */
export interface FieldOptionSource {
  /** Field key; a parsed value is stored under its camel-case form. */
  key: string;
  /** Primary flag, with or without leading dashes. */
  cli_flag: string;
  /** Additional flag spellings. */
  cli_aliases: readonly string[];
  /** Commands the field adds an option to. */
  commands: readonly RuntimeFieldCommand[];
}

/** One built-in option a custom field shadows on one command. */
export interface FieldOptionCollision {
  /** Key of the custom field. */
  field: string;
  /** Command path as typed, for example `update-many`. */
  command: string;
  /** The field's spelling that collides, as a long flag. */
  field_flag: string;
  /** The built-in option it shadows, as declared. */
  option: string;
}

/** A spelling without its leading dashes, in the case the parser compares. */
function optionName(flag: string): string {
  return flag.trim().toLowerCase().replace(/^-+/u, "");
}

/**
 * Every option key a spelling can be read or stored under. The set comes from
 * the reader of field values (`resolveCandidateOptionKeys`), which treats any
 * punctuation as a word break, plus the parser's own attribute for the flag,
 * so `token.budget`, `token_budget` and `--token-budget` all reach
 * `tokenBudget`. A negated flag has two: `--no-notes` is parsed under `notes`
 * and delivered to handlers as `noNotes`, and the negation is removed once,
 * as the parser does.
 */
function optionKeys(flag: string): string[] {
  const name = optionName(flag);
  const keys = resolveCandidateOptionKeys({ key: name, cli_flag: name, cli_aliases: [] } as unknown as RuntimeFieldDefinitionResolved);
  return [...new Set([...keys, commanderOptionAttribute(name)])];
}

/**
 * Item metadata a custom field may redefine (today `severity`, which the ops
 * profile ships): the built-in option then carries the field's own value, so
 * sharing that one option is the design and not a shadow. Derived from the
 * reserved-key list so the two cannot disagree. Only a field with exactly
 * that key is exempt, and only for the option of the same name.
 */
const REDEFINABLE_METADATA_KEYS: ReadonlySet<string> = new Set(
  ITEM_METADATA_KEY_ORDER.filter((key) => !BUILTIN_FIELD_KEYS.has(key)),
);

const builtInOptionsByCommand = new Map<string, ReadonlyMap<string, string>>();

/** Built-in option keys of a command, each mapped to its declared flag. */
function builtInOptions(command: string): ReadonlyMap<string, string> {
  let options = builtInOptionsByCommand.get(command);
  if (options === undefined) {
    const declared = new Map<string, string>();
    for (const contract of resolveSubcommandFlagContractsForCommand(command) as CliFlagContract[]) {
      for (const key of [contract.flag, ...(contract.aliases ?? [])].flatMap(optionKeys)) {
        if (!declared.has(key)) declared.set(key, contract.flag);
      }
    }
    options = declared;
    builtInOptionsByCommand.set(command, options);
  }
  return options;
}

/** List every built-in option the given fields shadow, ordered by field, command and flag. */
export function resolveFieldOptionCollisions(fields: readonly FieldOptionSource[]): FieldOptionCollision[] {
  const collisions: FieldOptionCollision[] = [];
  for (const field of fields) {
    // The key is included beside the flags: the parsed value is stored under the key whatever the flag is spelled.
    const spellings = [...new Set([field.cli_flag, ...field.cli_aliases, field.key].map(optionName))];
    for (const fieldCommand of field.commands) {
      const command = fieldCommand.replaceAll("_", "-");
      const options = builtInOptions(command);
      const seen = new Set<string>();
      for (const spelling of spellings) {
        if (REDEFINABLE_METADATA_KEYS.has(field.key) && spelling.replaceAll("-", "_") === field.key) continue;
        const option = optionKeys(spelling).map((key) => options.get(key)).find((declared) => declared !== undefined);
        if (option === undefined || seen.has(option)) continue;
        seen.add(option);
        collisions.push({ field: field.key, command, field_flag: `--${spelling.replaceAll("_", "-")}`, option });
      }
    }
  }
  return collisions.sort((left, right) =>
    left.field.localeCompare(right.field) || left.command.localeCompare(right.command) || left.option.localeCompare(right.option));
}

/** Collisions of one field as `schema add-field` and a profile declare it, before it is stored. */
export function resolveAddFieldOptionCollisions(field: NormalizedAddFieldInput): FieldOptionCollision[] {
  return resolveFieldOptionCollisions([{
    key: field.key,
    cli_flag: field.cliFlag ?? field.key,
    cli_aliases: field.cliAliases,
    commands: field.commands,
  }]);
}

/** One line per collision for refusals and diagnostics. */
export function describeFieldOptionCollision(collision: FieldOptionCollision): string {
  return `${collision.field_flag} shadows built-in ${collision.option} on pm ${collision.command}`;
}

/** Diagnostic rows for fields already stored in a tracker: a refusal at registration cannot reach those. */
export function scanFieldOptionCollisions(
  schema: RuntimeSchemaSettings,
  limit: number,
): { details: Record<string, unknown>; warnings: string[] } {
  const collisions = resolveFieldOptionCollisions(resolveRuntimeFieldRegistry(schema).definitions);
  if (collisions.length === 0) return { details: {}, warnings: [] };
  return {
    details: {
      schema_field_option_collision_count: collisions.length,
      schema_field_option_collisions: collisions.slice(0, limit),
      schema_field_option_collisions_truncated: collisions.length > limit,
      schema_field_option_collision_fix_hint: "Rename a file-backed field without losing item values: pm schema rename-field <key> --to <new-key>. For a colliding flag, alias or command list, re-register the same key: pm schema add-field <key> --cli-flag <flag> --commands <commands>. Edit a field defined inline in settings.json there.",
    },
    warnings: [`validate_schema_field_option_collision:${collisions.length}`],
  };
}

/** Refuse a field whose option would shadow a built-in option of a command it is registered for (pm-pta8um). */
export function assertFieldOptionsAvailable(field: NormalizedAddFieldInput): void {
  refuseFieldOptionCollisions(field.key, field.commands, resolveAddFieldOptionCollisions(field));
}

/** The same refusal for a stored definition a migration is about to write, such as a rename target. */
export function assertFieldDefinitionOptionsAvailable(definition: RuntimeFieldDefinition): void {
  // A definition the registry rejects resolves to nothing and so reports nothing here.
  const resolved = resolveRuntimeFieldRegistry({ fields: [definition] } as RuntimeSchemaSettings).definitions;
  refuseFieldOptionCollisions(definition.key, resolved.flatMap((entry) => entry.commands), resolveFieldOptionCollisions(resolved));
}

/** Throw the typed refusal when a field shadows any built-in option. */
function refuseFieldOptionCollisions(fieldKey: string, fieldCommands: readonly RuntimeFieldCommand[], collisions: FieldOptionCollision[]): void {
  if (collisions.length === 0) return;
  const field = { key: fieldKey, commands: fieldCommands };
  const commands = new Set(collisions.map((collision) => collision.command));
  // The retry lists the names --commands accepts (update_many), not the command paths the collisions name.
  const free = field.commands.filter((command) => !commands.has(command.replaceAll("_", "-")));
  throw new PmCliError(
    `Cannot define custom field "${field.key}": ${collisions.map(describeFieldOptionCollision).join("; ")}. The built-in option would stop working for that command.`,
    EXIT_CODE.USAGE,
    {
      code: "schema_field_option_collision",
      field: field.key,
      flag: collisions[0]!.option,
      required: "A custom field's key, flag and aliases must differ from every built-in option of each command it is registered for.",
      nextSteps: [
        `Rename the field with a project-specific prefix, for example pm schema add-field project_${field.key}.`,
        ...(free.length > 0 ? [`Or register "${field.key}" only where its option is free: --commands ${free.join(",")}.`] : []),
      ],
    },
  );
}
