/**
 * @module sdk/cli-contracts/completeness
 *
 * Derives a bidirectional parameter-coverage matrix between the public CLI
 * flag contracts and strict SDK action schemas. Every non-shared input carries
 * a bounded, machine-readable disposition so compatibility gaps cannot hide in
 * a hand-picked test list.
 */
import { PM_TOOL_ACTIONS, type PmToolAction } from "./enum-contracts.js";
import {
  resolveSubcommandFlagContractsForCommand,
  type CliFlagContract,
} from "./flag-contracts.js";
import { pmToolActionParameterKeys } from "./tool-schema.js";

/** Classification assigned to one CLI or SDK parameter. */
export type SdkCliParameterDisposition =
  | "shared"
  | "compatibility_alias"
  | "cli_transport"
  | "cli_presentation"
  | "cli_adapter"
  | "cli_scope_selector"
  | "sdk_transport"
  | "cli_positional"
  | "sdk_native"
  | "unclassified";

/** One directional input in the SDK/CLI parameter-coverage matrix. */
export interface SdkCliParameterCoverageEntry {
  /** Surface where the input is declared. */
  surface: "cli" | "sdk";
  /** CLI flag or SDK parameter name. */
  input: string;
  /** Equivalent input on the other surface when one exists. */
  counterpart?: string;
  /** Machine-readable coverage or waiver classification. */
  disposition: SdkCliParameterDisposition;
  /** Stable explanation suitable for a contract report or CI failure. */
  reason: string;
}

/** Complete bidirectional parameter coverage for one public action. */
export interface SdkCliActionParameterCoverage {
  /** Public SDK action. */
  action: PmToolAction;
  /** CLI command path associated with the action. */
  command: string;
  /** Every canonical CLI long flag and its disposition. */
  cli: SdkCliParameterCoverageEntry[];
  /** Every strict SDK action parameter and its disposition. */
  sdk: SdkCliParameterCoverageEntry[];
  /** Inputs lacking an approved bidirectional disposition. */
  unclassified: SdkCliParameterCoverageEntry[];
}

/** Injectable contract readers used by negative controls and downstream gates. */
export interface SdkCliCompletenessContractSource {
  /** Actions to analyze. */
  actions?: readonly PmToolAction[];
  /** Resolve long-flag contracts for a CLI command path. */
  resolveFlags?: (command: string) => CliFlagContract[];
  /** Resolve strict SDK parameters for an action. */
  resolveParameters?: (action: PmToolAction) => string[] | undefined;
}

const CLI_TRANSPORT_FLAGS = new Set([
  "--author",
  "--follow",
  "--help",
  "--lean",
  "--no-changed-fields",
  "--no-extensions",
  "--no-pager",
  "--pm-path",
  "--profile",
  "--quiet",
  "--interval-ms",
]);

const CLI_PRESENTATION_FLAGS = new Set([
  "--brief",
  "--format",
  "--full",
  "--full-changed-fields",
  "--id-only",
  "--no-truncate",
  "--stream",
]);

const CLI_ADAPTER_FLAGS = new Set(["--body-file", "--file", "--stdin-json"]);

const CLI_SCOPE_SELECTOR_FLAGS = new Set(["--global", "--local", "--project"]);

const CLI_CONFIG_SHORTHAND_FLAGS = new Set([
  "--activity-limit",
  "--default-depth",
  "--section-activity",
  "--section-blockers",
  "--section-files",
  "--section-hierarchy",
  "--section-progress",
  "--section-staleness",
  "--section-tests",
  "--section-workload",
  "--stale-threshold-days",
]);

const SDK_TRANSPORT_PARAMETERS = new Set([
  "action",
  "path",
  "pmExecutable",
  "timeoutMs",
]);

const CLI_POSITIONAL_PARAMETERS = new Set([
  "configAction",
  "id",
  "name",
  "query",
  "reason",
  "subcommand",
  "target",
  "text",
]);

const ACTION_POSITIONAL_PARAMETERS: Readonly<
  Partial<Record<PmToolAction, Readonly<Record<string, string>>>>
> = {
  event: { title: "<title>" },
  meet: { title: "<title>" },
  merge: { subcommand: "<subcommand>" },
  remind: { title: "<title>" },
  workspace: {
    name: "<name>",
    subcommand: "snapshot",
    snapshotAction: "<snapshot-action>",
    target: "<target>",
  },
};

