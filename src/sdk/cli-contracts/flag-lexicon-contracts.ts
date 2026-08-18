/**
 * @module sdk/flag-lexicon-contracts
 *
 * Compiles command flags into a canonical concept lexicon with enforceable
 * per-command growth budgets.
 */
import {
  hasSubcommandFlagContractsForCommand,
  resolveSubcommandFlagContractsForCommand,
} from "./flag-contracts.js";
import {
  PM_COMMAND_CAPABILITY_CONTRACTS,
  type PmCommandCapabilityFamily,
} from "../agent-capability-contracts.js";
import { enrichCliFlagInvocationContracts } from "../flag-invocation-contracts.js";

/** Stable value kinds used by the public flag lexicon. */
export type PmFlagValueKind = "boolean" | "string" | "number" | "list";

/** One canonical command-flag concept and every accepted compatibility alias. */
export interface PmFlagLexiconEntry {
  /** Canonical command path. */
  command: string;
  /** Command capability family. */
  family: PmCommandCapabilityFamily;
  /** Stable semantic concept identifier. */
  concept: string;
  /** Canonical long spelling emitted by generated surfaces. */
  flag: string;
  /** Accepted compatibility spellings that must never become canonical rows. */
  aliases: readonly string[];
  /** Parsed value shape. */
  value_kind: PmFlagValueKind;
}

/** Ratcheted canonical flag budget for one command. */
export interface PmCommandFlagBudget {
  /** Canonical command path. */
  command: string;
  /** Current canonical flag count. */
  current: number;
  /** Maximum count accepted by the repository gate. */
  maximum: number;
}

/** One fail-closed lexicon or budget violation. */
export interface PmFlagLexiconFinding {
  /** Stable finding code. */
  code:
    | "alias_collision"
    | "budget_exceeded"
    | "duplicate_canonical_flag"
    | "inconsistent_concept_kind"
    | "missing_budget"
    | "stale_budget";
  /** Canonical command path. */
  command: string;
  /** Human-readable finding detail. */
  detail: string;
}

/** Complete verification receipt for a flag lexicon corpus. */
export interface PmFlagLexiconReport {
  /** Whether every invariant and ratchet passed. */
  ok: boolean;
  /** Number of canonical command-flag rows checked. */
  entry_count: number;
  /** Number of command budgets checked. */
  budget_count: number;
  /** Stable ordered findings. */
  findings: readonly PmFlagLexiconFinding[];
}

/** Build the canonical lexicon lazily from the same contracts as CLI and MCP. */
export function listPmFlagLexicon(): readonly PmFlagLexiconEntry[] {
  const commandContracts = PM_COMMAND_CAPABILITY_CONTRACTS.filter(
    ({ command }) => hasSubcommandFlagContractsForCommand(command),
  );
  const provisionalEntries = commandContracts.flatMap(({ command, family }) =>
    enrichCliFlagInvocationContracts(
      command,
      resolveSubcommandFlagContractsForCommand(command),
    ).map((contract) => ({
      command,
      family,
      concept: contract.flag.slice(2),
      flag: contract.flag,
      aliases: Object.freeze([...(contract.aliases ?? [])]),
      value_kind: (contract.repeatable
        ? "list"
        : contract.value_type) as PmFlagValueKind,
    })),
  );
  const compatibilityAliasFlags = new Set(
    provisionalEntries.flatMap((entry) =>
      entry.aliases.map((alias) => `${entry.command}:${alias}`),
    ),
  );
  const canonicalEntries = provisionalEntries.filter(
    (entry) => !compatibilityAliasFlags.has(`${entry.command}:${entry.flag}`),
  );
  const kindsByConcept = new Map<string, Set<PmFlagValueKind>>();
  for (const entry of canonicalEntries) {
    const kinds =
      kindsByConcept.get(entry.concept) ?? new Set<PmFlagValueKind>();
    kinds.add(entry.value_kind);
    kindsByConcept.set(entry.concept, kinds);
  }
  return Object.freeze(
    canonicalEntries.map((entry) =>
      Object.freeze({
        ...entry,
        concept:
          kindsByConcept.get(entry.concept)?.size === 1
            ? entry.concept
            : `${entry.concept}@${entry.command}`,
      }),
    ),
  );
}

const PM_COMMAND_FLAG_BUDGET_MAXIMUMS = Object.freeze({
  init: 30,
  config: 35,
  extension: 53,
  package: 54,
  packages: 54,
  install: 26,
  upgrade: 29,
  create: 100,
  copy: 24,
  focus: 22,
  list: 86,
  "list-all": 85,
  "list-draft": 84,
  "list-open": 84,
  "list-in-progress": 84,
  "list-blocked": 84,
  "list-closed": 84,
  "list-canceled": 84,
  aggregate: 37,
  context: 45,
  ctx: 45,
  get: 30,
  graph: 34,
  search: 78,
  duplicates: 24,
  eval: 25,
  next: 35,
  history: 35,
  events: 33,
  "history-redact": 27,
  "history-repair": 26,
  "history-compact": 30,
  "history-author-acknowledge": 28,
  merge: 24,
  schema: 40,
  profile: 22,
  activity: 35,
  restore: 23,
  update: 105,
  "update-many": 140,
  close: 31,
  "close-many": 72,
  delete: 24,
  append: 24,
  comments: 30,
  notes: 34,
  learnings: 26,
  files: 39,
  docs: 30,
  deps: 32,
  plan: 109,
  test: 48,
  "test-all": 37,
  telemetry: 21,
  stats: 29,
  health: 36,
  validate: 45,
  assurance: 30,
  gc: 22,
  workspace: 23,
  contracts: 29,
  claim: 36,
  release: 23,
  "start-task": 23,
  "pause-task": 23,
  "close-task": 24,
  meet: 33,
  event: 33,
  remind: 29,
  "test-runs-worker": 25,
} satisfies Readonly<Record<string, number>>);

