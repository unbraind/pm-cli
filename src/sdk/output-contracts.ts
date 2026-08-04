/**
 * @module sdk/output-contracts
 *
 * Defines portable result-envelope contracts and safe mutation receipt parsing
 * for CLI, SDK, MCP, and package consumers.
 */
import { PM_CORE_COMMAND_NAMES } from "./cli-contracts/enum-contracts.js";

/** Stable machine-readable result families used across pm transports. */
export const PM_OUTPUT_ENVELOPE_KINDS = [
  "mutation_receipt",
  "entity",
  "collection",
  "diagnostic",
  "stream",
] as const;

/** Restricts portable result-envelope families. */
export type PmOutputEnvelopeKind = (typeof PM_OUTPUT_ENVELOPE_KINDS)[number];

/** Describes how one command exposes its default machine-readable result. */
export interface PmCommandOutputEnvelopeContract {
  /** Canonical command path. */
  command: string;
  /** Semantic result family. */
  kind: PmOutputEnvelopeKind;
  /** Root key carrying the primary value, or null for a flat receipt/stream. */
  wrapper_key: string | null;
  /** Whether the output can carry multiple primary rows. */
  cardinality: "one" | "many" | "none";
  /** Stable format-flag spelling accepted by every command. */
  format_flag: "--json";
}

/** Normalized SDK representation of the flat CLI mutation receipt. */
export interface PmMutationReceipt {
  /** Mutated item or plan identifier. */
  id: string;
  /** Resulting lifecycle status or deletion outcome. */
  status: string;
  /** Number of fields changed by the mutation. */
  changedFieldCount: number;
  /** Persisted close reason when the command closed work. */
  closeReason?: string;
  /** Whether a destructive mutation removed its target. */
  deleted?: boolean;
  /** Status before the mutation when the command reports it. */
  previousStatus?: string;
  /** Non-fatal mutation warnings retained by the transport. */
  warnings?: readonly unknown[];
}

/** Wire representation emitted by CLI mutation commands in JSON mode. */
export interface PmCliMutationReceipt {
  /** Mutated item or plan identifier. */
  id: string;
  /** Resulting lifecycle status or deletion outcome. */
  status: string;
  /** Number of fields changed by the mutation. */
  changed_field_count: number;
  /** Persisted close reason when the command closed work. */
  close_reason?: string;
  /** Whether a destructive mutation removed its target. */
  deleted?: boolean;
  /** Status before the mutation when the command reports it. */
  previous_status?: string;
  /** Non-fatal mutation warnings retained by the transport. */
  warnings?: readonly unknown[];
}

const MUTATION_COMMANDS = new Set([
  "append",
  "claim",
  "close",
  "copy",
  "create",
  "delete",
  "release",
  "restore",
  "update",
]);

const COLLECTION_COMMANDS = new Set([
  "activity",
  "comments",
  "contracts",
  "events",
  "history",
  "learnings",
  "list",
  "notes",
  "search",
]);

const DIAGNOSTIC_COMMANDS = new Set([
  "aggregate",
  "deps",
  "graph",
  "health",
  "stats",
  "validate",
]);

/** Validate and preserve one package-authored output-envelope declaration. */
export function definePmCommandOutputEnvelope<
  TContract extends PmCommandOutputEnvelopeContract,
>(contract: TContract): TContract {
  if (contract.command.trim().length === 0) {
    throw new TypeError("command must be a non-empty command path");
  }
  if (!PM_OUTPUT_ENVELOPE_KINDS.includes(contract.kind)) {
    throw new TypeError(`Unsupported output envelope kind: ${contract.kind}`);
  }
  return contract;
}

function createOutputEnvelopeContract(
  command: string,
): PmCommandOutputEnvelopeContract {
  const normalizedCommand = command.trim().replace(/\s+/gu, " ");
  const [rootCommand = normalizedCommand] = normalizedCommand.split(" ");
  if (MUTATION_COMMANDS.has(rootCommand)) {
    return definePmCommandOutputEnvelope({
      command: normalizedCommand,
      kind: "mutation_receipt",
      wrapper_key: null,
      cardinality: "one",
      format_flag: "--json",
    });
  }
  if (COLLECTION_COMMANDS.has(rootCommand)) {
    return definePmCommandOutputEnvelope({
      command: normalizedCommand,
      kind: "collection",
      wrapper_key: rootCommand === "contracts" ? null : "items",
      cardinality: "many",
      format_flag: "--json",
    });
  }
  if (DIAGNOSTIC_COMMANDS.has(rootCommand)) {
    return definePmCommandOutputEnvelope({
      command: normalizedCommand,
      kind: "diagnostic",
      wrapper_key: null,
      cardinality: "none",
      format_flag: "--json",
    });
  }
  return definePmCommandOutputEnvelope({
    command: normalizedCommand,
    kind: rootCommand === "get" ? "entity" : "diagnostic",
    wrapper_key: rootCommand === "get" ? "item" : null,
    cardinality: rootCommand === "get" ? "one" : "none",
    format_flag: "--json",
  });
}

/** Default envelope declaration for every built-in command. */
export const PM_COMMAND_OUTPUT_ENVELOPE_CONTRACTS = PM_CORE_COMMAND_NAMES.map(
  (command) => createOutputEnvelopeContract(command),
);

const OUTPUT_ENVELOPE_BY_COMMAND = new Map(
  PM_COMMAND_OUTPUT_ENVELOPE_CONTRACTS.map(
    (contract) => [contract.command, contract] as const,
  ),
);

/** Resolve a built-in envelope or generate a conservative package fallback. */
export function resolvePmCommandOutputEnvelope(
  command: string,
): PmCommandOutputEnvelopeContract {
  const normalized = command.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    throw new TypeError("command must be a non-empty command path");
  }
  const [rootCommand = normalized] = normalized.split(" ");
  return (
    OUTPUT_ENVELOPE_BY_COMMAND.get(rootCommand) ??
    createOutputEnvelopeContract(normalized)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return whether an unknown value is the flat CLI mutation receipt shape. */
export function isPmMutationReceipt(
  value: unknown,
): value is PmCliMutationReceipt {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.status === "string" &&
    value.status.length > 0 &&
    Number.isSafeInteger(value.changed_field_count) &&
    Number(value.changed_field_count) >= 0 &&
    (value.close_reason === undefined ||
      typeof value.close_reason === "string") &&
    (value.deleted === undefined || typeof value.deleted === "boolean") &&
    (value.previous_status === undefined ||
      typeof value.previous_status === "string") &&
    (value.warnings === undefined || Array.isArray(value.warnings))
  );
}

/**
 * Parse and normalize the flat JSON receipt emitted by mutation commands.
 * Wrapped read envelopes are rejected so a wrong consumer assumption fails at
 * the integration boundary instead of silently returning an undefined id.
 */
export function parseMutationReceipt(
  input: string | unknown,
): PmMutationReceipt {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new TypeError(
        `Mutation receipt must be valid JSON: ${String(error)}`,
        { cause: error },
      );
    }
  }
  if (!isPmMutationReceipt(value)) {
    throw new TypeError(
      "Mutation receipt must be a flat object with top-level id, status, and changed_field_count fields",
    );
  }
  return {
    id: value.id,
    status: value.status,
    changedFieldCount: value.changed_field_count,
    ...(typeof value.close_reason === "string"
      ? { closeReason: value.close_reason }
      : {}),
    ...(typeof value.deleted === "boolean" ? { deleted: value.deleted } : {}),
    ...(typeof value.previous_status === "string"
      ? { previousStatus: value.previous_status }
      : {}),
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings } : {}),
  };
}
