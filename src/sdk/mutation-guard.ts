/**
 * @module sdk/mutation-guard
 *
 * Provides SDK-first pre-write provenance and secret-detection guardrails for
 * CLI, MCP, and package-owned mutation dispatchers.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";

/** Configurable handling mode for credential-shaped mutation content. */
export type SecretGuardMode = "off" | "advise" | "block";

/** Settings consumed by the shared mutation guard. */
export interface MutationGuardSettings {
  /** Reject mutations whose effective author is empty or `unknown`. */
  require_attributed_author: boolean;
  /** Detection policy for credential-shaped text. */
  secret_guard: SecretGuardMode;
  /** Age threshold used by stale in-progress governance checks. */
  stale_in_progress_hours: number;
}

/** One redacted credential-shaped match. Secret values are never returned. */
export interface SecretGuardFinding {
  /** Stable detector identifier suitable for tests and telemetry. */
  rule:
    | "github_token"
    | "private_key"
    | "aws_access_key"
    | "high_entropy_assignment";
  /** Object path or argument index containing the match. */
  path: string;
}

/** Result of a non-blocking or bypassed mutation guard evaluation. */
export interface MutationGuardResult {
  /** Effective author accepted by the guard. */
  author: string;
  /** Redacted detector matches. */
  findings: SecretGuardFinding[];
  /** Stable warning strings safe for stderr and structured warning arrays. */
  warnings: string[];
  /** Whether an explicit force override bypassed blocking secret policy. */
  override_applied: boolean;
}

/** Input accepted by the shared mutation guard. */
export interface EvaluateMutationGuardOptions {
  /** Effective mutation author after normal CLI/SDK precedence resolution. */
  author: string;
  /** Arbitrary mutation payload. Only string leaves are inspected. */
  payload: unknown;
  /** Workspace guard settings. */
  settings: MutationGuardSettings;
  /** Explicit, caller-visible override for a blocking secret finding. */
  force?: boolean;
}

/** Audit stream a native mutation must append when it changes durable state. */
export type MutationHistoryScope =
  | "item"
  | "workspace"
  | "history"
  | "conditional";

/** Executable provenance contract for one native state-changing action. */
export interface MutationActionContract {
  /** Canonical CLI/SDK/MCP action name. */
  action: string;
  /** Audit stream required when the action changes durable state. */
  history_scope: MutationHistoryScope;
}

const GITHUB_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const HIGH_ENTROPY_ASSIGNMENT_PATTERN =
  /\b(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{24,})/gi;

/**
 * Canonical native mutation inventory shared by guard dispatch, history
 * completeness gates, and integration hosts. `conditional` actions combine
 * read/diagnostic and write modes; they require history only when a durable
 * mutation occurs.
 */
export const PM_MUTATION_ACTION_CONTRACTS = [
  { action: "append", history_scope: "item" },
  { action: "claim", history_scope: "item" },
  { action: "close", history_scope: "item" },
  { action: "close-many", history_scope: "item" },
  { action: "close-task", history_scope: "item" },
  { action: "comments", history_scope: "conditional" },
  { action: "config", history_scope: "conditional" },
  { action: "copy", history_scope: "item" },
  { action: "create", history_scope: "item" },
  { action: "delete", history_scope: "item" },
  { action: "deps", history_scope: "conditional" },
  { action: "discover", history_scope: "item" },
  { action: "docs", history_scope: "conditional" },
  { action: "files", history_scope: "conditional" },
  { action: "focus", history_scope: "conditional" },
  { action: "gc", history_scope: "conditional" },
  { action: "history-compact", history_scope: "history" },
  { action: "history-redact", history_scope: "history" },
  { action: "history-repair", history_scope: "history" },
  { action: "init", history_scope: "workspace" },
  { action: "install", history_scope: "conditional" },
  { action: "learnings", history_scope: "conditional" },
  { action: "notes", history_scope: "conditional" },
  { action: "package", history_scope: "conditional" },
  { action: "pause-task", history_scope: "item" },
  { action: "plan", history_scope: "conditional" },
  { action: "profile", history_scope: "conditional" },
  { action: "release", history_scope: "item" },
  { action: "restore", history_scope: "item" },
  { action: "schema", history_scope: "conditional" },
  { action: "start-task", history_scope: "item" },
  { action: "templates", history_scope: "conditional" },
  { action: "test", history_scope: "conditional" },
  { action: "test-all", history_scope: "conditional" },
  { action: "update", history_scope: "item" },
  { action: "update-many", history_scope: "item" },
  { action: "upgrade", history_scope: "conditional" },
] as const satisfies readonly MutationActionContract[];

const MUTATION_ACTION_CONTRACTS_BY_NAME: ReadonlyMap<
  string,
  MutationActionContract