/** Return persisted no-growth ratchets with current counts derived from the canonical vocabulary. */
export function listPmCommandFlagBudgets(): readonly PmCommandFlagBudget[] {
  const currentByCommand = new Map<string, number>(
    Object.keys(PM_COMMAND_FLAG_BUDGET_MAXIMUMS).map(
      (command) => [command, 0] as const,
    ),
  );
  for (const { command } of listPmFlagLexicon()) {
    currentByCommand.set(command, Number(currentByCommand.get(command)) + 1);
  }
  return Object.freeze(
    Object.entries(PM_COMMAND_FLAG_BUDGET_MAXIMUMS).map(([command, maximum]) =>
      Object.freeze({
        command,
        current: Number(currentByCommand.get(command)),
        maximum,
      }),
    ),
  );
}

/** Append collisions between compatibility aliases and canonical spellings. */
function appendAliasCollisionFindings(
  entries: readonly PmFlagLexiconEntry[],
  canonicalOwners: ReadonlyMap<string, PmFlagLexiconEntry>,
  findings: PmFlagLexiconFinding[],
): void {
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const owner = canonicalOwners.get(`${entry.command}:${alias}`);
      if (owner === undefined || owner.flag === entry.flag) continue;
      findings.push({
        code: "alias_collision",
        command: entry.command,
        detail: `${alias} aliases ${entry.flag} but is canonical for ${owner.flag}.`,
      });
    }
  }
}

/** Append missing, stale, and exceeded command-budget findings. */
function appendBudgetFindings(
  counts: ReadonlyMap<string, number>,
  budgets: readonly PmCommandFlagBudget[],
  findings: PmFlagLexiconFinding[],
): void {
  const budgetedCommands = new Set(budgets.map(({ command }) => command));
  for (const command of counts.keys()) {
    if (budgetedCommands.has(command)) continue;
    findings.push({
      code: "missing_budget",
      command,
      detail: `${command} has canonical flags but no persisted budget.`,
    });
  }
  for (const budget of budgets) {
    const actual = counts.get(budget.command) ?? 0;
    if (actual === 0) {
      findings.push({
        code: "stale_budget",
        command: budget.command,
        detail: `${budget.command} has a persisted budget but no canonical flags.`,
      });
    }
    if (actual <= budget.maximum) continue;
    findings.push({
      code: "budget_exceeded",
      command: budget.command,
      detail: `${actual} canonical flags exceed the ratcheted maximum ${budget.maximum}.`,
    });
  }
}

/** Verify uniqueness, concept kind stability, alias safety, and flag budgets. */
export function verifyPmFlagLexicon(
  entries: readonly PmFlagLexiconEntry[] = listPmFlagLexicon(),
  budgets: readonly PmCommandFlagBudget[] = listPmCommandFlagBudgets(),
): PmFlagLexiconReport {
  const findings: PmFlagLexiconFinding[] = [];
  const canonicalOwners = new Map<string, PmFlagLexiconEntry>();
  const conceptKinds = new Map<string, PmFlagValueKind>();
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const commandFlag = `${entry.command}:${entry.flag}`;
    if (canonicalOwners.has(commandFlag)) {
      findings.push({
        code: "duplicate_canonical_flag",
        command: entry.command,
        detail: `${entry.flag} has more than one canonical row.`,
      });
    } else {
      canonicalOwners.set(commandFlag, entry);
    }
    counts.set(entry.command, (counts.get(entry.command) ?? 0) + 1);
    const priorKind = conceptKinds.get(entry.concept);
    if (priorKind !== undefined && priorKind !== entry.value_kind) {
      findings.push({
        code: "inconsistent_concept_kind",
        command: entry.command,
        detail: `${entry.concept} uses both ${priorKind} and ${entry.value_kind}.`,
      });
    } else {
      conceptKinds.set(entry.concept, entry.value_kind);
    }
  }
  appendAliasCollisionFindings(entries, canonicalOwners, findings);
  appendBudgetFindings(counts, budgets, findings);
  return {
    ok: findings.length === 0,
    entry_count: entries.length,
    budget_count: budgets.length,
    findings,
  };
}

/** Render a compact, generated family and command budget reference. Persisted budget rows are initialized to an explicit fallback so stale rows remain renderable. */
export function renderPmFlagLexiconMarkdown(): string {
  const lexicon = listPmFlagLexicon();
  const budgets = listPmCommandFlagBudgets();
  const familyByCommand = new Map<string, string>(
    budgets.map(({ command }) => [command, "unknown"] as const),
  );
  for (const { command, family } of lexicon)
    familyByCommand.set(command, family);
  const rows = budgets.map(({ command, current, maximum }) => {
    const family = familyByCommand.get(command);
    return `| \`${command}\` | ${family} | ${current} | ${maximum} |`;
  });
  return [
    "# Generated flag lexicon budgets",
    "",
    "This file is generated by `listPmFlagLexicon()`. Compatibility aliases do not consume canonical budget.",
    "",
    "| Command | Capability family | Canonical flags | Maximum |",
    "| --- | --- | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}
