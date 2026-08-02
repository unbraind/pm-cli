/**
 * @module sdk/runtime-public-contracts
 *
 * Declares the shared public contracts consumed by the SDK runtime and its
 * package-author entrypoints without expanding the runtime implementation.
 */
import type { ExtensionRegistrationRegistry } from "../core/extensions/index.js";
import type { WorkspaceExtensionCommandContract, WorkspaceFieldContract } from "./workspace-contracts.js";
import type { PmToolAction } from "./cli-contracts/enum-contracts.js";
import type { PmCloseActionOptions } from "./cli-contracts/typed-action-inputs.js";
import type { ContractsCommandOptions } from "./cli-contracts/runtime-contracts.js";
import type { UpdateResult } from "./lifecycle/update.js";
import type { ClaimResult, ReleaseResult } from "./lifecycle/claim.js";
import type { CloseResult } from "./lifecycle/close.js";
import type {
  SchemaAddFieldResult,
  SchemaAddStatusResult,
  SchemaAddTypeInferResult,
  SchemaAddTypeResult,
  SchemaApplyPresetResult,
  SchemaEvolutionMigrationResult,
  SchemaInspectResult,
  SchemaListFieldsResult,
  SchemaListResult,
  SchemaRemoveFieldResult,
  SchemaRemoveStatusResult,
  SchemaRemoveTypeResult,
  SchemaShowFieldResult,
  SchemaShowResult,
  SchemaShowStatusResult,
} from "./schema.js";

/** Options accepted by the SDK contracts snapshot helper. */
export interface GetContractsOptions extends ContractsCommandOptions {
  /** Explicit tracker root. */
  pmRoot?: string;
  /** Workspace resolution directory. */
  cwd?: string;
  /** Disable workspace extension discovery. */
  noExtensions?: boolean;
  /** Suppress non-result output. */
  quiet?: boolean;
  /** Include profile timing data. */
  profile?: boolean;
}

/** Options accepted by the workspace contract resolver. */
export interface WorkspaceContractsOptions {
  /** Pre-resolved extension registrations, or null to disable them. */
  extensionRegistrations?: ExtensionRegistrationRegistry | null;
  /** Disable workspace extension discovery. */
  noExtensions?: boolean;
  /** Workspace resolution directory. */
  cwd?: string;
}

/** Runtime-configured project contracts exposed to SDK consumers. */
export interface WorkspaceContracts {
  /** Active item type ids. */
  types: string[];
  /** Active lifecycle status ids. */
  statuses: string[];
  /** Status id representing the open lifecycle state. */
  openStatus: string;
  /** Status id representing the closed lifecycle state. */
  closeStatus: string;
  /** Status id representing the canceled lifecycle state. */
  canceledStatus: string;
  /** Runtime custom fields accepted by create and update actions. */
  fields?: WorkspaceFieldContract[];
  /** Activated extension commands available through generic dispatch. */
  extensionCommands?: WorkspaceExtensionCommandContract[];
}

/** Native or extension-contributed action accepted by generic dispatch. */
export type PmActionName = PmToolAction | (string & {});

/** Plain object option bag forwarded to the command runners used by MCP. */
export type PmActionOptions = Record<string, unknown>;

/** Union returned by the generic schema customization helper. */
export type SchemaResult =
  | SchemaInspectResult
  | SchemaListResult
  | SchemaShowResult
  | SchemaShowStatusResult
  | SchemaListFieldsResult
  | SchemaShowFieldResult
  | SchemaAddTypeResult
  | SchemaRemoveTypeResult
  | SchemaAddStatusResult
  | SchemaRemoveStatusResult
  | SchemaAddFieldResult
  | SchemaRemoveFieldResult
  | SchemaApplyPresetResult
  | SchemaAddTypeInferResult
  | SchemaEvolutionMigrationResult;

/** Result returned by the SDK `startTask` lifecycle shortcut. */
export interface StartTaskResult {
  /** Stable item identifier. */
  id: string;
  /** Lifecycle shortcut discriminator. */
  action: "start_task";
  /** Claim operation result. */
  claim: ClaimResult;
  /** Update operation result. */
  update: UpdateResult;
}

/** Result returned by the SDK `pauseTask` lifecycle shortcut. */
export interface PauseTaskResult {
  /** Stable item identifier. */
  id: string;
  /** Lifecycle shortcut discriminator. */
  action: "pause_task";
  /** Update operation result. */
  update: UpdateResult;
  /** Release operation result. */
  release: ReleaseResult;
}

/** Result returned by the SDK `closeTask` lifecycle shortcut. */
export interface CloseTaskResult {
  /** Stable item identifier. */
  id: string;
  /** Lifecycle shortcut discriminator. */
  action: "close_task";
  /** Close operation result. */
  close: CloseResult;
  /** Release operation result. */
  release: ReleaseResult;
}

/** Complete high-level action request for generic SDK dispatch. */
export type PmActionInput = PmActionOptions & {
  /** Native or extension-contributed action name. */
  action: PmActionName;
  /** Command-runner options after MCP-compatible normalization. */
  options?: PmActionOptions;
};

/** Per-call arguments accepted by the generic SDK client runner. */
export type PmClientRunArgs = Omit<PmActionInput, "action"> & {
  /** Return full changed-field arrays for mutation actions. */
  fullChangedFields?: boolean;
  /** Return only mutation item ids where supported. */
  idOnly?: boolean;
  /** The action is supplied as the runner's first parameter. */
  action?: never;
};

/** Close options excluding positional reason aliases. */
export type PmClientCloseActionOptions = Omit<PmCloseActionOptions, "reason" | "text">;

/** Command options accepted by mutation convenience methods. */
export type PmClientMutationOptions = PmActionOptions & {
  /** Return full changed-field arrays for this mutation. */
  fullChangedFields?: boolean;
  /** Return only mutation item ids where supported. */
  idOnly?: boolean;
};

/** Mutation options for helpers that always return full command envelopes. */
export type PmClientFullMutationOptions = Omit<PmClientMutationOptions, "fullChangedFields" | "idOnly">;

/** Options for atomic next-work selection. */
export interface ClaimNextOptions extends PmClientFullMutationOptions {
  /** Maximum ranked candidates to attempt, from 1 through 100 inclusive. */
  maxAttempts?: number | string;
}

/** Stable defaults applied by the reusable SDK client. */
export interface PmClientOptions {
  /** Tracker root passed as the SDK equivalent of `--pm-path`. */
  pmRoot?: string;
  /** Working directory used for workspace and extension resolution. */
  cwd?: string;
  /** Default mutation author forwarded when absent. */
  author?: string;
  /** Disable extension loading for every action. */
  noExtensions?: boolean;
}
