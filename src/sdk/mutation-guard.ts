/**
 * @module sdk/mutation-guard
 *
 * Provides SDK-first pre-write provenance and secret-detection guardrails for
 * CLI, MCP, and package-owned mutation dispatchers.
 */
import { SECRET_RULES, acceptsStructuredValue, findSecretRuleMatches, structuredKeyShape, type SecretNormalizationKind, type SecretRule, type SecretRuleCategory, type SecretRuleMatch } from "../core/shared/secret-rules.js";
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

/**
 * Stable identifier of one secret-guard detector. The union gains a member
 * whenever a detector is added, so decide findings through
 * {@link SecretGuardPolicy} instead of an exhaustive record over it.
 */
export type SecretGuardRule = SecretGuardFinding["rule"];

/**
 * Stable family of a detector: `credential` for secrets that grant access,
 * `network` for private infrastructure addresses and `path` for local paths
 * that reveal an account. A new detector joins an existing category, and a new
 * category is a declared SDK contract change (pm-gh1749).
 */
export type SecretGuardRuleCategory = SecretRuleCategory;

/** One redacted credential-shaped match. Secret values are never returned. */
export interface SecretGuardFinding {
  /** Stable detector identifier suitable for tests and telemetry; see {@link SecretGuardRule}. */
  rule: (typeof SECRET_RULES)[number]["mutationRule"];
  /**
   * Object path or argument index containing the match. A property name that a
   * rule matches is never repeated in a path: its segment is the positional
   * placeholder `[key <n>]`, its index among the object's own entries
   * (pm-x07qz2). Other property names appear as written, including a name
   * that merely equals a value another rule flags.
   */
  path: string;
  /** The match is in the property name at `path`, not in the value it holds. */
  property_name?: true;
  /** Detection-only transformations, without original or decoded coordinate values. */
  normalizations?: SecretNormalizationKind[];
  /**
   * The value could not be inspected completely and requires explicit review:
   * remaining encoded input exceeded the finite inspection envelope, or the
   * value was too large for the rule's pattern to judge.
   */
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
   * Arbitrary mutation payload. String leaves and property names are
   * inspected on their own, and a leaf under a property whose name ends with a
   * credential key is also judged as that key's value, as in its JSON spelling
   * `{"<name>": <value>}`.
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
/** Array indices stop below 2^32 - 1; a larger numeric key is an ordinary property. */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/** Whether an own property name of an array is one of its elements. */
function isArrayIndex(key: string): boolean {
  return ARRAY_INDEX.test(key) && Number(key) <= MAX_ARRAY_INDEX;
}

/** One rule that matches a string, with its inspection provenance. */
interface RuleMatch {
  /** The matching rule. */
  readonly rule: (typeof SECRET_RULES)[number];
  /** The first match, carrying any normalization provenance. */
  readonly match: SecretRuleMatch;
}

/** One own entry of an array or object, read once per scan. */
interface PayloadEntry {
  /** Property name, or the array index as a string. */
  readonly name: string;
  /** Entry value. */
  readonly value: unknown;
  /**
   * Path segment: `[<index>]` for an array element, `.<name>` for a property,
   * and the positional placeholder `[key <n>]` for a property name that a rule
   * matches, so a finding path never repeats credential text (pm-x07qz2).
   */
  readonly segment: string;
  /** Rules that match the property name itself; always empty for an array element. */
  readonly nameMatches: readonly RuleMatch[];
}

/** Per-scan state shared by both passes: each object's entries, and each distinct property name's matches. */
interface ScanCache {
  readonly entries: WeakMap<object, readonly PayloadEntry[]>;
  readonly names: Map<string, readonly RuleMatch[]>;
}

/** Every rule that matches `value` on its own text, in inventory order. */
function ruleMatches(value: string): RuleMatch[] {
  const matches: RuleMatch[] = [];
  for (const rule of SECRET_RULES) {
    const match = preflightRuleMatch(rule, value);
    if (match) matches.push({ rule, match });
  }
  return matches;
}

/** A property name is judged once per scan, however many objects repeat it. */
function nameMatches(name: string, cache: ScanCache): readonly RuleMatch[] {
  let matches = cache.names.get(name);
  if (matches === undefined) {
    matches = ruleMatches(name);
    cache.names.set(name, matches);
  }
  return matches;
}

/**
 * The own entries of an array or object, in order, read once per scan, so
 * both passes judge the same values and a getter that changes or throws on a
 * later read cannot discard findings already made. An array is read through
 * its own index properties, enumerable or not (as a length-based walk or
 * JSON.stringify reads them), never through its own (possibly overridden)
 * methods, so holes are skipped and a sparse array with a huge length costs
 * only its present elements.
 */
function ownEntries(value: object, cache: ScanCache): readonly PayloadEntry[] {
  let entries = cache.entries.get(value);
  if (entries === undefined) {
    entries = Array.isArray(value)
      ? Object.getOwnPropertyNames(value).filter(isArrayIndex)
        .map((name) => ({ name, value: (value as unknown[])[Number(name)], segment: `[${name}]`, nameMatches: [] }))
      : Object.entries(value).map(([name, entry], position) => {
        const matches = nameMatches(name, cache);
        return { name, value: entry, segment: matches.length > 0 ? `[key ${position}]` : `.${name}`, nameMatches: matches };
      });
    cache.entries.set(value, entries);
  }
  return entries;
}

/** A finding for `match`, at `path`, keeping its inspection provenance. */
function findingFor({ rule, match }: RuleMatch, path: string, propertyName: boolean): SecretGuardFinding {
  const finding: SecretGuardFinding = { rule: rule.mutationRule, path };
  if (propertyName) finding.property_name = true;
  if (match.normalizations) finding.normalizations = match.normalizations;
  if (match.normalization_incomplete) finding.normalization_incomplete = true;
  return finding;
}

/** Push in reverse, one at a time, so the first child is walked first and a wide object never spreads into one call. */
function pushReversed<T>(pending: T[], children: readonly T[]): void {
  for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
}

/** Keep credential matching lazy while preserving incomplete inspection anywhere in a home-path leaf. */
function preflightRuleMatch(rule: SecretRule, value: string): SecretRuleMatch | undefined {
  try {
    return firstRuleMatch(rule, value);
  } catch (error) {
    return judgeTooLarge(error);
  }
}

/**
 * A rule whose pattern exhausts the regex stack on a value (a value of
 * millions of characters) cannot judge it. That value is reported for review
 * under the rule, so one oversized leaf fails closed for itself instead of the
 * error making the whole scan fail open. Any other error still propagates.
 */
function judgeTooLarge(error: unknown): SecretRuleMatch {
  if (!(error instanceof RangeError)) throw error;
  return { index: 0, normalization_incomplete: true };
}

/** The first match of a rule, keeping incomplete inspection anywhere in a home-path leaf. */
function firstRuleMatch(rule: SecretRule, value: string): SecretRuleMatch | undefined {
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

/**
 * Judge every string leaf and every property name by every rule on its own
 * text, depth first, visiting each object only once; a property name is
 * judged where its object is entered, before the values under it. The walk
 * keeps its own stack, so payload depth is never limited by the call stack
 * (pm-wq9njf) and a deep payload cannot make the scan fail open.
 */
function scanStringLeaves(payload: unknown, cache: ScanCache): SecretGuardFinding[] {
  const findings: SecretGuardFinding[] = [];
  const seen = new WeakSet<object>();
  const pending: PayloadStep[] = [{ value: payload, path: "$" }];
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    const { value, path } = step;
    if (typeof value === "string") {
      for (const match of ruleMatches(value)) findings.push(findingFor(match, path, false));
    } else if (typeof value === "object" && value !== null && !seen.has(value)) {
      seen.add(value);
      const entries = ownEntries(value, cache);
      for (const entry of entries) {
        for (const match of entry.nameMatches) findings.push(findingFor(match, `${path}${entry.segment}`, true));
      }
      pushReversed(pending, entries.map((entry) => ({ value: entry.value, path: `${path}${entry.segment}` })));
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
function memberChildSteps(value: object, path: string, contexts: readonly KeyContext[], cache: ScanCache): MemberStep[] {
  const entries = ownEntries(value, cache);
  if (Array.isArray(value)) {
    const judgments = contexts.map(({ named, exact }): LeafJudgment => (exact ? "lenient" : named ? "compact" : undefined));
    return entries.map((entry) => ({ value: entry.value, path: `${path}${entry.segment}`, contexts, judgments }));
  }
  return entries.map(({ name, value: entry, segment }) => {
    const shapes = memberKeyShapes(name);
    return {
      value: entry,
      path: `${path}${segment}`,
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
function scanPayloadMembers(payload: unknown, cache: ScanCache): SecretGuardFinding[] {
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
        if (judgment === undefined) return;
        let accepted: boolean;
        try {
          accepted = acceptsStructuredValue(rule, value, judgment === "compact");
        } catch (error) {
          judgeTooLarge(error);
          findings.push({ rule: rule.mutationRule, path, normalization_incomplete: true });
          return;
        }
        if (accepted) findings.push({ rule: rule.mutationRule, path });
      });
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const signature = contexts.map(({ named, exact }) => (exact ? "e" : named ? "n" : "-")).join("");
    const signatures = visited.get(value) ?? new Set<string>();
    if (signatures.has(signature)) continue;
    visited.set(value, signatures.add(signature));
    pushReversed(pending, memberChildSteps(value, path, contexts, cache));
  }
  return findings;
}

/**
 * Detect credential-shaped string leaves, property names and credential-named
 * members without returning matched values: a flagged property name appears
 * in a path only as its positional placeholder.
 */
export function scanMutationSecrets(payload: unknown): SecretGuardFinding[] {
  const reported = new Set<string>();
  const cache: ScanCache = { entries: new WeakMap(), names: new Map() };
  return [...scanStringLeaves(payload, cache), ...scanPayloadMembers(payload, cache)].filter((finding) => {
    const key = `${finding.rule}\u0000${finding.path}\u0000${finding.property_name === true}`;
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

/**
 * Category of every detector this SDK ships, keyed by rule (pm-gh1749). Read
 * it to group or label findings; to decide them, prefer
 * {@link decideSecretGuardFinding}, which also handles a rule this SDK does
 * not know yet.
 */
export const SECRET_GUARD_RULE_CATEGORIES: Readonly<Record<SecretGuardRule, SecretGuardRuleCategory>> =
  Object.freeze(
    Object.fromEntries(SECRET_RULES.map((rule) => [rule.mutationRule, rule.category])) as Record<
      SecretGuardRule,
      SecretGuardRuleCategory
    >,
  );

/**
 * Return the category of a detector, or `undefined` for a rule this SDK does
 * not ship, such as one reported by a newer host.
 */
export function secretGuardRuleCategory(rule: string): SecretGuardRuleCategory | undefined {
  return Object.hasOwn(SECRET_GUARD_RULE_CATEGORIES, rule)
    ? SECRET_GUARD_RULE_CATEGORIES[rule as SecretGuardRule]
    : undefined;
}

/**
 * One decision for every secret-guard finding, so adding a detector never
 * breaks a typed consumer (pm-gh1749). The most specific entry wins: a
 * decision under `rules`, then one under `categories` for the rule's
 * category, then `default`. A rule added later, or one this SDK does not know,
 * takes its category's decision or the default. An entry whose value is
 * `undefined` counts as absent; keys that name no rule or category are
 * ignored, so a policy written for a newer SDK still applies.
 */
export interface SecretGuardPolicy<Decision> {
  /** Decision for a finding that no category or rule entry decides; never `undefined`. */
  default: Exclude<Decision, undefined>;
  /** Decisions for whole detector families. */
  categories?: Partial<Record<SecretGuardRuleCategory, Decision>>;
  /** Decisions for single detectors; they override their category's decision. */
  rules?: Partial<Record<SecretGuardRule, Decision>>;
}

function ownPolicyEntry<Decision>(
  entries: Partial<Record<string, Decision>> | undefined,
  key: string | undefined,
): Decision | undefined {
  return entries !== undefined && key !== undefined && Object.hasOwn(entries, key) ? entries[key] : undefined;
}

/** Read an own `categories` or `rules` map of a policy, refusing one that is not an object. */
function ownPolicyEntries<Decision>(policy: object, field: "categories" | "rules"): Partial<Record<string, Decision>> | undefined {
  const entries: unknown = Object.hasOwn(policy, field) ? (policy as Record<string, unknown>)[field] : undefined;
  if (entries !== undefined && (typeof entries !== "object" || entries === null || Array.isArray(entries))) {
    throw new TypeError(`Secret guard policy ${field} must be an object keyed by ${field === "rules" ? "rule" : "category"}.`);
  }
  return entries as Partial<Record<string, Decision>> | undefined;
}

/**
 * Decide one finding under a {@link SecretGuardPolicy}. The finding needs only
 * its `rule`, so a finding decoded from JSON is accepted as well. Only the
 * policy's own `default`, `categories` and `rules` are read, never inherited
 * ones.
 *
 * @throws {TypeError} When the policy is not an object, has no `default`
 * decision, or holds `categories` or `rules` that are not objects, or when the
 * finding has no string `rule`.
 */
export function decideSecretGuardFinding<Decision>(
  policy: SecretGuardPolicy<Decision>,
  finding: { readonly rule: string },
): Decision {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new TypeError("Secret guard policy must be an object with a default decision.");
  }
  if (!Object.hasOwn(policy, "default") || policy.default === undefined) {
    throw new TypeError("Secret guard policy requires a default decision.");
  }
  const categories = ownPolicyEntries<Decision>(policy, "categories");
  const rules = ownPolicyEntries<Decision>(policy, "rules");
  if (typeof finding !== "object" || finding === null || typeof finding.rule !== "string") {
    throw new TypeError("Secret guard finding must have a string rule.");
  }
  const ruleDecision = ownPolicyEntry(rules, finding.rule);
  if (ruleDecision !== undefined) return ruleDecision;
  const categoryDecision = ownPolicyEntry(categories, secretGuardRuleCategory(finding.rule));
  return categoryDecision === undefined ? policy.default : categoryDecision;
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
