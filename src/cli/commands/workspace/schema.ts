/**
 * @module cli/commands/workspace/schema
 *
 * Preserves the CLI command-module contract while schema behavior, result
 * types, and rendering helpers are owned by the public SDK module.
 */
export {
  SCHEMA_SUBCOMMANDS,
  _testOnlySchemaCommand,
  formatSchemaAddFieldHuman,
  formatSchemaAddStatusHuman,
  formatSchemaAddTypeHuman,
  formatSchemaApplyPresetHuman,
  formatSchemaEvolutionMigrationHuman,
  formatSchemaInferTypesHuman,
  formatSchemaListFieldsHuman,
  formatSchemaListHuman,
  formatSchemaRemoveFieldHuman,
  formatSchemaRemoveStatusHuman,
  formatSchemaRemoveTypeHuman,
  formatSchemaShowFieldHuman,
  formatSchemaShowHuman,
  formatSchemaShowStatusHuman,
  runSchemaAddField,
  runSchemaAddStatus,
  runSchemaAddType,
  runSchemaApplyPreset,
  runSchemaEvolutionMigration,
  runSchemaInferTypes,
  runSchemaList,
  runSchemaListFields,
  runSchemaRemoveField,
  runSchemaRemoveStatus,
  runSchemaRemoveType,
  runSchemaShow,
  runSchemaShowField,
  runSchemaShowStatus,
  runWorkflowPolicyAction,
} from "../../../sdk/schema.js";