const ACTION_FLAG_PARAMETER_OVERRIDES: Readonly<
  Partial<Record<PmToolAction, Readonly<Record<string, string>>>>
> = {
  init: {
    "--id-prefix": "idPrefix",
    "--no-merge-fence": "mergeFence",
    "--workspace": "workspace",
  },
  create: {
    "--ac": "acceptanceCriteria",
    "--estimated-minutes": "estimate",
    "--file": "linkedFile",
    "--test": "linkedTest",
    "--expected": "expectedResult",
    "--actual": "actualResult",
  },
  update: {
    "--ac": "acceptanceCriteria",
    "--estimated-minutes": "estimate",
    "--file": "linkedFile",
    "--test": "linkedTest",
    "--expected": "expectedResult",
    "--actual": "actualResult",
  },
  "update-many": {
    "--ac": "acceptanceCriteria",
    "--estimated-minutes": "estimate",
    "--file": "linkedFile",
    "--test": "linkedTest",
    "--expected": "expectedResult",
    "--actual": "actualResult",
  },
  files: { "--note": "addNote" },
  docs: { "--note": "addNote" },
  notes: { "--file": "text" },
  gc: { "--scope": "gcScope" },
  contracts: { "--action": "contractAction" },
  schema: {
    "--no-allow-unset": "allowUnset",
    "--type": "fieldTypeScope",
  },
  "history-author-acknowledge": {
    "--event": "historyEvent",
    "--all-actionable": "allActionable",
  },
  "extension-init": { "--capability": "capability" },
  "package-init": { "--capability": "capability" },
  "extension-install": { "--gh": "github" },
  "package-install": { "--gh": "github" },
  "extension-adopt": { "--gh": "github" },
  "package-adopt": { "--gh": "github" },
  extension: { "--gh": "github", "--scaffold": "init" },
  package: { "--gh": "github", "--scaffold": "init" },
  install: { "--gh": "github" },
};

function actionCommand(action: PmToolAction): string {
  if (action.startsWith("extension-")) {
    return `extension ${action.slice("extension-".length)}`;
  }
  if (action.startsWith("package-")) {
    return `package ${action.slice("package-".length)}`;
  }
  return action;
}

function parameterForFlag(action: PmToolAction, flag: string): string {
  const override = ACTION_FLAG_PARAMETER_OVERRIDES[action]?.[flag];
  if (override !== undefined) return override;
  return flag
    .replace(/^--/, "")
    .replaceAll("_", "-")
    .replace(/-([a-z])/g, (_match, value: string) => value.toUpperCase());
}

function canonicalLongFlags(contracts: CliFlagContract[]): CliFlagContract[] {
  const seen = new Set<string>();
  return contracts.filter(({ flag }) => {
    if (!flag.startsWith("--") || seen.has(flag)) return false;
    seen.add(flag);
    return true;
  });
}

function aliasTarget(
  flag: string,
  contracts: CliFlagContract[],
): string | undefined {
  return contracts.find(({ aliases }) => aliases?.includes(flag))?.flag;
}

function classifyCliInput(
  action: PmToolAction,
  contract: CliFlagContract,
  contracts: CliFlagContract[],
  sdkParameters: ReadonlySet<string>,
): SdkCliParameterCoverageEntry {
  const parameter = parameterForFlag(action, contract.flag);
  if (sdkParameters.has(parameter)) {
    return {
      surface: "cli",
      input: contract.flag,
      counterpart: parameter,
      disposition: "shared",
      reason: "The CLI flag maps directly to a strict SDK action parameter.",
    };
  }
  const canonicalAlias = aliasTarget(contract.flag, contracts);
  if (canonicalAlias !== undefined) {
    const aliasParameter = parameterForFlag(action, canonicalAlias);
    if (sdkParameters.has(aliasParameter)) {
      return {
        surface: "cli",
        input: contract.flag,
        counterpart: aliasParameter,
        disposition: "compatibility_alias",
        reason: `Compatibility spelling for ${canonicalAlias}.`,
      };
    }
  }
  if (CLI_TRANSPORT_FLAGS.has(contract.flag)) {
    return {
      surface: "cli",
      input: contract.flag,
      disposition: "cli_transport",
      reason: "CLI process transport is supplied by the in-process SDK host.",
    };
  }
  if (CLI_PRESENTATION_FLAGS.has(contract.flag)) {
    return {
      surface: "cli",
      input: contract.flag,
      disposition: "cli_presentation",
      reason:
        "CLI rendering or mutation projection does not alter the SDK result envelope.",
    };
  }
  if (CLI_ADAPTER_FLAGS.has(contract.flag)) {
    return {
      surface: "cli",
      input: contract.flag,
      disposition: "cli_adapter",
      reason: "Local file or stdin adaptation is a CLI boundary concern.",
    };
  }
  if (CLI_CONFIG_SHORTHAND_FLAGS.has(contract.flag)) {
    return {
      surface: "cli",
      input: contract.flag,
      counterpart: "key",
      disposition: "compatibility_alias",
      reason:
        "CLI config shorthand normalizes to the SDK configAction/key/value contract.",
    };
  }
  if (CLI_SCOPE_SELECTOR_FLAGS.has(contract.flag)) {
    return {
      surface: "cli",
      input: contract.flag,
      counterpart: "scope",
      disposition: "cli_scope_selector",
      reason:
        "Mutually exclusive CLI scope switches normalize to the SDK scope parameter.",
    };
  }
  return {
    surface: "cli",
    input: contract.flag,
    counterpart: parameter,
    disposition: "unclassified",
    reason:
      "The CLI flag has no strict SDK parameter or approved boundary classification.",
  };
}

