/**
 * @module sdk/context-intent-contracts
 *
 * Declares composable, intent-scoped read projections for core commands,
 * workspace configuration, and packages.
 */

/** Read commands that ship built-in intent projections. */
export type PmContextIntentCommand =
  | "context"
  | "get"
  | "list"
  | "next"
  | "search"
  | (string & {});

/** Origin of a resolved intent projection. */
export type PmContextIntentSource = "core" | "package" | "workspace";

/** One named, bounded projection of a command's context. */
export interface PmContextIntentContract {
  /** Command that accepts the intent. */
  command: PmContextIntentCommand;
  /** Stable intent identifier used by CLI, SDK, and MCP callers. */
  intent: string;
  /** Agent-facing explanation of the projection's purpose. */
  description: string;
  /** Declared output field groups retained by the projection. */
  included_field_groups: string[];
  /** Default maximum estimated tokens before normal degradation applies. */
  token_budget: number;
  /** Layer that supplied the resolved declaration. */
  source?: PmContextIntentSource;
}

/** Built-in intent projections shared by CLI, SDK, MCP, and package authors. */
export const PM_CONTEXT_INTENT_CONTRACTS: readonly PmContextIntentContract[] =
  Object.freeze([
    {
      command: "context",
      intent: "orient",
      description:
        "Bounded active hierarchy, ownership, blockers, and recent progress.",
      included_field_groups: [
        "summary",
        "focus",
        "hierarchy",
        "blockers",
        "activity",
      ],
      token_budget: 2400,
      source: "core",
    },
    {
      command: "context",
      intent: "handoff",
      description:
        "Active ownership, evidence, decisions, and immediate continuation context.",
      included_field_groups: [
        "summary",
        "focus",
        "in_progress",
        "decisions",
        "activity",
      ],
      token_budget: 2200,
      source: "core",
    },
    {
      command: "get",
      intent: "inspect",
      description:
        "Complete item metadata, relationships, evidence, and lifecycle state.",
      included_field_groups: ["item", "children", "claim_state", "linked"],
      token_budget: 3200,
      source: "core",
    },
    {
      command: "list",
      intent: "triage",
      description:
        "Compact governance, ownership, priority, and blocker fields for triage.",
      included_field_groups: [
        "identity",
        "governance",
        "ownership",
        "dependencies",
      ],
      token_budget: 1800,
      source: "core",
    },
    {
      command: "next",
      intent: "execute",
      description:
        "The highest-ranked actionable work with concise ranking evidence.",
      included_field_groups: ["recommended"],
      token_budget: 1200,
      source: "core",
    },
    {
      command: "search",
      intent: "discover",
      description:
        "Ranked canonical lineage candidates with compact match evidence.",
      included_field_groups: ["identity", "status", "lineage", "match"],
      token_budget: 1800,
      source: "core",
    },
  ]);

function normalizeContextIntentDeclaration(
  declaration: PmContextIntentContract,
  source: PmContextIntentSource,
): PmContextIntentContract {
  const command = declaration.command.trim().toLowerCase();
  const intent = declaration.intent.trim().toLowerCase();
  const key = `${command}:${intent}`;
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(command) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(intent)
  ) {
    throw new TypeError(`Invalid context intent command or name: ${key}`);
  }
  if (declaration.description.trim().length === 0) {
    throw new TypeError(
      `Context intent ${key} requires a non-empty description`,
    );
  }
  if (
    !Number.isSafeInteger(declaration.token_budget) ||
    declaration.token_budget <= 0
  ) {
    throw new TypeError(
      `Context intent ${key} requires a positive integer token_budget`,
    );
  }
  const includedFieldGroups = [
    ...new Set(
      declaration.included_field_groups
        .map((field) => field.trim())
        .filter(Boolean),
    ),
  ];
  if (includedFieldGroups.length === 0) {
    throw new TypeError(`Context intent ${key} requires included_field_groups`);
  }
  return {
    command,
    intent,
    description: declaration.description.trim(),
    included_field_groups: includedFieldGroups,
    token_budget: declaration.token_budget,
    source,
  };
}

