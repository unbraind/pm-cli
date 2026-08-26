/**
 * @module sdk/agent/closed-domain-contracts
 *
 * Declares executable closed-domain refusals once for SDK consumers, CLI help,
 * and repository assurance. Runtime schema fields can extend field domains
 * without changing the stable core corpus.
 */
import { PM_CONTEXT_INTENT_CONTRACTS } from "../context-intent-contracts.js";
import {
  LIST_COMMAND_DEFAULT_PROJECTIONS,
  listGetProjectionFields,
  listListProjectionFields,
  listSearchProjectionFields,
} from "../query/projection-contracts.js";

/** A closed-domain refusal that can be executed and recovered automatically. */
export interface PmClosedDomainContract {
  /** Stable assurance identity. */
  probe_id: string;
  /** Public command accepting the constrained flag. */
  command: string;
  /** Constrained option spelling. */
  flag: string;
  /** Invalid token used to prove the refusal path. */
  rejected_value: string;
  /** Exact argv that must refuse the invalid token. */
  refusal_args: readonly string[];
  /** Complete stable core domain accepted by the command. */
  allowed_values: readonly string[];
  /** Exact argv expected in the refusal's executable recovery. */
  suggested_retry_args: readonly string[];
  /** Stable machine-readable error code that owns the refusal. */
  error_code:
    | "projection_options_mutually_exclusive"
    | "unknown_context_intent"
    | "unknown_field_projection";
  /** Whether a complete accepted-value domain is required in the refusal. */
  allowed_values_required?: boolean;
}

const REJECTED_INTENT = "not-a-declared-intent";
const REJECTED_FIELD = "not-a-declared-field";

/** Return the complete stable core refusal corpus shared by every public surface. */
export function listCoreClosedDomainContracts(): PmClosedDomainContract[] {
  const positionalArguments: Readonly<Record<string, readonly string[]>> = {
    get: ["pm-domain"],
    search: ["Domain query"],
  };
  const intentContracts = [
    ...new Set(PM_CONTEXT_INTENT_CONTRACTS.map(({ command }) => command)),
  ].map((command) => {
    const commandContracts = PM_CONTEXT_INTENT_CONTRACTS.filter(
      (candidate) => candidate.command === command,
    );
    const contract = commandContracts[0]!;
    const positionals = positionalArguments[contract.command] ?? [];
    return {
      probe_id: `${contract.command}-invalid-intent`,
      command: contract.command,
      flag: "--for" as const,
      rejected_value: REJECTED_INTENT,
      refusal_args: [
        contract.command,
        ...positionals,
        "--for",
        REJECTED_INTENT,
      ],
      allowed_values: commandContracts.map(({ intent }) => intent).sort(),
      suggested_retry_args: [
        contract.command,
        ...positionals,
        "--for",
        contract.intent,
      ],
      error_code: "unknown_context_intent" as const,
    };
  });
  const listFields = listListProjectionFields();
  const listFieldContracts = Object.keys(LIST_COMMAND_DEFAULT_PROJECTIONS).map(
    (command) => ({
      probe_id: `${command}-invalid-field`,
      command,
      flag: "--fields" as const,
      rejected_value: REJECTED_FIELD,
      refusal_args: [command, "--fields", REJECTED_FIELD],
      allowed_values: listFields,
      suggested_retry_args: [
        command,
        "--fields",
        "id,title,status",
        "--limit",
        "10",
      ],
      error_code: "unknown_field_projection" as const,
    }),
  );
  const contracts: PmClosedDomainContract[] = [
    ...intentContracts,
    ...listFieldContracts,
    {
      probe_id: "get-invalid-field",
      command: "get",
      flag: "--fields",
      rejected_value: REJECTED_FIELD,
      refusal_args: ["get", "pm-domain", "--fields", REJECTED_FIELD],
      allowed_values: listGetProjectionFields(),
      suggested_retry_args: ["get", "pm-domain", "--fields", "id,title,status"],
      error_code: "unknown_field_projection",
    },
    {
      probe_id: "list-mutually-exclusive-projection",
      command: "list",
      flag: "--projection",
      rejected_value: "--brief+--full",
      refusal_args: ["list", "--brief", "--full"],
      allowed_values: [],
      suggested_retry_args: ["list", "--brief"],
      error_code: "projection_options_mutually_exclusive",
      allowed_values_required: false,
    },
    {
      probe_id: "get-mutually-exclusive-projection",
      command: "get",
      flag: "--projection",
      rejected_value: "--full+--fields",
      refusal_args: ["get", "pm-domain", "--full", "--fields", "id"],
      allowed_values: [],
      suggested_retry_args: ["get", "pm-domain", "--full"],
      error_code: "projection_options_mutually_exclusive",
      allowed_values_required: false,
    },
    {
      probe_id: "search-mutually-exclusive-projection",
      command: "search",
      flag: "--projection",
      rejected_value: "--full+--fields",
      refusal_args: ["search", "Domain query", "--full", "--fields", "id"],
      allowed_values: [],
      suggested_retry_args: ["search", "Domain query", "--full"],
      error_code: "projection_options_mutually_exclusive",
      allowed_values_required: false,
    },
    {
      probe_id: "package-upgrade-mutually-exclusive-modes",
      command: "package upgrade",
      flag: "--projection",
      rejected_value: "--cli-only+--packages-only",
      refusal_args: [
        "package",
        "upgrade",
        "--cli-only",
        "--packages-only",
        "--dry-run",
      ],
      allowed_values: [],
      suggested_retry_args: [
        "package",
        "upgrade",
        "--packages-only",
        "--dry-run",
      ],
      error_code: "projection_options_mutually_exclusive",
      allowed_values_required: false,
    },
    {
      probe_id: "search-invalid-field",
      command: "search",
      flag: "--fields",
      rejected_value: REJECTED_FIELD,
      refusal_args: ["search", "Domain query", "--fields", REJECTED_FIELD],
      allowed_values: listSearchProjectionFields(),
      suggested_retry_args: [
        "search",
        "Domain query",
        "--fields",
        "id,title,status,score",
      ],
      error_code: "unknown_field_projection",
    },
  ];
  return contracts.sort((left, right) =>
    left.probe_id.localeCompare(right.probe_id),
  );
}

/** Render a compact but complete core-domain description for command help. */
export function renderPmClosedDomainHelp(
  command: string,
  flag: "--fields" | "--for",
): string {
  const contract = listCoreClosedDomainContracts().find(
    (candidate) => candidate.command === command && candidate.flag === flag,
  );
  if (!contract) return "No stable core values are declared.";
  const canonicalValues = contract.allowed_values.filter(
    (value) => !value.startsWith("item."),
  );
  const runtimeSuffix =
    flag === "--fields"
      ? " item.<field> aliases and configured runtime metadata fields are also accepted."
      : " Configured package and workspace intents may extend this domain.";
  return `Allowed core values: ${canonicalValues.join("|")}.${runtimeSuffix}`;
}
