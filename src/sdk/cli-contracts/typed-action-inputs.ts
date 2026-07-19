/**
 * @module sdk/cli-contracts/typed-action-inputs
 *
 * Typed per-action SDK mutation inputs derived at the type level from the
 * executable command and option-contract tables (GH-601 / pm-x29o). Field typos and
 * wrong value shapes in `PmClient.create/update/close/updateMany/closeMany`
 * calls now fail `tsc` under strict instead of silently compiling into
 * runtime errors. The derivation is purely type-level over runtime contracts,
 * so it introduces no second hand-written input shape. Runtime-schema custom
 * fields keep their typed path through the repeatable `field` option, and
 * `PmClient.run` remains the deliberately wide escape hatch.
 */
import type { ToolOptionFlagContract } from "./flag-contracts.js";
import type { CloseCommandOptions } from "../../cli/commands/close.js";
import type { CreateCommandOptions } from "../../cli/commands/create.js";
import type { UpdateCommandOptions } from "../../cli/commands/update.js";
import type {
  TOOL_BULK_MUTATION_FILTER_OPTION_CONTRACT_SOURCE,
} from "./tool-option-contracts.js";

/** JSON-compatible scalar the SDK option-normalization layer accepts for one flag value (CLI flags arrive as strings; MCP and SDK callers may pass native numbers and booleans). */
export type PmOptionScalar = string | number | boolean;

/** Value type derived from one option contract: repeatable flags additionally accept arrays of scalars; every other flag takes a single scalar. */
type OptionContractValue<Contract extends ToolOptionFlagContract> =
  Contract extends { booleanish: true }
    ? boolean
    : Contract extends { repeatable: true }
      ? string | readonly string[]
      : string | number;

/** Optional option bag derived from a const-asserted option-contract tuple: one optional property per declared `param`, valued by that contract's shape. */
export type OptionsFromContracts<
  Contracts extends readonly ToolOptionFlagContract[],
> = {
  [Contract in Contracts[number] as Contract["param"]]?: OptionContractValue<Contract>;
};

/** Remove broad string/number/symbol index signatures while retaining every explicitly declared property and its exact runtime value type. */
type DeclaredProperties<Shape> = {
  [Key in keyof Shape as string extends Key
    ? never
    : number extends Key
      ? never
      : symbol extends Key
        ? never
        : Key]: Shape[Key];
};

/** Mutation attribution and override triple accepted by every item mutation action. Declared as an object type literal (not an interface) so the composed option bags keep their implicit index signature and stay assignable to the wide `Record`-based dispatch layer. */
export type PmMutationAttributionOptions = {
  /** Mutation author recorded in item history. */
  author?: string;
  /** History message recorded with the mutation. */
  message?: string;
  /** Override claim/lock ownership checks for this mutation. */
  force?: boolean;
};

/** Typed input for the SDK `create` action, derived from the executable create-command option contract with its custom-field index signature removed. */
export type PmCreateActionOptions = DeclaredProperties<CreateCommandOptions>;

/** Typed input for the SDK `update` action, derived from the executable update-command option contract while hiding internal policy-evaluation controls. */
export type PmUpdateActionOptions = Omit<
  DeclaredProperties<UpdateCommandOptions>,
  | "runtimeFieldCommands"
  | "ownershipMetadataBypass"
  | "ownershipDependencyBypass"
>;

/** Typed input for the SDK `close` action, derived from the executable close-command option contract plus the positional reason aliases used by generic action dispatch. */
export type PmCloseActionOptions = DeclaredProperties<CloseCommandOptions> & {
  /** Generic action-dispatch spelling for the positional close reason. */
  reason?: string;
  /** MCP-compatible alias for the positional close reason. */
  text?: string;
};

/** Typed bulk-mutation selection filters shared by the `update-many` and `close-many` actions, derived from the bulk-mutation filter contract table. */
export type PmBulkMutationFilterOptions = OptionsFromContracts<
  typeof TOOL_BULK_MUTATION_FILTER_OPTION_CONTRACT_SOURCE
>;

/** Checkpoint/preview controls shared by the bulk mutation actions. Declared as an object type literal (not an interface) so the composed option bags keep their implicit index signature and stay assignable to the wide `Record`-based dispatch layer. */
export type PmBulkMutationControlOptions = {
  /** Preview the bulk mutation without writing changes. */
  dryRun?: boolean;
  /** Roll back a previously checkpointed bulk mutation. */
  rollback?: boolean;
  /** Skip writing the crash-recovery checkpoint for this bulk mutation. */
  noCheckpoint?: boolean;
};

/** Typed input for the SDK `update-many` action: update fields plus bulk selection filters and checkpoint controls. */
export type PmUpdateManyActionOptions = PmUpdateActionOptions &
  PmBulkMutationFilterOptions &
  PmBulkMutationControlOptions;

/** Typed input for the SDK `close-many` action: closure fields plus bulk selection filters and checkpoint controls. */
export type PmCloseManyActionOptions = Pick<
  PmCloseActionOptions,
  | "reason"
  | "resolution"
  | "expectedResult"
  | "actualResult"
  | "validateClose"
  | "author"
  | "message"
  | "force"
> &
  PmBulkMutationFilterOptions &
  PmBulkMutationControlOptions;
