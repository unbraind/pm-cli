/**
 * @module sdk/mutation-guard
 *
 * Provides SDK-first pre-write provenance and secret-detection guardrails for
 * CLI, MCP, and package-owned mutation dispatchers.
 */
import { SECRET_RULES, acceptsStructuredValue, findSecretRuleMatches, structuredKeyShape, type SecretNormalizationKind, type SecretRule, type SecretRuleMatch } from "../core/shared/secret-rules.js";
export type { SecretNormalizationKind } from "../core/shared/secret-rules.js";
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
  rule: (typeof SECRET_RULES)[number]["mutationRule"];
  /** Object path or argument index containing the match. */
  path: string;
  /** Detection-only transformations, without original or decoded coordinate values. */
  normalizations?: SecretNormalizationKind[];
  /** Remaining encoded input exceeded the finite inspection envelope and requires explicit review. */
  normalization_incomplete?: true;
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
  /**
   * Arbitrary mutation payload. String leaves are inspected on their own, and
   * a leaf under a property whose name ends with a credential key is also
   * judged as that key's value, as in its JSON spelling `{"<name>": <value>}`.
   */
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
  { action: "history-author-acknowledge", history_scope: "workspace" },
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

/** One payload value waiting to be walked, with its path. */
interface PayloadStep {
  /** Payload value. */
  value: unknown;
  /** Payload path of the value. */
  path: string;
}

/** A canonical array index property name (`0`, `17`), never `01`, `-1` or `length`. */
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;

/**
 * The direct children of an array or of an object's own enumerable
 * properties, in order. An array is read through its own index keys, never
 * through its own (possibly overridden) methods, so holes are skipped and a
 * sparse array with a huge length costs only its present elements.
 */
function childSteps(value: object, path: string): PayloadStep[] {
  if (Array.isArray(value)) {
    return Object.keys(value)
      .filter((key) => ARRAY_INDEX.test(key))
      .map((key) => ({ value: (value as unknown[])[Number(key)], path: `${path}[${key}]` }));
  }
  return Object.entries(value).map(([key, entry]) => ({ value: entry as unknown, path: `${path}.${key}` }));
}

/**
 * Collect string leaves with payload paths, depth first, visiting each object
 * only once. The walk keeps its own stack, so payload depth is never limited
 * by the call stack (pm-wq9njf) and a deep payload cannot make the scan fail
 * open.
 */
function stringLeaves(payload: unknown): Array<{ path: string; value: string }> {
  const leaves: Array<{ path: string; value: string }> = [];
  const seen = new WeakSet<object>();
  const pending: PayloadStep[] = [{ value: payload, path: "$" }];
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    const { value, path } = step;
    if (typeof value === "string") {
      leaves.push({ path, value });
    } else if (typeof value === "object" && value !== null && !seen.has(value)) {
      seen.add(value);
      pushReversed(pending, childSteps(value, path));
    }
  }
  return leaves;
}

/** Push in reverse, one at a time, so the first child is walked first and a wide object never spreads into one call. */
function pushReversed<T>(pending: T[], children: readonly T[]): void {
  for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
}

/** Keep credential matching lazy while preserving incomplete inspection anywhere in a home-path leaf. */
function preflightRuleMatch(rule: SecretRule, value: string): SecretRuleMatch | undefined {
  const matches = findSecretRuleMatches(rule, value);
  const first = matches.next().value;
  if (!first || rule.mutationRule !== "absolute_home_path" || first.normalization_incomplete) return first;
  for (const later of matches) {
    if (later.normalization_incomplete) {
      return {
        ...first,
        normalizations: [...new Set([first.normalizations, later.normalizations].flatMap((kinds) => kinds ?? []))],
        normalization_incomplete: true,
      };
    }
  }
  return first;
}

/** Each string leaf judged by every rule on its own text. */
function scanStringLeaves(payload: unknown): SecretGuardFinding[] {
  const findings: SecretGuardFinding[] = [];
  for (const leaf of stringLeaves(payload)) {
    for (const rule of SECRET_RULES) {
      const match = preflightRuleMatch(rule, leaf.value);
      if (match) {
        const finding: SecretGuardFinding = { rule: rule.mutationRule, path: leaf.path };
        if (match.normalizations) finding.normalizations = match.normalizations;
        if (match.normalization_incomplete) finding.normalization_incomplete = true;
        findings.push(finding);
      }
    }
  }
  return findings;
}

/**
 * Key-named rules (password_assignment, high_entropy_assignment,
 * credential_key_assignment) need the key and its value together. A text
 * field carries both in its own text, but a structured SDK or MCP payload
 * carries the key only as a property name, so these rules also judge string
 * leaves under a property whose name ends with one of their keys.
 */
const KEY_NAMED_RULES = SECRET_RULES.filter(
  (rule): rule is Extract<(typeof SECRET_RULES)[number], { structured: unknown }> => "structured" in rule,
);

/** Credential-key context one key-named rule inherits from ancestor members. */
interface KeyContext {
  /** Some ancestor property name ends with one of the rule's keys. */
  readonly named: boolean;
  /** Some such name is the key word alone (`password`), not a prefixed key (`admin-password`). */
  readonly exact: boolean;
}

/** How a key-named rule judges one string leaf; undefined when no credential key names it. */
type LeafJudgment = "lenient" | "compact" | undefined;

const NO_KEY_CONTEXT: readonly KeyContext[] = KEY_NAMED_RULES.map(() => ({ named: false, exact: false }));

/** Word boundaries inside a camelCase or PascalCase name, including the end of an acronym (`HTTP|Token`). */
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/gu;

