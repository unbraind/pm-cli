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

import { GLOBAL_FLAG_CONTRACTS, resolveSubcommandFlagContractsForCommand, type CliFlagContract } from "../cli-contracts/flag-contracts.js";
import { BUILTIN_FIELD_KEYS, type NormalizedAddFieldInput } from "../../core/schema/fields-file.js";
import { EXIT_CODE, ITEM_METADATA_KEY_ORDER } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { commanderOptionAttribute, resolveCandidateOptionKeys } from "../../core/schema/runtime-field-values.js";
import { resolveRuntimeFieldRegistry, type RuntimeFieldDefinitionResolved } from "../../core/schema/runtime-schema.js";
import type { RuntimeFieldCommand, RuntimeFieldDefinition, RuntimeSchemaSettings } from "../../types/index.js";
import { describeFieldFlagSpellingDefect, isShortFieldFlagSpelling as isShortSpelling } from "./field-flag-spelling.js";

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

/**
 * The help option the parser adds to every command without listing it among
 * the command's options or contracts (pm-8patuh): a field alias `-h` or
 * `help` would otherwise register as a value option and make help demand a
 * value.
 */
const IMPLICIT_HELP_OPTION: Pick<CliFlagContract, "flag" | "short"> = { flag: "--help", short: "-h" };

/** Built-in options of one command: long keys and short flags, each mapped to the declared long flag. */
interface BuiltInOptions {
  /** Every option key a long spelling is read under, mapped to its declared flag. */
  long: ReadonlyMap<string, string>;
  /** Every declared short flag (`-p`), mapped to its long flag. */
  short: ReadonlyMap<string, string>;
}

const builtInOptionsByCommand = new Map<string, BuiltInOptions>();

/** Built-in option keys and short flags of a command, each mapped to its declared flag. */
function builtInOptions(command: string): BuiltInOptions {
  let options = builtInOptionsByCommand.get(command);
  if (options === undefined) {
    const long = new Map<string, string>();
    const short = new Map<string, string>();
    // Root switches such as --version and --explain are parsed on every command but are not all repeated in a command's own contract.
    for (const contract of [...resolveSubcommandFlagContractsForCommand(command), ...GLOBAL_FLAG_CONTRACTS, IMPLICIT_HELP_OPTION] as CliFlagContract[]) {
      for (const key of [contract.flag, ...(contract.aliases ?? [])].flatMap(optionKeys)) {
        if (!long.has(key)) long.set(key, contract.flag);
      }
      if (contract.short !== undefined && !short.has(contract.short)) short.set(contract.short, contract.flag);
    }
    options = { long, short };
    builtInOptionsByCommand.set(command, options);
  }
  return options;
}

/** The built-in option a field spelling shadows on a command, if any: a short flag against short flags, anything else by option key. */
function shadowedOption(spelling: string, options: BuiltInOptions): string | undefined {
  if (isShortSpelling(spelling)) return options.short.get(spelling.trim());
  return optionKeys(spelling).map((key) => options.long.get(key)).find((declared) => declared !== undefined);
}

/** List every built-in option the given fields shadow, ordered by field, command and flag. */
export function resolveFieldOptionCollisions(fields: readonly FieldOptionSource[]): FieldOptionCollision[] {
  const collisions: FieldOptionCollision[] = [];
  for (const field of fields) {
    // The key is included beside the flags: the parsed value is stored under the key whatever the flag is spelled.
    // A short flag keeps its dash, because it is compared with the command's short flags only (pm-8patuh).
    const spellings = [...new Set([field.cli_flag, ...field.cli_aliases, field.key].map((token) => (isShortSpelling(token) ? token.trim() : optionName(token))))];
    for (const fieldCommand of field.commands) {
      collisions.push(...resolveCommandCollisions(field.key, spellings, fieldCommand.replaceAll("_", "-")));
    }
  }
  return collisions.sort((left, right) =>
    left.field.localeCompare(right.field) || left.command.localeCompare(right.command) || left.option.localeCompare(right.option));
}

/** The built-in options of one command that a field's spellings shadow, one row per shadowed option. */
function resolveCommandCollisions(fieldKey: string, spellings: readonly string[], command: string): FieldOptionCollision[] {
  const options = builtInOptions(command);
  const collisions = new Map<string, FieldOptionCollision>();
  for (const spelling of spellings) {
    if (REDEFINABLE_METADATA_KEYS.has(fieldKey) && spelling.replaceAll("-", "_") === fieldKey) continue;
    const option = shadowedOption(spelling, options);
    if (option === undefined || collisions.has(option)) continue;
    collisions.set(option, { field: fieldKey, command, field_flag: isShortSpelling(spelling) ? spelling : `--${spelling.replaceAll("_", "-")}`, option });
  }
  return [...collisions.values()];
}

/** Collisions of one field as `schema add-field` and a profile declare it, before it is stored. */
export function resolveAddFieldOptionCollisions(field: NormalizedAddFieldInput): FieldOptionCollision[] {
  return resolveFieldOptionCollisions([{
    key: field.key,
    // Registration spells a key's default flag with hyphens, so no_json becomes --no-json, a negation of --json.
    cli_flag: field.cliFlag ?? field.key.replaceAll("_", "-"),
    cli_aliases: field.cliAliases,
    commands: field.commands,
  }]);
}