> = new Map(
  PM_MUTATION_ACTION_CONTRACTS.map((contract) => [
    contract.action,
    contract as MutationActionContract,
  ]),
);

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function stringLeaves(
  value: unknown,
  path = "$",
  seen: WeakSet<object> = new WeakSet<object>(),
): Array<{ path: string; value: string }> {
  if (typeof value === "string") {
    return [{ path, value }];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      stringLeaves(entry, `${path}[${index}]`, seen),
    );
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    stringLeaves(entry, `${path}.${key}`, seen),
  );
}

/** Detect credential-shaped string leaves without returning matched values. */
export function scanMutationSecrets(payload: unknown): SecretGuardFinding[] {
  const findings: SecretGuardFinding[] = [];
  for (const leaf of stringLeaves(payload)) {
    if (GITHUB_TOKEN_PATTERN.test(leaf.value)) {
      findings.push({ rule: "github_token", path: leaf.path });
    }
    if (PRIVATE_KEY_PATTERN.test(leaf.value)) {
      findings.push({ rule: "private_key", path: leaf.path });
    }
    if (AWS_ACCESS_KEY_PATTERN.test(leaf.value)) {
      findings.push({ rule: "aws_access_key", path: leaf.path });
    }
    HIGH_ENTROPY_ASSIGNMENT_PATTERN.lastIndex = 0;
    for (const match of leaf.value.matchAll(HIGH_ENTROPY_ASSIGNMENT_PATTERN)) {
      const candidate = match[1] as string;
      if (shannonEntropy(candidate) >= 3.5) {
        findings.push({
          rule: "high_entropy_assignment",
          path: leaf.path,
        });
        break;
      }
    }
  }
  return findings.filter(
    (finding, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.rule === finding.rule && candidate.path === finding.path,
      ) === index,
  );
}

/**
 * Enforce shared provenance and secret policy before a mutation is dispatched.
 * Detector failures are fail-open and surface a stable advisory.
 */
export function evaluateMutationGuard(
  options: EvaluateMutationGuardOptions,
): MutationGuardResult {
  const author = options.author.trim() || "unknown";
  if (
    options.settings.require_attributed_author &&
    author.toLowerCase() === "unknown"
  ) {
    throw new PmCliError(
      "Mutation author is required by workspace policy.",
      EXIT_CODE.USAGE,
      {
        code: "mutation_author_required",
        required:
          "Pass --author <id>, set PM_AUTHOR, or configure author_default.",
        nextSteps: [
          "Retry with --author <stable-agent-id>.",
          "Set PM_AUTHOR for this agent session.",
        ],
      },
    );
  }
  if (options.settings.secret_guard === "off") {
    return {
      author,
      findings: [],
      warnings: [],
      override_applied: false,
    };
  }
  let findings: SecretGuardFinding[];
  try {
    findings = scanMutationSecrets(options.payload);
  } catch {
    return {
      author,
      findings: [],
      warnings: ["secret_guard_scan_failed_open"],
      override_applied: false,
    };
  }
  if (findings.length === 0) {
    return {
      author,
      findings,
      warnings: [],
      override_applied: false,
    };
  }
  const ruleSummary = [...new Set(findings.map((finding) => finding.rule))]
    .sort()
    .join(",");
  if (options.settings.secret_guard === "block" && options.force !== true) {
    throw new PmCliError(
      `Mutation blocked by secret guard (${ruleSummary}). No detected value was logged.`,
      EXIT_CODE.CONFLICT,
      {
        code: "mutation_secret_guard_blocked",
        required:
          "Remove the credential-shaped content or retry with --force after explicit review.",
        nextSteps: [
          "Replace the value with a secret-manager reference.",
          "Use pm history-redact if equivalent content already entered history.",
        ],
        recovery: {
          recovery_mode: "compact",
          attempted_command: "pm <mutation> [REDACTED]",
          normalized_args: ["[REDACTED]"],
          suggested_retry:
            "Remove credential-shaped content, then retry the mutation.",
        },
      },
    );
  }
  return {
    author,
    findings,
    warnings: [
      `secret_guard_detected:${findings.length}:rules=${ruleSummary}`,
      ...(options.settings.secret_guard === "block" && options.force === true
        ? ["secret_guard_force_override"]
        : []),
    ],
    override_applied:
      options.settings.secret_guard === "block" && options.force === true,
  };
}

/** Identify native actions that can persist tracker or workspace state. */
export function isMutationAction(action: string): boolean {
  return MUTATION_ACTION_CONTRACTS_BY_NAME.has(action.trim().toLowerCase());
}

/** Return the canonical, stable native mutation-action inventory. */
export function listMutationActions(): string[] {
  return [...MUTATION_ACTION_CONTRACTS_BY_NAME.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** Resolve the history contract for one native mutation action. */
export function getMutationActionContract(
  action: string,
): MutationActionContract | undefined {
  return MUTATION_ACTION_CONTRACTS_BY_NAME.get(action.trim().toLowerCase());
}