/** A credential key spans at most this many trailing camelCase words (`SecretAccessKey`). */
const CREDENTIAL_SUFFIX_WORDS = 3;

/**
 * Split camelCase and PascalCase words with `_`, so `accessToken`,
 * `clientSecret` and `HTTPToken` read like `access_token`, `client_secret` and
 * `HTTP_token`; snake, kebab and CONSTANT_CASE names are unchanged.
 */
function keyWords(name: string): string {
  return name.replace(CAMEL_BOUNDARY, "_");
}

/**
 * The spellings a property name is read in: as written, fully split, and with
 * only a prefix split before each of the last few word boundaries, so a
 * compound key the rules read unsplit survives a camelCase prefix
 * (`dbPassPhrase` reads as `db_PassPhrase`, `clientAPIkey` as `client_APIkey`).
 * The number of spellings is bounded, so reading a name stays linear.
 */
function nameSpellings(name: string): string[] {
  const boundaries = [...name.matchAll(CAMEL_BOUNDARY)].map((match) => match.index);
  const suffixSplits = boundaries.slice(-CREDENTIAL_SUFFIX_WORDS)
    .map((boundary) => `${keyWords(name.slice(0, boundary))}_${name.slice(boundary)}`);
  return [...new Set([name, keyWords(name), ...suffixSplits])];
}

/**
 * Each key-named rule's reading of one property name: the strongest shape any
 * of its spellings reads as, so splitting never loses a key the name already
 * spells (`passPhrase`, `APIkey`).
 */
function memberKeyShapes(name: string): Array<"exact" | "prefixed" | undefined> {
  const spellings = nameSpellings(name);
  return KEY_NAMED_RULES.map((rule) => {
    const shapes = spellings.map((spelling) => structuredKeyShape(rule, spelling));
    if (shapes.includes("exact")) return "exact";
    return shapes.includes("prefixed") ? "prefixed" : undefined;
  });
}

/** One payload value waiting in the member walk, with the key context it inherits. */
interface MemberStep extends PayloadStep {
  /** Credential-key context of the value's ancestors, per key-named rule. */
  contexts: readonly KeyContext[];
  /** How each key-named rule judges the value when it is a string. */
  judgments: readonly LeafJudgment[];
}

const NO_JUDGMENTS: readonly LeafJudgment[] = KEY_NAMED_RULES.map(() => undefined);

/** The child steps of an array or object, with the key context each child inherits. */
function memberChildSteps(value: object, path: string, contexts: readonly KeyContext[]): MemberStep[] {
  if (Array.isArray(value)) {
    const judgments = contexts.map(({ named, exact }): LeafJudgment => (exact ? "lenient" : named ? "compact" : undefined));
    return childSteps(value, path).map((child) => ({ ...child, contexts, judgments }));
  }
  return Object.entries(value).map(([name, entry]) => {
    const shapes = memberKeyShapes(name);
    return {
      value: entry,
      path: `${path}.${name}`,
      contexts: contexts.map(({ named, exact }, index) => ({
        named: named || shapes[index] !== undefined,
        exact: exact || shapes[index] === "exact",
      })),
      judgments: shapes.map((shape, index): LeafJudgment => {
        if (shape === "exact") return "lenient";
        return shape === "prefixed" || contexts[index]!.named ? "compact" : undefined;
      }),
    };
  });
}

/**
 * Judge credential-named payload members the way the structured pass judges
 * their JSON spelling `{"<name>": <value>}`, one string leaf at a time. In that
 * pass a quoted value is judged leniently under an exact key and compactly
 * (whitespace-free) under a prefixed key; inside a container, an array element
 * takes its key's judgment and an object member's value is always compact, and
 * every credential key above a value applies. So a leaf is judged leniently
 * when its own exact key names it, or when it is an array element under some
 * exact key; otherwise compactly when any credential key names it or an
 * ancestor. Each leaf is judged once per rule with the rule's own value judge,
 * so the pass is linear, never serializes or converts a value, and keeps its
 * own stack so payload depth is unbounded.
 */
function scanPayloadMembers(payload: unknown): SecretGuardFinding[] {
  const findings: SecretGuardFinding[] = [];
  // Revisit a shared object only under a context it has not been judged in;
  // each rule has three context states, so an object is visited a bounded
  // number of times and cycles terminate.
  const visited = new WeakMap<object, Set<string>>();
  const pending: MemberStep[] = [{ value: payload, path: "$", contexts: NO_KEY_CONTEXT, judgments: NO_JUDGMENTS }];
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    const { value, path, contexts, judgments } = step;
    if (typeof value === "string") {
      judgments.forEach((judgment, index) => {
        const rule = KEY_NAMED_RULES[index]!;
        if (judgment !== undefined && acceptsStructuredValue(rule, value, judgment === "compact")) {
          findings.push({ rule: rule.mutationRule, path });
        }
      });
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const signature = contexts.map(({ named, exact }) => (exact ? "e" : named ? "n" : "-")).join("");
    const signatures = visited.get(value) ?? new Set<string>();
    if (signatures.has(signature)) continue;
    visited.set(value, signatures.add(signature));
    pushReversed(pending, memberChildSteps(value, path, contexts));
  }
  return findings;
}

/**
 * Detect credential-shaped string leaves and credential-named members without
 * returning matched values.
 */
export function scanMutationSecrets(payload: unknown): SecretGuardFinding[] {
  const reported = new Set<string>();
  return [...scanStringLeaves(payload), ...scanPayloadMembers(payload)].filter((finding) => {
    const key = `${finding.rule}\u0000${finding.path}`;
    if (reported.has(key)) return false;
    reported.add(key);
    return true;
  });
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