/** One stored flag or alias of a field that is not exactly one option spelling (pm-8patuh). */
export interface FieldFlagSpellingDefect {
  /** Key of the custom field. */
  field: string;
  /** The stored token, as the field declares it. */
  spelling: string;
  /** Why the parser cannot register it as one option. */
  reason: string;
}

/** Every flag or alias of the given fields that is not exactly one option spelling. */
export function resolveFieldFlagSpellingDefects(fields: ReadonlyArray<Pick<FieldOptionSource, "key" | "cli_flag" | "cli_aliases">>): FieldFlagSpellingDefect[] {
  return fields.flatMap((field) =>
    [...new Set([field.cli_flag, ...field.cli_aliases])].flatMap((spelling) => {
      const reason = describeFieldFlagSpellingDefect(spelling);
      return reason === undefined ? [] : [{ field: field.key, spelling, reason }];
    }));
}

/** Defects of one field as `schema add-field` and a profile declare it, before it is stored. */
export function resolveAddFieldFlagSpellingDefects(field: NormalizedAddFieldInput): FieldFlagSpellingDefect[] {
  return resolveFieldFlagSpellingDefects([{ key: field.key, cli_flag: field.cliFlag ?? field.key.replaceAll("_", "-"), cli_aliases: field.cliAliases }]);
}

/** One line per spelling defect for refusals and diagnostics. */
export function describeFieldFlagSpellingDefectLine(defect: FieldFlagSpellingDefect): string {
  return `${JSON.stringify(defect.spelling)} ${defect.reason}`;
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
  const definitions = resolveRuntimeFieldRegistry(schema).definitions;
  const collisions = resolveFieldOptionCollisions(definitions);
  const spellingDefects = resolveFieldFlagSpellingDefects(definitions);
  const spellings = spellingDefects.length === 0 ? { details: {}, warnings: [] } : {
    details: {
      schema_field_flag_invalid_count: spellingDefects.length,
      schema_field_flag_invalid: spellingDefects.slice(0, limit),
      schema_field_flag_invalid_truncated: spellingDefects.length > limit,
      schema_field_flag_invalid_fix_hint: "Re-register the field with one flag and one spelling per alias: pm schema add-field <key> --cli-flag <flag> --alias <alias>. A short alias is one dash and one character. Edit a field defined inline in settings.json there.",
    },
    warnings: [`validate_schema_field_flag_invalid:${spellingDefects.length}`],
  };
  if (collisions.length === 0) return spellings;
  return {
    details: {
      ...spellings.details,
      schema_field_option_collision_count: collisions.length,
      schema_field_option_collisions: collisions.slice(0, limit),
      schema_field_option_collisions_truncated: collisions.length > limit,
      schema_field_option_collision_fix_hint: "Rename a file-backed field without losing item values: pm schema rename-field <key> --to <new-key>. For a colliding flag, alias or command list, re-register the same key: pm schema add-field <key> --cli-flag <flag> --commands <commands>. Edit a field defined inline in settings.json there.",
    },
    warnings: [...spellings.warnings, `validate_schema_field_option_collision:${collisions.length}`],
  };
}

/**
 * Refuse a field whose flag or alias is not exactly one option spelling
 * (pm-8patuh), or whose option would shadow a built-in option of a command it
 * is registered for (pm-pta8um).
 */
export function assertFieldOptionsAvailable(field: NormalizedAddFieldInput): void {
  refuseFieldFlagSpellingDefects(field.key, resolveAddFieldFlagSpellingDefects(field));
  refuseFieldOptionCollisions(field.key, field.commands, resolveAddFieldOptionCollisions(field));
}

/** The same refusals for a stored definition a migration is about to write, such as a rename target. */
export function assertFieldDefinitionOptionsAvailable(definition: RuntimeFieldDefinition): void {
  // A definition the registry rejects resolves to nothing and so reports nothing here.
  const resolved = resolveRuntimeFieldRegistry({ fields: [definition] } as RuntimeSchemaSettings).definitions;
  refuseFieldFlagSpellingDefects(definition.key, resolveFieldFlagSpellingDefects(resolved));
  refuseFieldOptionCollisions(definition.key, resolved.flatMap((entry) => entry.commands), resolveFieldOptionCollisions(resolved));
}

/** Throw the typed refusal when a field's flag or alias is not exactly one option spelling. */
function refuseFieldFlagSpellingDefects(fieldKey: string, defects: FieldFlagSpellingDefect[]): void {
  if (defects.length === 0) return;
  throw new PmCliError(
    `Cannot define custom field "${fieldKey}": flag ${defects.map(describeFieldFlagSpellingDefectLine).join("; ")}. The command it is registered for could not register it as one option.`,
    EXIT_CODE.USAGE,
    {
      code: "schema_field_flag_invalid",
      field: fieldKey,
      flag: defects[0]!.spelling,
      required: "Each custom field flag and alias must be one option spelling: a long name without spaces, pipes, commas, '=' or brackets, or a short flag of one dash and one character.",
      nextSteps: [
        `Pass one spelling per --alias, for example pm schema add-field ${fieldKey} --alias <first> --alias <second>.`,
      ],
    },
  );
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