/** Validate and compose core, package, and workspace intent declarations. Later layers override earlier layers by command and intent. */
export function composeContextIntentContracts(
  workspaceContracts: readonly PmContextIntentContract[] = [],
  packageContracts: readonly PmContextIntentContract[] = [],
): PmContextIntentContract[] {
  const layers: Array<{
    source: PmContextIntentSource;
    contracts: readonly PmContextIntentContract[];
    allowOverride: boolean;
  }> = [
    {
      source: "core",
      contracts: PM_CONTEXT_INTENT_CONTRACTS,
      allowOverride: false,
    },
    { source: "package", contracts: packageContracts, allowOverride: false },
    { source: "workspace", contracts: workspaceContracts, allowOverride: true },
  ];
  const composed = new Map<string, PmContextIntentContract>();
  const keysSeenWithinLayer = new Set<string>();
  for (const layer of layers) {
    keysSeenWithinLayer.clear();
    for (const declaration of layer.contracts) {
      const normalized = normalizeContextIntentDeclaration(
        declaration,
        layer.source,
      );
      const key = `${normalized.command}:${normalized.intent}`;
      if (keysSeenWithinLayer.has(key)) {
        throw new TypeError(`Duplicate context intent declaration: ${key}`);
      }
      keysSeenWithinLayer.add(key);
      if (!layer.allowOverride && composed.has(key)) {
        throw new TypeError(`Duplicate context intent declaration: ${key}`);
      }
      composed.set(key, normalized);
    }
  }
  return [...composed.values()].sort(
    (left, right) =>
      left.command.localeCompare(right.command) ||
      left.intent.localeCompare(right.intent),
  );
}

/** Resolve one intent declaration or fail with the nearest command-local intent. */
export function resolveContextIntentContract(
  command: string,
  intent: string,
  contracts: readonly PmContextIntentContract[] = PM_CONTEXT_INTENT_CONTRACTS,
): PmContextIntentContract | undefined {
  const normalizedCommand = command.trim().toLowerCase();
  const normalizedIntent = intent.trim().toLowerCase();
  const exact = contracts.find(
    (entry) =>
      entry.command === normalizedCommand && entry.intent === normalizedIntent,
  );
  if (exact) return exact;
  const candidates = contracts
    .filter((entry) => entry.command === normalizedCommand)
    .map((entry) => entry.intent);
  if (candidates.length === 0) return undefined;
  const suggestion = candidates
    .map((candidate) => {
      const rows = Array.from(
        { length: normalizedIntent.length + 1 },
        (_, index) => index,
      );
      for (
        let candidateIndex = 1;
        candidateIndex <= candidate.length;
        candidateIndex += 1
      ) {
        let previous = rows[0]!;
        rows[0] = candidateIndex;
        for (
          let intentIndex = 1;
          intentIndex <= normalizedIntent.length;
          intentIndex += 1
        ) {
          const prior = rows[intentIndex]!;
          rows[intentIndex] = Math.min(
            rows[intentIndex]! + 1,
            rows[intentIndex - 1]! + 1,
            previous +
              (candidate[candidateIndex - 1] ===
              normalizedIntent[intentIndex - 1]
                ? 0
                : 1),
          );
          previous = prior;
        }
      }
      return { candidate, distance: rows[normalizedIntent.length]! };
    })
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.candidate.localeCompare(right.candidate),
    )[0]!.candidate;
  throw new TypeError(
    `Unknown context intent "${normalizedIntent}" for ${normalizedCommand}. Did you mean "${suggestion}"?`,
  );
}

type BuiltInContextIntentCommand =
  | "context"
  | "get"
  | "list"
  | "next"
  | "search";

const CONTEXT_INTENT_DEFAULT_APPLIERS: Readonly<
  Record<
    BuiltInContextIntentCommand,
    (
      projected: Record<string, unknown>,
      contract: PmContextIntentContract,
    ) => void
  >
> = {
  context: (projected, contract) => {
    if (projected.section === undefined) {
      projected.section = [...contract.included_field_groups];
    }
  },
  get: (projected) => {
    if (projected.depth === undefined && projected.fields === undefined) {
      projected.depth = "deep";
    }
  },
  list: (projected) => {
    if (
      projected.brief === undefined &&
      projected.compact === undefined &&
      projected.full === undefined &&
      projected.fields === undefined
    ) {
      projected.fields =
        "id,title,status,type,priority,parent,assignee,reviewer,risk,confidence,sprint,release,blocked_by,blocked_reason,dependencies,updated_at";
    }
  },
  next: (projected) => {
    if (projected.readyOnly === undefined) projected.readyOnly = true;
  },
  search: (projected) => {
    if (
      projected.compact === undefined &&
      projected.full === undefined &&
      projected.fields === undefined
    ) {
      projected.compact = true;
    }
  },
};

/** Apply one declared read intent's defaults while preserving explicit caller options. */
export function applyContextIntentProjection(
  command: "context" | "get" | "list" | "next" | "search",
  options: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof options.for !== "string") return options;
  const contract = resolveContextIntentContract(command, options.for)!;
  const projected = { ...options };
  if (projected.tokenBudget === undefined) {
    projected.tokenBudget = String(contract.token_budget);
  }
  CONTEXT_INTENT_DEFAULT_APPLIERS[command](projected, contract);
  return projected;
}
