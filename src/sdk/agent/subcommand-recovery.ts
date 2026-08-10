/**
 * @module sdk/agent/subcommand-recovery
 *
 * Provides one SDK-owned refusal contract for unknown positional subcommands.
 */
import { levenshteinDistanceWithinLimit } from "../../core/shared/levenshtein.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import {
  PmCliError,
  type PmCliErrorRecoveryPayload,
} from "../../core/shared/errors.js";

/** Catalog-only alias retained for consumers of the former package lifecycle code. */
export const UNKNOWN_SUBCOMMAND_COMPATIBILITY_CODES = [
  { code: "unknown_lifecycle_action" },
] as const;

/** Inputs for constructing a portable unknown-subcommand refusal. */
export interface UnknownSubcommandErrorOptions {
  /** Command family path without the rejected token. */
  command_path: string;
  /** Rejected positional token. */
  token: string;
  /** Complete declared subcommand vocabulary for the family. */
  allowed: readonly string[];
  /** Human-readable command family, defaulting to `pm <command_path>`. */
  display_name?: string;
  /** Positional token role used in the compatibility message. */
  token_kind?: "subcommand" | "action" | "path";
  /** Arguments that follow the rejected token and should survive a retry. */
  trailing_args?: readonly string[];
  /** Family-aware retry that takes precedence over edit-distance recovery. */
  retry_command?: string;
  /** Compatibility suffix appended after the allowed-value sentence. */
  message_suffix?: string;
  /** Additional ranked recovery candidates supplied by the command family. */
  fallback_candidates?: PmCliErrorRecoveryPayload["fallback_candidates"];
  /** Transport exit used by non-CLI protocol adapters. */
  exit_code?: number;
  /** Additional family-specific examples. */
  examples?: readonly string[];
}

function nearestSubcommand(
  token: string,
  allowed: readonly string[],
): string | undefined {
  const normalized = token.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const maxDistance = Math.floor(normalized.length / 3);
  return allowed
    .map((candidate) => ({
      candidate,
      distance:
        levenshteinDistanceWithinLimit(
          normalized,
          candidate.toLowerCase(),
          maxDistance,
        ) ?? Number.POSITIVE_INFINITY,
    }))
    .filter(({ distance }) => Number.isFinite(distance))
    .sort((left, right) =>
      left.distance !== right.distance
        ? left.distance - right.distance
        : left.candidate.localeCompare(right.candidate),
    )[0]?.candidate;
}

function renderCommand(tokens: readonly string[]): string {
  return ["pm", ...tokens]
    .map((token) =>
      /^[A-Za-z0-9_./:@=-]+$/u.test(token) ? token : JSON.stringify(token),
    )
    .join(" ");
}

/** Build the shared typed refusal used by CLI, SDK, MCP, and packages. */
export function createUnknownSubcommandError(
  options: UnknownSubcommandErrorOptions,
): PmCliError {
  const commandPath = options.command_path.trim().replaceAll(/\s+/gu, " ");
  const normalizedToken = options.token.trim();
  const token = normalizedToken.length === 0 ? "<empty>" : normalizedToken;
  const allowed = [...new Set(options.allowed.map((value) => value.trim()))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  if (commandPath.length === 0 || token.length === 0 || allowed.length === 0) {
    throw new TypeError(
      "Unknown-subcommand contracts require a path, token, and allowed set",
    );
  }
  const commandTokens = commandPath.split(" ");
  const trailingArgs = options.trailing_args ?? [];
  const displayName = options.display_name ?? `pm ${commandPath}`;
  const tokenKind = options.token_kind ?? "subcommand";
  const nearest = options.retry_command
    ? undefined
    : nearestSubcommand(token, allowed);
  const attemptedCommand = renderCommand([
    ...commandTokens,
    token,
    ...trailingArgs,
  ]);
  const suggestedRetry =
    options.retry_command ??
    (nearest
      ? renderCommand([...commandTokens, nearest, ...trailingArgs])
      : undefined);
  return new PmCliError(
    `Unknown ${displayName} ${tokenKind} "${token}". Allowed: ${allowed.join(", ")}${options.message_suffix ?? ""}`,
    options.exit_code ?? EXIT_CODE.USAGE,
    {
      code: "unknown_subcommand",
      reason: "unknown_positional_token",
      examples: [
        ...(suggestedRetry ? [suggestedRetry] : []),
        ...(options.examples ?? []),
        `pm ${commandPath} --help`,
      ],
      nextSteps: suggestedRetry
        ? [`Retry with the suggested command: ${suggestedRetry}`]
        : ["Choose one value from recovery.allowed_values."],
      recovery: {
        attempted_command: attemptedCommand,
        allowed_values: allowed,
        suggested_retry: suggestedRetry,
        fallback_candidates: options.fallback_candidates,
      },
    },
  );
}

/** Test-only access to deterministic nearest-match behavior. */
export const _testOnly = { nearestSubcommand, renderCommand };