function classifySdkInput(
  action: PmToolAction,
  parameter: string,
  cliEntries: SdkCliParameterCoverageEntry[],
): SdkCliParameterCoverageEntry {
  const cliCounterpart = cliEntries.find(
    ({ counterpart, disposition }) =>
      counterpart === parameter &&
      (disposition === "shared" ||
        disposition === "compatibility_alias" ||
        disposition === "cli_scope_selector"),
  );
  if (cliCounterpart !== undefined) {
    return {
      surface: "sdk",
      input: parameter,
      counterpart: cliCounterpart.input,
      disposition: "shared",
      reason: "The strict SDK parameter is reachable from the CLI contract.",
    };
  }
  const positionalCounterpart =
    ACTION_POSITIONAL_PARAMETERS[action]?.[parameter];
  if (positionalCounterpart !== undefined) {
    return {
      surface: "sdk",
      input: parameter,
      counterpart: positionalCounterpart,
      disposition: "shared",
      reason:
        "The strict SDK parameter maps to a canonical CLI positional argument.",
    };
  }
  if (SDK_TRANSPORT_PARAMETERS.has(parameter)) {
    return {
      surface: "sdk",
      input: parameter,
      disposition: "sdk_transport",
      reason:
        "The SDK host supplies in-process transport and workspace selection.",
    };
  }
  if (CLI_POSITIONAL_PARAMETERS.has(parameter)) {
    return {
      surface: "sdk",
      input: parameter,
      disposition: "cli_positional",
      reason:
        "The CLI accepts this SDK parameter as a positional command argument.",
    };
  }
  return {
    surface: "sdk",
    input: parameter,
    disposition: "sdk_native",
    reason:
      "The typed SDK exposes this structured input without a canonical CLI long flag.",
  };
}

/**
 * Analyze every public action from live CLI and strict schema contracts.
 *
 * Unknown CLI flags fail closed as `unclassified`; SDK-only inputs remain
 * visible as per-parameter `sdk_native` dispositions for shrinking baselines.
 */
export function analyzeSdkCliParameterCompleteness(
  source: SdkCliCompletenessContractSource = {},
): SdkCliActionParameterCoverage[] {
  const actions = source.actions ?? PM_TOOL_ACTIONS;
  const resolveFlags =
    source.resolveFlags ?? resolveSubcommandFlagContractsForCommand;
  const resolveParameters =
    source.resolveParameters ?? pmToolActionParameterKeys;

  return actions.map((action) => {
    const command = actionCommand(action);
    const flagContracts = canonicalLongFlags(resolveFlags(command));
    const sdkParameters = new Set(resolveParameters(action) ?? []);
    const cli = flagContracts.map((contract) =>
      classifyCliInput(action, contract, flagContracts, sdkParameters),
    );
    const sdk = [...sdkParameters]
      .sort((left, right) => left.localeCompare(right))
      .map((parameter) => classifySdkInput(action, parameter, cli));
    return {
      action,
      command,
      cli,
      sdk,
      unclassified: [...cli, ...sdk].filter(
        ({ disposition }) => disposition === "unclassified",
      ),
    };
  });
}
